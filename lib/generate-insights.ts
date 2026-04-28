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

interface GenerateOpts {
  weekStart: string;
  mode: 'weekly_priorities' | 'focus_plan';
  focusAreas?: string[];   // for focus_plan mode: ['mna', 'faltantes', ...]
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

  // 4. Call Sonnet
  const resp = await anthropic().messages.create({
    model: MODELS.sonnet,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const cost = estimateCost(MODELS.sonnet, resp.usage.input_tokens, resp.usage.output_tokens);

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

  // 6. Replace prior insights for this (week, mode, focus_areas) and insert new
  await sb
    .from('ai_insights')
    .delete()
    .eq('week_start', opts.weekStart)
    .eq('mode', opts.mode)
    .filter('focus_areas', opts.mode === 'focus_plan' ? 'eq' : 'is', opts.mode === 'focus_plan' ? `{${(opts.focusAreas ?? []).join(',')}}` : null);

  const toInsert = parsed.map((p) => ({
    week_start: opts.weekStart,
    mode: opts.mode,
    focus_areas: opts.mode === 'focus_plan' ? (opts.focusAreas ?? null) : null,
    view: opts.mode === 'weekly_priorities' ? p.view : null,
    view_key: p.view_key ?? null,
    rank: p.rank,
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
    model_used: MODELS.sonnet,
    prompt_version: promptVersion,
    cost_usd: cost / Math.max(parsed.length, 1),  // distribute cost across insights
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

  // 12-week window of snapshots
  const since = new Date(weekStart + 'T00:00:00');
  since.setDate(since.getDate() - 7 * 12);
  const sinceIso = since.toISOString().slice(0, 10);

  const { data: snapshots } = await sb
    .from('kpi_snapshots')
    .select('*')
    .gte('week_start', sinceIso)
    .lte('week_start', weekStart)
    .order('week_start', { ascending: true });

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

  const entityOutliers = (peers ?? []).filter((p: any) =>
    typeof p.z_score === 'number' && Math.abs(p.z_score) >= 1.5
  );

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
      .limit(200);

    for (const r of rowsAlerts ?? []) {
      const alert = (r.data as any).performance_alerts;
      if (alert && typeof alert === 'string' && alert.trim() !== '') {
        const who = (r.data as any).assembler ?? (r.data as any).operator_id;
        const hub = (r.data as any).geofence;
        alertsText.push(`${who} (${hub}): ${alert}`);
      }
      const issues = (r.data as any).issues_comments;
      if (Array.isArray(issues)) {
        for (const it of issues.slice(0, 2)) {
          if (typeof it === 'string' && it.length > 5 && freeTextSamples.length < 50) {
            freeTextSamples.push({ source: 'desempeno_operadores', entity: String((r.data as any).assembler ?? ''), text: it });
          }
        }
      }
    }
  }

  // Sample faltantes notes
  const faltantesIds = (uploads ?? []).filter((u: any) => u.app_id === 'faltantes_armador').map((u: any) => u.id);
  if (faltantesIds.length > 0) {
    const { data: faltantes } = await sb
      .from('upload_rows')
      .select('data')
      .in('upload_id', faltantesIds)
      .limit(60);
    for (const r of faltantes ?? []) {
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

  const taskInstruction = isWeekly
    ? `Genera la lista de prioridades de la semana en JSON.

Devuelve un array de insights estructurado así, con 3 elementos por cada vista (general/per_hub/per_category) más adicionales bajo la sección "más para esta semana" si los datos lo soportan:
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

## Snapshots a nivel hub y global (KPIs principales, últimas 12 semanas)
${truncateJson(bundle.hubSnapshots, 12000)}

## Entidades outlier esta semana (|z| ≥ 1.5)
${truncateJson(bundle.entityOutliers, 6000)}

## Alertas automáticas de operadores
${bundle.alertsText.slice(0, 30).join('\n') || '(ninguna)'}

## Muestra de notas / comentarios
${bundle.freeTextSamples.slice(0, 25).map(f => `- [${f.source}] ${f.entity}: "${f.text}"`).join('\n') || '(ninguna)'}

## Insights top-3 de las últimas 3 semanas (para evitar repetición)
${bundle.pastInsightHeadlines.slice(0, 9).map(h => `- ${h}`).join('\n') || '(ninguno)'}

## Archivos fuente cargados esta semana
${bundle.sourceFiles.map(f => `- ${f.app_id}: ${f.file} (${f.row_count} filas)`).join('\n')}
`;

  return `${taskInstruction}\n\n${dataSection}`;
}

function truncateJson(obj: any, maxChars: number): string {
  const s = JSON.stringify(obj, null, 1);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n... [truncado, ${s.length - maxChars} chars omitidos]`;
}
