/**
 * POST /api/generar-reporte
 *
 * Receives a pre-built ReportBundle from the client (assembled from the data
 * already loaded in PorHubTab) and uses Claude Haiku to generate a weekly
 * Slack-ready report for the hub coordinator.
 *
 * The client handles all data assembly + incidentes fetching. This route
 * only calls the Anthropic API (which requires a server-side key).
 */

import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase-server';
import { anthropic, MODELS } from '@/lib/anthropic';

export const runtime   = 'nodejs';
export const dynamic   = 'force-dynamic';
export const maxDuration = 60;

// ─── Types shared with the client component ───────────────────────────────────

export interface KpiSummaryEntry {
  id: string;
  name: string;
  value: number | null;
  prevValue: number | null;
  rollingMean4w: number | null;
  /** How many weeks actually went into rollingMean4w (null = unknown, from DB). */
  rollingWeeks?: number | null;
  unit: string;        // 'pct' | 'rate' | 'count' | 'currency'
  direction: string;   // 'lower_is_better' | 'higher_is_better'
}

export interface PeerEntity {
  name: string;
  value: number | null;
  flagged: boolean;
  numOrders?: number | null; // pedidos armados — context for assemblers, null if not yet computed
  // Modo Entrenamiento (session 14) — optional so every other KPI group is
  // unaffected. Set on tasa_armado (armador) entities and on all driver KPI
  // group entities; left undefined everywhere else.
  tenureBadge?: string;       // 'S3' | 'RI'
  personalTarget?: number;    // mínimo, display units — tasa_armado trainees only
  personalStretch?: number;   // esperado, display units — tasa_armado trainees only
}

export interface KpiPeerGroup {
  kpiId: string;
  kpiName: string;
  unit: string;
  direction: string;
  hubMean: number | null;
  threshold?: number; // hard threshold (pct as 0-1 fraction, rate as raw)
  entities: PeerEntity[];
}

export interface IncidenteErroneo {
  driver: string;
  fecha: string;
  notas: string;
}

export interface ReportBundle {
  hub: { id: string; display_name: string; city: string };
  week: { start: string; label: string };
  kpiSummary: KpiSummaryEntry[];
  armadoresPorKpi: KpiPeerGroup[];
  repartidoresPorKpi: KpiPeerGroup[];
  incidentesErroneas: IncidenteErroneo[];
  mnaProductos: { producto: string; amount: number; pct: number; category: string }[];
  faltantesSkus:  { producto: string; count: number; category: string }[];
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el asistente de reportes de operaciones de Calii. Conviertes datos en un mensaje de Slack para el coordinador del hub.

REGLAS ABSOLUTAS:
- Texto plano. Sin emojis. Sin markdown.
- Solo datos. Sin sugerencias, sin interpretaciones, sin opiniones.
- Omitir sección completa si no hay casos que reportar.
- No inventar datos — solo lo que viene en el bundle.

REGLA DE COMPARACIÓN CON PROMEDIO:
Cada línea de KPI en el bundle puede traer FRASE_PROMEDIO: "…".
Esa frase YA ESTÁ CALCULADA. Cópiala LITERALMENTE, palabra por palabra: el número, la unidad, "por encima"/"por debajo" y el número de semanas. Nunca la recalcules, nunca la reformules, nunca cambies "3 semanas" por "4 semanas".
El dato WoW de la misma línea compara contra la SEMANA ANTERIOR, no contra el promedio: viene sin número a propósito y jamás debe usarse para escribir la frase del promedio.
Si la línea NO trae FRASE_PROMEDIO, omitir completamente la comparación con el promedio — no escribir nada sobre el promedio para ese KPI.
Nunca escribir "sin datos de comparación" ni frases similares.

REGLA DE ETIQUETA DE SEMANA:
Los nombres en el bundle pueden traer una etiqueta entre paréntesis: (S3) = semana 3 de entrenamiento, (RI) = reingreso.
Cópiala SIEMPRE pegada al nombre, cada vez que menciones a esa persona, en CUALQUIER sección del reporte: incidentes, Tasas, FA, reparto, entregas erróneas. Nunca la omitas, nunca la expliques, nunca la traduzcas.
Un nombre que viene sin etiqueta en el bundle se escribe sin etiqueta — no inventes una.

ESTRUCTURA:

Saludo:
"Qué tal [Nombre], te paso comentarios de los puntos importantes de la semana."

--- SECCIÓN ARMADO (omitir sección completa si no hay nada que reportar) ---
Escribir la cabecera: "Armado"

Línea de KPI del hub (usar la línea "Incidentes armado" de KPIs DEL HUB):
Si trae FRASE_PROMEDIO: "Incidentes armado: X.X% — " seguido del texto de FRASE_PROMEDIO copiado literalmente.
Si NO trae FRASE_PROMEDIO: "Incidentes armado: X.X%"

Luego las dos sublistas. Omitir SOLO la sublista cuya LISTA diga "(ninguno esta semana)".
Si LISTA 1 tiene entradas, escribir esta línea exacta antes de los items:
"Armadores con % de incidente general elevado:"
Luego copiar cada item de LISTA 1 tal cual, incluyendo la etiqueta de semana si la trae.
Si un item NO trae " — tipo" después del porcentaje, déjalo así: "- Nombre: X.X%". No inventes un tipo de incidente, no rellenes con el nombre del KPI.

Si LISTA 2 tiene entradas, escribir esta línea exacta antes de los items:
"Armadores con % de incidentes particular elevado:"
Luego copiar cada item de LISTA 2 tal cual, incluyendo la etiqueta de semana si la trae (formato: "- Nombre: tipo X.X%").

Tasas: (lista ya filtrada — copiar solo los nombres que aparecen en la sección TASAS del bundle, todos son lentos)
"Tasas: Nombre (XX.X), Nombre (XX.X)"
Si el nombre trae etiqueta de semana, va antes del valor: "Tasas: Nombre (S4) (XX.X), Nombre (XX.X)"
Si el bundle dice "(ninguno por debajo del umbral esta semana)", omitir esta línea.

"Armadores en entrenamiento por debajo de su mínimo:" es un encabezado literal — viene marcado en el bundle como "ARMADORES EN ENTRENAMIENTO POR DEBAJO DE SU MÍNIMO". Si esa sección del bundle tiene entradas, escribir esa línea exacta y luego copiar cada item tal cual, con el (Sx), el mínimo y el esperado. No mezcles esta lista con la de Tasas — son personas distintas o el mismo umbral no aplica. Si el bloque del bundle dice "(ninguno esta semana)", omite el encabezado por completo.

FA: (SOLO armadores marcados ⚠️ en faltantes_armador_pct — el bundle ya aplicó el umbral configurado o, si no hay ninguno, 2× el promedio del hub)
"FA"
Luego un bullet por armador (la etiqueta de semana, si la trae, va antes del paréntesis del valor):
"- Nombre (X.X%, Xx el promedio)"
"- Nombre (S4) (X.X%, Xx el promedio)"

--- FIN SECCIÓN ARMADO ---

--- SECCIÓN REPARTO (omitir sección completa si no hay nada que reportar) ---
Escribir la cabecera: "Reparto"

Reparto tardío (repartidores marcados FLAGGEADO en pct_tardias_reparto — el bundle ya aplicó el umbral configurado o, si no hay ninguno, 2× promedio):
"Reparto tardío"
"- Nombre: X.X% (promedio: Y.Y%)"

Entregas fallidas (repartidores marcados FLAGGEADO en pct_undelivered — mismo criterio):
"Entregas fallidas"
"- Nombre: X.X% (promedio: Y.Y%)"

Entregas erróneas (si las hay):
"Entregas erróneas"
Copiar cada entrada exactamente como viene en el bundle, sin resumir ni parafrasear la nota:
"- Nombre — fecha — [nota exacta del archivo]"

--- FIN SECCIÓN REPARTO ---

MNA: (omitir si no hay datos)
Escribir la cabecera: "MNA"
Si la línea de MNA trae FRASE_PROMEDIO: "MNA: X.X% — " seguido del texto de FRASE_PROMEDIO copiado literalmente.
Si NO trae FRASE_PROMEDIO: "MNA: X.X%"
Segunda línea: una oración describiendo el movimiento WoW por categoría usando mna_fyv_pct, mna_carnes_pct, mna_graneles_pct del kpiSummary. Solo indicar cuál subió, cuál bajó, cuál se mantuvo. Sin mencionar productos ni valores numéricos en esta oración.
Ejemplo: "El porcentaje de MNA se mantuvo estable en Graneles, bajó en Carnes, sin embargo FyV vio un incremento."
Luego la lista:
- Producto — $X,XXX (X.X%) [categoría]

Faltantes armador: (omitir si no hay datos)
Escribir la cabecera: "Faltantes armador"
Si la línea de Faltantes armador trae FRASE_PROMEDIO: "Faltantes armador: X.X% — " seguido del texto de FRASE_PROMEDIO copiado literalmente.
Si NO trae FRASE_PROMEDIO: "Faltantes armador: X.X%"
Segunda línea: una oración describiendo el movimiento WoW por categoría usando faltantes_fyv_pct, faltantes_carnes_pct, faltantes_graneles_pct del kpiSummary. Solo indicar cuál subió, cuál bajó, cuál se mantuvo. Sin mencionar SKUs ni valores en esta oración.
Ejemplo: "Los faltantes en abarrotes y carnes disminuyeron, sin embargo FyV vio un incremento considerable."
Luego la lista:
- Producto — X eventos [categoría]

VOCABULARIO:
- repartidores (no "drivers"), faltante (no "shortfall"), armador, hub, FA, MNA, FyV, Graneles, Carnes
- NUNCA escribas "manual" ni "manuales". Ese KPI se llama "Incidentes armado" a nivel hub y "% de incidente general" a nivel armador. "manuales" no es un tipo de incidente y no existe en este reporte.
- Para múltiplos: "3.1x el promedio" (no "×")
- Output: solo el mensaje, sin texto antes ni después.`;

// ─── Bundle → human-readable text for the prompt ─────────────────────────────

function fmtVal(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (unit === 'pct')      return `${(value * 100).toFixed(1)}%`;
  if (unit === 'currency') return `$${value.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  if (unit === 'rate')     return `${value.toFixed(1)} SKUs/hr`;
  return value.toFixed(0);
}

/** Bare number for ramp mínimo/esperado — e.g. "65", not "65.0 SKUs/hr". */
function fmtBare(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Size of a gap, no sign — the "por encima/debajo" wording carries direction. */
function fmtMagnitude(diff: number, unit: string): string {
  const d = Math.abs(diff);
  if (unit === 'pct')      return `${(d * 100).toFixed(1)}pp`;
  if (unit === 'currency') return `$${d.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  if (unit === 'rate')     return `${d.toFixed(1)} SKUs/hr`;
  return d.toFixed(0);
}

function buildTextBundle(b: ReportBundle): string {
  const lines: string[] = [];

  lines.push(`HUB: ${b.hub.display_name} | Ciudad: ${b.hub.city} | Semana: ${b.week.label}`);
  lines.push('');

  // ── KPI summary ──────────────────────────────────────────────────────────
  // Each line pre-computes two things Claude must not derive itself:
  //
  //   WoW — DIRECTION ONLY (SUBIÓ / BAJÓ / SE MANTUVO), deliberately without a
  //   figure. It used to print a signed "+1.2pp" immediately before the
  //   rolling-mean diff, which was also a signed "+Xpp"; Haiku regularly copied
  //   the WoW number into the "vs promedio de las últimas 4 semanas" sentence,
  //   so the report claimed a 4-week comparison while showing a 1-week delta.
  //   The only thing the prompt needs WoW for is the MNA / faltantes
  //   "subió / bajó / se mantuvo" sentence, which needs no number at all.
  //
  //   FRASE_PROMEDIO — the finished comparison sentence, copied verbatim into
  //   the report. Built from rollingWeeks so it never claims "4 semanas" for a
  //   mean assembled from fewer weeks of history.
  lines.push('=== KPIs DEL HUB ===');
  for (const k of b.kpiSummary) {
    const v    = fmtVal(k.value, k.unit);
    const prev = fmtVal(k.prevValue, k.unit);

    let wowLabel = '';
    if (k.value !== null && k.prevValue !== null && Number.isFinite(k.value) && Number.isFinite(k.prevValue)) {
      const move = k.value > k.prevValue ? 'SUBIÓ' : k.value < k.prevValue ? 'BAJÓ' : 'SE MANTUVO';
      wowLabel = `  WoW: ${move} vs semana anterior (sólo dirección — nunca usar para la frase del promedio)`;
    }

    let rollingLabel = '';
    if (k.value !== null && k.rollingMean4w !== null && Number.isFinite(k.value) && Number.isFinite(k.rollingMean4w)) {
      const diff  = k.value - k.rollingMean4w;
      const above = diff > 0;
      const worseThanAvg = k.direction === 'lower_is_better' ? above : !above;
      const n = k.rollingWeeks ?? 4;
      const baseline = n === 1
        ? 'del valor de la semana anterior'
        : `del promedio de las últimas ${n} semanas`;
      const frase = `${fmtMagnitude(diff, k.unit)} por ${above ? 'encima' : 'debajo'} ${baseline}`;
      rollingLabel =
        `  promedio_${n}sem: ${fmtVal(k.rollingMean4w, k.unit)}` +
        `  FRASE_PROMEDIO: "${frase}"` +
        `${worseThanAvg ? ' (PEOR que promedio)' : ' (MEJOR que promedio)'}`;
    }

    lines.push(`${k.name}: ${v}  prev: ${prev}${wowLabel}${rollingLabel}`);
  }
  lines.push('');

  // ── Assembler data — pre-resolved into two lists so Claude writes them directly ──
  //
  // LIST 1: assemblers flagged on the incidentes total (its configured target,
  //   6% by default)
  //   Format: "Nombre (S3): X.X% — tipo" where tipo = sub-metrics also flagged.
  //   A person over the total but under every sub-metric threshold has NO tipo
  //   — the line ends at the percentage, and the prompt forbids inventing one.
  //
  // LIST 2: every assembler flagged on at least one sub-metric, independent of
  //   List 1 (someone can legitimately appear in both)
  //   Format: "Nombre (S3): tipo X.X%" for each flagged sub-metric
  //
  // Sub-metric KPI name → short label used in the report
  const SUB_LABELS: Record<string, string> = {
    incidentes_calidad_pct:             'calidades',
    incidentes_faltantes_pct:           'faltantes',
    incidentes_faltantes_parciales_pct: 'faltantes parciales',
    incidentes_faltantes_completos_pct: 'faltantes completos',
  };
  const SUB_IDS = new Set(Object.keys(SUB_LABELS));

  const totalGroup = b.armadoresPorKpi.find((g) => g.kpiId === 'incidentes_manuales_pct');
  const subGroups  = b.armadoresPorKpi.filter((g) => SUB_IDS.has(g.kpiId));

  // Map name → { kpiId, label, value } for flagged sub-metric entries
  const subFlagsByName = new Map<string, { label: string; value: number | null }[]>();
  for (const g of subGroups) {
    for (const e of g.entities) {
      if (!e.flagged) continue;
      if (!subFlagsByName.has(e.name)) subFlagsByName.set(e.name, []);
      subFlagsByName.get(e.name)!.push({ label: SUB_LABELS[g.kpiId] ?? g.kpiId, value: e.value });
    }
  }

  const list1Entries = (totalGroup?.entities ?? []).filter((e) => e.flagged);

  // Tenure badge by assembler name. Every assembler KPI group carries it now
  // (GenerarReporte.tsx), so whichever group saw the person first is a valid
  // source — the badge is a property of the person and the week, not the KPI.
  const badgeByName = new Map<string, string>();
  for (const g of b.armadoresPorKpi) {
    for (const e of g.entities) {
      if (e.tenureBadge && !badgeByName.has(e.name)) badgeByName.set(e.name, e.tenureBadge);
    }
  }
  const badgeFor = (name: string): string => {
    const code = badgeByName.get(name);
    return code ? ` (${code})` : '';
  };

  // List 2: ALL assemblers with at least one flagged sub-metric (independent of list 1)
  const list2Names = new Set<string>();
  for (const [name] of subFlagsByName) {
    list2Names.add(name);
  }

  lines.push('=== ARMADORES — LISTAS PRE-PROCESADAS PARA EL REPORTE ===');
  lines.push('');

  const list1Threshold = totalGroup?.threshold !== undefined
    ? fmtVal(totalGroup.threshold, totalGroup.unit)
    : '6.0%';
  lines.push(`LISTA 1 — Armadores con % de incidente general elevado (total > ${list1Threshold}):`);
  if (list1Entries.length === 0) {
    lines.push('(ninguno esta semana)');
  } else {
    for (const e of list1Entries) {
      const totalPct  = fmtVal(e.value, 'pct');
      const orderCtx  = (e.numOrders != null && Number.isFinite(e.numOrders)) ? ` [${e.numOrders} pedidos]` : '';
      const tipos     = (subFlagsByName.get(e.name) ?? []).map((s) => s.label).join(', ');
      lines.push(`- ${e.name}${badgeFor(e.name)}: ${totalPct}${tipos ? ` — ${tipos}` : ''}${orderCtx}`);
    }
  }
  lines.push('');

  // Header states what the code actually builds: every assembler with a
  // flagged sub-metric, independent of LISTA 1. (The old header claimed a
  // "total ≤ 6%" filter that the loop below has never applied.)
  lines.push('LISTA 2 — Armadores con alguna sub-métrica de incidentes por encima de su umbral:');
  if (list2Names.size === 0) {
    lines.push('(ninguno esta semana)');
  } else {
    for (const name of list2Names) {
      const subs = subFlagsByName.get(name) ?? [];
      // Combine all flagged sub-metrics for this assembler onto a single line
      // e.g. "- Nombre: faltantes 9.3%, faltantes completos 7.4%"
      const subsText = subs.map((s) => `${s.label} ${fmtVal(s.value, 'pct')}`).join(', ');
      lines.push(`- ${name}${badgeFor(name)}: ${subsText}`);
    }
  }
  lines.push('');

  // ── Remaining assembler KPIs (Tasas + FA) ────────────────────────────────
  lines.push('=== OTROS KPIs ARMADORES (Tasas / FA) ===');
  for (const g of b.armadoresPorKpi) {
    if (['incidentes_manuales_pct', ...Object.keys(SUB_LABELS)].includes(g.kpiId)) continue;
    const meanFmt = fmtVal(g.hubMean, g.unit);
    let header = `[${g.kpiId}] ${g.kpiName} | Promedio hub: ${meanFmt}`;
    if (g.threshold !== undefined) {
      const tf = fmtVal(g.threshold, g.unit);
      header += g.direction === 'lower_is_better' ? `  UMBRAL: >${tf}` : `  UMBRAL: <${tf}`;
    } else if (g.hubMean !== null) {
      header += `  OUTLIER: >${fmtVal(g.hubMean * 2, g.unit)} (>2× promedio)`;
    }
    lines.push(header);
    // Pre-filter to flagged (outlier) assemblers only for tasa_armado and faltantes_armador_pct.
    // This avoids Claude listing below-average performers in the Tasas and FA sections.
    const flaggedOnlyKpis = new Set(['tasa_armado', 'faltantes_armador_pct']);
    const isTasaArmado = g.kpiId === 'tasa_armado';
    const flaggedEntities = flaggedOnlyKpis.has(g.kpiId)
      ? g.entities.filter((e) => e.flagged)
      : g.entities;
    // Modo Entrenamiento (session 14) — a trainee below their personal
    // mínimo never appears in Tasas; they get their own block below instead
    // (PLAN_MODO_ENTRENAMIENTO.md §7: never mix the two lists).
    const entitiesToShow = isTasaArmado
      ? flaggedEntities.filter((e) => e.personalTarget === undefined)
      : flaggedEntities;
    if (flaggedOnlyKpis.has(g.kpiId) && entitiesToShow.length === 0) {
      lines.push('(ninguno por encima del umbral esta semana)');
    } else {
      for (const e of entitiesToShow) {
        const val  = fmtVal(e.value, g.unit);
        const mult = (e.flagged && g.hubMean !== null && e.value !== null)
          ? ` (${(e.value / g.hubMean).toFixed(1)}× promedio)` : '';
        const orderCtx = (e.numOrders != null && Number.isFinite(e.numOrders)) ? ` [${e.numOrders} pedidos]` : '';
        const badge = e.tenureBadge ? ` (${e.tenureBadge})` : '';
        lines.push(`${e.flagged ? '  ⚠️ ' : '    '}${e.name}${badge}: ${val}${mult}${orderCtx}`);
      }
    }
    lines.push('');

    // Modo Entrenamiento — trainees below their personal mínimo, own block.
    // Never emitted for any KPI besides tasa_armado (the feature's only scope).
    if (isTasaArmado) {
      const trainees = flaggedEntities.filter((e) => e.personalTarget !== undefined);
      lines.push('ARMADORES EN ENTRENAMIENTO POR DEBAJO DE SU MÍNIMO:');
      if (trainees.length === 0) {
        lines.push('(ninguno esta semana)');
      } else {
        for (const e of trainees) {
          const val = fmtVal(e.value, g.unit);
          const minimo = fmtBare(e.personalTarget!);
          const esperado = e.personalStretch !== undefined ? ` (esperado ${fmtBare(e.personalStretch)})` : '';
          lines.push(`- ${e.name} (${e.tenureBadge}): ${val} — mínimo ${e.tenureBadge}: ${minimo}${esperado}`);
        }
      }
      lines.push('');
    }
  }

  // ── Driver data ──────────────────────────────────────────────────────────
  lines.push('=== REPARTIDORES (datos por KPI — solo mencionar si hay flaggeados) ===');
  for (const g of b.repartidoresPorKpi) {
    const meanFmt = fmtVal(g.hubMean, g.unit);
    let header = `[${g.kpiId}] ${g.kpiName} | Promedio hub: ${meanFmt}`;
    // A configured /config target (threshold) wins over the outlier default —
    // same precedence as the assembler section above.
    if (g.threshold !== undefined) {
      const tf = fmtVal(g.threshold, g.unit);
      header += g.direction === 'lower_is_better' ? `  UMBRAL: >${tf}` : `  UMBRAL: <${tf}`;
    } else if (g.hubMean !== null && (g.unit === 'pct' || g.unit === 'count')) {
      header += `  OUTLIER: >${fmtVal(g.hubMean * 2, g.unit)} (>2× promedio)`;
    }
    lines.push(header);

    for (const e of g.entities) {
      const val = fmtVal(e.value, g.unit);
      let extra = '';
      if (e.flagged && g.hubMean !== null && e.value !== null) {
        const mult = (e.value / g.hubMean).toFixed(1);
        extra = ` (${mult}× promedio)`;
      }
      const badge = e.tenureBadge ? ` (${e.tenureBadge})` : '';
      const prefix = e.flagged ? '  ⚠️ FLAGGEADO: ' : '    ';
      lines.push(`${prefix}${e.name}${badge}: ${val}${extra}`);
    }
    lines.push('');
  }

  // ── Incidentes erróneas ──────────────────────────────────────────────────
  lines.push('=== ENTREGAS ERRÓNEAS (todas las instancias esta semana) ===');
  if (b.incidentesErroneas.length === 0) {
    lines.push('(ninguna esta semana)');
  } else {
    for (const inc of b.incidentesErroneas) {
      lines.push(`• ${inc.driver} — ${inc.fecha} — "${inc.notas}"`);
    }
  }
  lines.push('');

  // ── MNA + faltantes ──────────────────────────────────────────────────────
  lines.push('=== MNA Y FALTANTES ARMADOR (para sección 5) ===');
  if (b.mnaProductos.length > 0) {
    lines.push('Top productos por MNA ($):');
    b.mnaProductos.slice(0, 6).forEach((p, i) => {
      lines.push(`  ${i + 1}. ${p.producto} — $${p.amount.toFixed(0)} (${(p.pct * 100).toFixed(1)}%) [${p.category}]`);
    });
    lines.push('');
  } else {
    lines.push('(sin datos de MNA esta semana)');
    lines.push('');
  }
  if (b.faltantesSkus.length > 0) {
    lines.push('Top SKUs con faltantes armador:');
    b.faltantesSkus.slice(0, 6).forEach((s, i) => {
      lines.push(`  ${i + 1}. ${s.producto} — ${s.count} evento${s.count !== 1 ? 's' : ''} [${s.category}]`);
    });
  } else {
    lines.push('(sin datos de faltantes armador esta semana)');
  }

  return lines.join('\n');
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  // Auth check — user must be logged in
  const userClient = createServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: ReportBundle;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!body?.hub?.id || !body?.week?.start) {
    return NextResponse.json({ error: 'missing_hub_or_week' }, { status: 400 });
  }

  try {
    const textBundle = buildTextBundle(body);

    const resp = await anthropic().messages.create({
      model:      MODELS.haiku,
      max_tokens: 2048,
      system:     SYSTEM_PROMPT,
      messages: [{
        role:    'user',
        content: `Genera el reporte semanal para el coordinador de este hub:\n\n${textBundle}`,
      }],
    });

    const text = resp.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => (b as any).text)
      .join('');

    return NextResponse.json({ ok: true, text });
  } catch (e: any) {
    console.error('[generar-reporte] error:', e);
    return NextResponse.json(
      { error: 'generation_failed', message: e.message ?? String(e) },
      { status: 500 }
    );
  }
}
