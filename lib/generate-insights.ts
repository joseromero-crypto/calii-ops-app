/**
 * Weekly insights generation — Claude Sonnet.
 *
 * Reads kpi_snapshots + peer_comparisons + free-text excerpts (performance_alerts,
 * issues_comments, faltante notes, classified incident labels) for the given
 * Fri-Thu week, and produces ranked insights with evidence, recommended Ops
 * actions, and cross-team flags.
 *
 * Output shape is structured JSON so the UI can render reliably and so the
 * "evidence" portion stays anchored to actual data points (not hallucinated).
 *
 * Cost: ~$0.05-0.15 per generation (rich context bundle, well within budget).
 */

import { anthropic, MODELS, estimateCost } from './anthropic';
import { createAdminSupabase } from './supabase-server';
import { assembleSystemPrompt } from './prompts/system-context';
import {
  hydrateTenureRow, tenureStatus, tenureCode, buildTenureNameIndex,
  type PersonTenureDbRow, type TenureRow, type Role as TenureRole,
} from './tenure';
import { normalizeName } from './normalize';

/**
 * Name -> week badge ('S3' | 'RI' | undefined) for the week being generated.
 *
 * Every surface that prints a person's name owes the reader their week label:
 * an insight that names a picker without "(S3)" reads as a veteran problem
 * when it is a ramp-up one. Same ledger and hydration path the dashboard and
 * the coordinator report use — reentry_weeks is not a person_tenure column,
 * so hydrateTenureRow must run before tenureStatus (lib/tenure.ts §2.1).
 */
async function buildTenureBadgeLookup(
  sb: any,
  weekStart: string,
): Promise<(entityType: string, name: string) => string | undefined> {
  const [{ data: tenureRows }, { data: rosterUploads }] = await Promise.all([
    sb.from('person_tenure').select('*'),
    sb.from('uploads').select('app_id, week_start').eq('status', 'validated')
      .in('app_id', ['desempeno_operadores', 'desempeno_repartidores']),
  ]);

  const weeksByRole: Record<TenureRole, Set<string>> = { armador: new Set(), repartidor: new Set() };
  for (const u of (rosterUploads ?? []) as { app_id: string; week_start: string }[]) {
    if (u.app_id === 'desempeno_operadores') weeksByRole.armador.add(u.week_start);
    else weeksByRole.repartidor.add(u.week_start);
  }

  const hydrated: TenureRow[] = ((tenureRows ?? []) as PersonTenureDbRow[])
    .map((r) => hydrateTenureRow(r, weeksByRole[r.role] ?? new Set<string>()));

  const byRole: Record<TenureRole, Map<string, TenureRow>> = {
    armador:    buildTenureNameIndex(hydrated.filter((r) => r.role === 'armador')),
    repartidor: buildTenureNameIndex(hydrated.filter((r) => r.role === 'repartidor')),
  };

  return (entityType: string, name: string) => {
    const role: TenureRole | null =
      entityType === 'operator' ? 'armador' : entityType === 'driver' ? 'repartidor' : null;
    if (!role || !name) return undefined;
    return tenureCode(tenureStatus(byRole[role].get(normalizeName(name)), weekStart));
  };
}

interface GenerateOpts {
  weekStart: string;
  mode: 'weekly_priorities' | 'focus_plan';
  focusAreas?: string[];   // for focus_plan mode: ['mna', 'faltantes', ...]
  /** Scope this generation to a single view (and optional view_key). When set,
   *  the bundle is filtered to that scope and only 3 insights are produced. */
  view?: 'global' | 'per_hub' | 'per_category';
  viewKey?: string | null;     // hub_id for per_hub, category for per_category
}

export interface GenerationResult {
  inserted: number;
  cost_usd: number;
  prompt_version: number;
  warnings: string[];
}

interface GeneratedInsight {
  view: 'global' | 'per_hub' | 'per_category';
  view_key: string | null;
  rank: number;
  kpi_id: string | null;
  scope_type: 'within_hub' | 'within_city' | 'global' | null;
  scope_key: string | null;
  headline_es: string;
  evidence_md: string;
  recommended_actions_md: string;
  flag_actions_md?: string | null;
  linked_entities?: Record<string, string[]>;
  why_now_es?: string;
  source_files?: { file: string; rows: string; notes?: string }[];
}

export async function generateWeeklyInsights(opts: GenerateOpts): Promise<GenerationResult> {
  const sb = createAdminSupabase();
  const warnings: string[] = [];

  // 1. Build the system prompt (operating context + rules + scope rules + few-shot)
  const { prompt: systemPrompt, promptVersion } = await assembleSystemPrompt();

  // 2. Build the data bundle for this week
  const bundle = await buildDataBundle(sb, opts.weekStart, opts);
  if (!bundle.hasData) {
    return { inserted: 0, cost_usd: 0, prompt_version: promptVersion, warnings: ['no_data_for_week'] };
  }

  // 3. User message: instruction + data bundle
  const userMessage = buildUserMessage(bundle, opts);

  // 4. Call the model. Haiku fits within Netlify's 26s timeout; we ask for ≤3
  // insights so 3072 max_tokens is plenty (avoids the truncation issue).
  const model = MODELS.haiku;
  const resp = await anthropic().messages.create({
    model,
    max_tokens: 3072,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const cost = estimateCost(model, resp.usage.input_tokens, resp.usage.output_tokens);

  // 5. Parse insights
  const text = resp.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text).join('');

  let parsed: GeneratedInsight[];
  try {
    const cleaned = text.replace(/^```json\s*|```$/gm, '').trim();
    parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error('not an array');
  } catch (e: any) {
    return { inserted: 0, cost_usd: cost, prompt_version: promptVersion, warnings: [`parse_error: ${e.message}`, `raw_first_500: ${text.slice(0, 500)}`] };
  }

  // 6. Replace prior insights for this (week, mode, view, view_key) and insert new
  let deleteQuery = sb
    .from('ai_insights')
    .delete()
    .eq('week_start', opts.weekStart)
    .eq('mode', opts.mode);
  if (opts.mode === 'focus_plan') {
    // dummy clause; in practice focus_plan replaces by focus_areas, handled separately
  } else if (opts.view) {
    deleteQuery = deleteQuery.eq('view', opts.view);
    if (opts.viewKey) deleteQuery = deleteQuery.eq('view_key', opts.viewKey);
    else deleteQuery = deleteQuery.is('view_key', null);
  }
  await deleteQuery;

  const toInsert = parsed.map((p, i) => ({
    week_start: opts.weekStart,
    mode: opts.mode,
    focus_areas: opts.mode === 'focus_plan' ? (opts.focusAreas ?? null) : null,
    // When the caller specifies a view, force every insight to that view —
    // ignore whatever the model put in p.view (the model sometimes hallucinates).
    view: opts.mode === 'weekly_priorities' ? (opts.view ?? p.view) : null,
    view_key: opts.viewKey ?? p.view_key ?? null,
    rank: p.rank ?? (i + 1),
    kpi_id: p.kpi_id ?? null,
    scope_type: p.scope_type ?? null,
    scope_key: p.scope_key ?? null,
    headline_es: p.headline_es,
    evidence_md: p.evidence_md,
    recommended_actions_md: p.recommended_actions_md ?? null,
    flag_actions_md: p.flag_actions_md ?? null,
    linked_entities: p.linked_entities ?? null,
    why_now_es: p.why_now_es ?? null,
    source_files: p.source_files ?? null,
    model_used: model,
    prompt_version: promptVersion,
    cost_usd: cost / Math.max(parsed.length, 1),
  }));

  const { error } = await sb.from('ai_insights').insert(toInsert);
  if (error) {
    return { inserted: 0, cost_usd: cost, prompt_version: promptVersion, warnings: [`db_insert: ${error.message}`] };
  }

  return { inserted: toInsert.length, cost_usd: cost, prompt_version: promptVersion, warnings };
}

// ----------------------------------------------------------------------------
// Data bundle — what the AI sees
// ----------------------------------------------------------------------------

interface DataBundle {
  hasData: boolean;
  weekStart: string;
  watchedKpis: any[];
  hubSnapshots: any[];          // hub-level snapshots for this week + 12-week history
  entityOutliers: any[];        // entity-level peer comparisons (|z| >= 1.5)
  alertsText: string[];         // performance_alerts strings
  freeTextSamples: { source: string; entity: string; text: string }[];
  pastInsightHeadlines: string[]; // last 3 weeks' top-3 to avoid repetition
  sourceFiles: { app_id: string; week_start: string; row_count: number; file: string }[];
}

async function buildDataBundle(sb: any, weekStart: string, opts: GenerateOpts): Promise<DataBundle> {
  // Load registry
  const { data: kpis } = await sb.from('kpis').select('*').eq('active', true).order('display_order');
  const watchedKpis = (kpis ?? []).filter((k: any) => k.watched_globally);

  // Get last 4 weeks for trend context (small enough to keep prompt tight)
  const since = new Date(weekStart + 'T00:00:00');
  since.setDate(since.getDate() - 7 * 4);
  const sinceIso = since.toISOString().slice(0, 10);

  // Filter snapshots by scope:
  //   per_hub  → only this hub + global rows (for peer benchmark)
  //   per_cat  → only KPIs in this category
  //   global   → only global + hub rows for watched KPIs
  let snapshotQuery = sb
    .from('kpi_snapshots')
    .select('kpi_id, week_start, scope_level, scope_key, value, prev_week_value, rolling_mean_4w')
    .gte('week_start', sinceIso)
    .lte('week_start', weekStart)
    .in('scope_level', ['hub', 'global']);

  if (opts.view === 'per_hub' && opts.viewKey) {
    snapshotQuery = snapshotQuery.or(
      `scope_key.eq.${opts.viewKey},and(scope_level.eq.global,scope_key.is.null)`
    );
  } else if (opts.view === 'per_category' && opts.viewKey) {
    const catKpiIds = (kpis ?? [])
      .filter((k: any) => k.category === opts.viewKey)
      .map((k: any) => k.id);
    if (catKpiIds.length > 0) {
      snapshotQuery = snapshotQuery.in('kpi_id', catKpiIds);
    }
  } else if (opts.view === 'global') {
    const watchedIds = watchedKpis.map((k: any) => k.id);
    if (watchedIds.length > 0) {
      snapshotQuery = snapshotQuery.in('kpi_id', watchedIds);
    }
  }

  const { data: snapshots } = await snapshotQuery.order('week_start', { ascending: true });

  if (!snapshots || snapshots.length === 0) {
    return {
      hasData: false,
      weekStart,
      watchedKpis,
      hubSnapshots: [],
      entityOutliers: [],
      alertsText: [],
      freeTextSamples: [],
      pastInsightHeadlines: [],
      sourceFiles: [],
    };
  }

  const hubSnapshots = snapshots.filter((s: any) => s.scope_level === 'hub' || s.scope_level === 'global');

  // Entity outliers (this week, |z| >= 1.5)
  const { data: peers } = await sb
    .from('peer_comparisons')
    .select('*')
    .eq('week_start', weekStart);

  // Filter peer comparisons by scope.
  let entityOutliers = (peers ?? [])
    .filter((p: any) => typeof p.z_score === 'number' && Math.abs(p.z_score) >= 1.0);

  if (opts.view === 'per_hub' && opts.viewKey) {
    // Only entities IN this hub (their scope_key == hub_id, or they ARE this hub)
    entityOutliers = entityOutliers.filter(
      (p: any) =>
        (p.entity_type === 'hub' && p.entity_key === opts.viewKey) ||
        (p.scope_type === 'within_hub' && p.scope_key === opts.viewKey)
    );
  } else if (opts.view === 'per_category' && opts.viewKey) {
    const catKpiIds = new Set(
      (kpis ?? []).filter((k: any) => k.category === opts.viewKey).map((k: any) => k.id)
    );
    entityOutliers = entityOutliers.filter((p: any) => catKpiIds.has(p.kpi_id));
  }

  const badgeFor = await buildTenureBadgeLookup(sb, weekStart);

  entityOutliers = entityOutliers
    .sort((a: any, b: any) => Math.abs(b.z_score) - Math.abs(a.z_score))
    .slice(0, 15)
    // `tenure` rides along on the JSON the model sees, so a named picker or
    // repartidor always carries their week label into the insight.
    .map((p: any) => {
      const badge = badgeFor(p.entity_type, p.entity_key);
      return badge ? { ...p, tenure: badge } : p;
    });

  // performance_alerts text from this week's operator rows
  const { data: uploads } = await sb
    .from('uploads')
    .select('id, app_id, file_storage_path, row_count')
    .eq('week_start', weekStart)
    .eq('status', 'validated');

  const operadoresIds = (uploads ?? []).filter((u: any) => u.app_id === 'desempeno_operadores').map((u: any) => u.id);

  let alertsText: string[] = [];
  let freeTextSamples: DataBundle['freeTextSamples'] = [];
  if (operadoresIds.length > 0) {
    const { data: rowsAlerts } = await sb
      .from('upload_rows')
      .select('data')
      .in('upload_id', operadoresIds)
      .eq('is_excluded', false)
      .limit(80);                  // smaller — we only show 10 alerts in prompt anyway

    // For per_hub scope, only include rows whose geofence matches this hub.
    const hubFilter = opts.view === 'per_hub' && opts.viewKey ? opts.viewKey : null;
    for (const r of rowsAlerts ?? []) {
      if (alertsText.length >= 10 && freeTextSamples.length >= 10) break;
      const hubName = String((r.data as any).geofence ?? '').trim();
      if (hubFilter) {
        // crude match: any of the hub_id segments inside the geofence string
        const normalized = hubName.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z_]/g, '');
        if (!normalized.includes(hubFilter.replace('mh_', ''))) continue;
      }
      const alert = (r.data as any).performance_alerts;
      if (alertsText.length < 10 && alert && typeof alert === 'string' && alert.trim() !== '') {
        const who = String((r.data as any).assembler ?? (r.data as any).operator_id ?? '');
        const whoBadge = badgeFor('operator', who);
        alertsText.push(`${who}${whoBadge ? ` (${whoBadge})` : ''} (${hubName}): ${alert}`);
      }
      const issues = (r.data as any).issues_comments;
      if (Array.isArray(issues) && freeTextSamples.length < 10) {
        const it = issues[0];
        if (typeof it === 'string' && it.length > 5) {
          const who = String((r.data as any).assembler ?? '');
          const whoBadge = badgeFor('operator', who);
          freeTextSamples.push({
            source: 'desempeno_operadores',
            entity: `${who}${whoBadge ? ` (${whoBadge})` : ''}`,
            text: it,
          });
        }
      }
    }
  }

  // Sample faltantes notes — small sample, just to seed cause/intent context
  const faltantesIds = (uploads ?? []).filter((u: any) => u.app_id === 'faltantes_armador').map((u: any) => u.id);
  if (faltantesIds.length > 0 && freeTextSamples.length < 15) {
    const { data: faltantes } = await sb
      .from('upload_rows')
      .select('data')
      .in('upload_id', faltantesIds)
      .limit(20);
    for (const r of faltantes ?? []) {
      if (freeTextSamples.length >= 15) break;
      const note = (r.data as any)['Notas armador'];
      if (note && String(note).trim().length > 3) {
        freeTextSamples.push({
          source: 'faltantes_armador',
          entity: String((r.data as any)['Hub'] ?? ''),
          text: String(note),
        });
      }
    }
  }

  // Past 3 weeks' top-3 to avoid repetition
  const past3WeeksAgo = new Date(weekStart + 'T00:00:00');
  past3WeeksAgo.setDate(past3WeeksAgo.getDate() - 21);
  const past3Iso = past3WeeksAgo.toISOString().slice(0, 10);
  const { data: pastInsights } = await sb
    .from('ai_insights')
    .select('headline_es, week_start, rank')
    .gte('week_start', past3Iso)
    .lt('week_start', weekStart)
    .eq('mode', 'weekly_priorities')
    .lte('rank', 3);

  const pastInsightHeadlines = (pastInsights ?? []).map((p: any) => `${p.week_start}: ${p.headline_es}`);

  return {
    hasData: true,
    weekStart,
    watchedKpis,
    hubSnapshots,
    entityOutliers,
    alertsText,
    freeTextSamples,
    pastInsightHeadlines,
    sourceFiles: (uploads ?? []).map((u: any) => ({
      app_id: u.app_id,
      week_start: weekStart,
      row_count: u.row_count,
      file: u.file_storage_path,
    })),
  };
}

function buildUserMessage(bundle: DataBundle, opts: GenerateOpts): string {
  const isWeekly = opts.mode === 'weekly_priorities';

  // Scope-specific instruction
  const viewScope = opts.view;
  const viewKey = opts.viewKey;
  const scopeLabel =
    viewScope === 'global' ? 'GENERAL (KPIs personales que sigues tú)' :
    viewScope === 'per_hub' ? `MICRO-HUB ${viewKey}` :
    viewScope === 'per_category' ? `CATEGORÍA ${viewKey}` :
    'TODAS LAS VISTAS';

  const taskInstruction = isWeekly
    ? `Genera EXACTAMENTE 3 prioridades para el scope: ${scopeLabel}.

REGLAS DURAS:
- Sólo usa los datos abajo. Si los datos no muestran nada problemático para este scope, devuelve un array vacío [].
- Cada insight DEBE referirse al scope solicitado (ej: si es MH Contry, NO menciones Zapopan).
- Ranquea por SEVERIDAD: peor primero (#1 = lo más urgente).
- Para cada KPI, considera la dirección: lower_is_better (ej MNA, faltantes, incidentes) → valor alto = malo. higher_is_better (tasa de armado) → valor bajo = malo.
- Cada insight debe citar valores reales del bundle: número actual, peer mean, z-score si está, WoW si está.
- Evidencia y acciones máximo 150 chars cada uno. Headlines máximo 120 chars.
- No inventes hubs/operadores que no estén en los datos.
- ETIQUETA DE SEMANA: si una entidad trae el campo "tenure" (ej "S3" = semana 3 de entrenamiento, "RI" = reingreso), escribe SIEMPRE su nombre como "Nombre (S3)" — en headline_es, evidence_md, recommended_actions_md y linked_entities. Nunca omitas la etiqueta ni la expliques. Un nombre sin "tenure" se escribe sin etiqueta.

Devuelve SÓLO el array JSON, sin texto antes o después.
[
  {
    "view": "global" | "per_hub" | "per_category",
    "view_key": null para global; el hub_id para per_hub (ej "mh_contry"); el nombre de categoría para per_category,
    "rank": 1 | 2 | 3 | ...,
    "kpi_id": el KPI principal del insight (string),
    "scope_type": "within_hub" | "within_city" | "global" | null,
    "scope_key": el hub o ciudad relevante,
    "headline_es": titular auto-contenido (KPI + sujeto + magnitud + peer group con scope),
    "evidence_md": markdown con números clave, z-scores, deltas WoW, comparaciones a peers,
    "recommended_actions_md": markdown bullet list de 2-4 acciones de Operaciones esta semana,
    "flag_actions_md": markdown opcional con flags a Compras / Comercial / Tecnología,
    "linked_entities": { "operators": [...], "drivers": [...], "skus": [...], "hubs": [...] },
    "why_now_es": una línea de "por qué ahora",
    "source_files": [{ "file": "MNA_zapopan.csv", "rows": "sem 17 (4891 filas)" }]
  }
]

REGLAS:
- Sólo recomendar como Ops lo que Operaciones puede ejecutar. El resto va en flag_actions_md.
- No repetir headlines que ya fueron top-3 en las últimas 2 semanas (lista abajo) salvo escalamiento estructural.
- Cada insight DEBE citar las fuentes específicas en source_files.`
    : `Genera un plan de trabajo enfocado en: ${(opts.focusAreas ?? []).join(', ')}.

Devuelve un array de pasos JSON:
[
  {
    "view": null,
    "view_key": null,
    "rank": 1, 2, 3, ...,
    "kpi_id": el KPI principal o null si es cross-KPI,
    "scope_type": "within_hub" | "within_city" | "global",
    "scope_key": ...,
    "headline_es": acción concreta a tomar,
    "evidence_md": por qué este paso (datos),
    "recommended_actions_md": detalle de cómo ejecutarlo,
    "flag_actions_md": opcional para items cross-team,
    "linked_entities": { ... },
    "source_files": [...]
  }
]

Genera tantos pasos como los datos sustenten (típicamente 4-8 acciones de Ops + 2-4 flags).`;

  const dataSection = `# Datos esta semana (${bundle.weekStart})

## Snapshots por hub + global (esta sem y la anterior, para WoW)
${truncateJson(bundle.hubSnapshots, 4000)}

## Top outliers esta sem (|z|≥1.5, top 20)
${truncateJson(bundle.entityOutliers, 2000)}

## Alertas (top 10)
${bundle.alertsText.slice(0, 10).join('\n') || '(ninguna)'}

## Notas seleccionadas
${bundle.freeTextSamples.slice(0, 10).map(f => `- [${f.source}] ${f.entity}: "${f.text}"`).join('\n') || '(ninguna)'}

## Headlines top-3 de últimas 3 sem (no repetir)
${bundle.pastInsightHeadlines.slice(0, 6).map(h => `- ${h}`).join('\n') || '(ninguno)'}

## Archivos fuente
${bundle.sourceFiles.slice(0, 10).map(f => `- ${f.app_id}: ${f.file} (${f.row_count})`).join('\n')}
`;

  return `${taskInstruction}\n\n${dataSection}`;
}

function truncateJson(obj: any, maxChars: number): string {
  const s = JSON.stringify(obj, null, 1);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n... [truncado, ${s.length - maxChars} chars omitidos]`;
}
