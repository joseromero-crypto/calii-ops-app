'use client';

/**
 * GenerarReporte — "Generar reporte" button + Slack report modal for PorHubTab.
 *
 * Builds a structured data bundle from the props already loaded in PorHubTab,
 * fetches incidentes erróneas notes directly from Supabase (authenticated browser
 * client), calls /api/generar-reporte to generate the text via Claude Haiku,
 * and displays the result in a modal with a one-click copy button.
 */

import { useState } from 'react';
import { createClient } from '@/lib/supabase';
import type { Kpi, Hub, Snapshot, Peer, MnaProduct, FaltantesSku, KpiTarget, RampTarget } from '@/app/(app)/historicos/_shared';
import { resolveTarget, meetsTarget, isResumenKpi, resolvePersonTarget } from '@/app/(app)/historicos/_shared';
import { effectiveDirection } from '@/lib/kpi-direction';
import { reportKpiLabel } from '@/lib/kpi-labels';
import { tenureStatus, tenureCode, type TenureRow, type TenureStatus } from '@/lib/tenure';
import { normalizeName } from '@/lib/normalize';
import type { ReportBundle, IncidenteErroneo } from '@/app/api/generar-reporte/route';

interface Props {
  hub:                     Hub;
  kpis:                    Kpi[];
  snapshots:               Snapshot[];
  peers:                   Peer[];
  mnaProducts:             MnaProduct[];
  faltantesSkuProducts:    FaltantesSku[];
  targets:                 KpiTarget[];
  ramps:                   RampTarget[];
  tenureByNameArmador:     Map<string, TenureRow>;
  tenureByNameRepartidor:  Map<string, TenureRow>;
  currentWeek:             string;
}

// ─── KPI definitions for the report ──────────────────────────────────────────

/**
 * Assembler KPIs that should appear in the "Armadores" section.
 *
 * defaultThreshold is the CODE DEFAULT — used only when /config has no
 * configured target (global or hub) for this KPI. A configured kpi_targets
 * row always wins (see resolveEffectiveTarget below). Direction is no
 * longer set per-def: it comes from lib/kpi-direction.ts's
 * effectiveDirection, the single source of truth for the tasa_armado
 * direction override (HANDOFF §12) — /config's target editor uses the same
 * helper, so a configured target's comparator always agrees with it.
 */
const ASSEMBLER_KPI_DEFS: {
  id: string;
  name: string;
  defaultThreshold?: number;   // fallback, DB-native units (pct as 0-1, rate as raw)
}[] = [
  { id: 'incidentes_manuales_pct',            name: 'Incidentes armado',   defaultThreshold: 0.06 },
  { id: 'incidentes_calidad_pct',             name: 'calidades',           defaultThreshold: 0.04 },
  { id: 'incidentes_faltantes_pct',           name: 'faltantes',           defaultThreshold: 0.04 },
  { id: 'incidentes_faltantes_parciales_pct', name: 'faltantes parciales', defaultThreshold: 0.04 },
  { id: 'incidentes_faltantes_completos_pct', name: 'faltantes completos', defaultThreshold: 0.04 },
  { id: 'tasa_armado',                        name: 'Tasas',               defaultThreshold: 90 }, // <90 = bad
  { id: 'faltantes_armador_pct',              name: 'FA' },                 // outlier >2× mean unless a target is configured
];

/** Driver KPIs that should appear in the "Repartidores" section. */
const DRIVER_KPI_DEFS: {
  id: string;
  name: string;
  showAllPositive?: boolean; // show all entities with value > 0 (no outlier logic)
  minValue?: number;         // absolute minimum to flag (regardless of outlier logic)
}[] = [
  { id: 'pct_tardias_reparto', name: 'Reparto tardío'  }, // outlier >2× mean unless a target is configured
  { id: 'pct_undelivered',    name: 'Entregas fallidas' }, // outlier >2× mean unless a target is configured
];

/**
 * Resolves the effective target for a KPI+hub as a KpiTarget object in
 * DB-native units (matching how p.value/threshold are compared everywhere
 * else in this file), falling back to the def's code-default threshold when
 * /config has no configured row. Returns null when neither exists (pure
 * outlier/2x-mean KPIs with no override set).
 */
function resolveEffectiveTarget(
  kpiId: string,
  hubId: string,
  kpi: Kpi,
  defaultThreshold: number | undefined,
  targets: KpiTarget[],
): KpiTarget | null {
  const configured = resolveTarget(kpiId, hubId, targets);
  if (configured) return configured;
  if (defaultThreshold === undefined) return null;
  const dir = effectiveDirection(kpiId, kpi.direction);
  return {
    kpi_id: kpiId,
    scope_level: 'global',
    scope_key: null,
    // defaultThreshold is DB-native (pct as 0-1); KpiTarget.target_value is
    // DISPLAY units — convert once here, same as everywhere else.
    target_value: kpi.unit === 'pct' ? defaultThreshold * 100 : defaultThreshold,
    comparator: dir === 'higher_is_better' ? 'gte' : 'lte',
    unit: kpi.unit,
    active: true,
  };
}

// ─── Incidentes detection — must stay in sync with lib/kpi-compute.ts ────────
//
// Order code: 1-2 alphanumeric chars, dash, letter+digit, dash, digit.
// Examples: AF-A3-2, WS-C1-3, J5-B8-6, 46-D6-4, U-D9-2, #JN-D7-2
//
// ⚠️ Old pattern (/\d[\w]*[-–]\w+[-–]\w+/) started with \d — silently dropped
// all codes that begin with a letter (~47% of real incidents). Fixed in session 10.
const ORDER_CODE_RE = /#?[A-Z0-9]{1,2}-[A-Z]\d-\d/i;

// Secondary delivery-error keywords — used only for non-known responsables.
const DELIVERY_RE = /entrega\s*(err[oó]nea|equivocada|incorrecta)|faltante|pedido\s*(incorrecto|equivocado|erron)|no\s+es\s+su\s+pedido/i;

// Responsables whose records are definitively entrega-errónea when an order code
// is present. Must match the set in lib/kpi-compute.ts INCIDENTES_KNOWN_RESPONSABLES.
const KNOWN_INCIDENTE_RESPONSABLES = new Set([
  'dayana.lozano@calii.com',
  'violeta@calii.com',
  'oscar.escobedo@calii.com',
  'marely@calii.com',
]);

// ─── Bundle builder ───────────────────────────────────────────────────────────

function buildBundle(
  hub:                     Hub,
  kpis:                    Kpi[],
  snapshots:               Snapshot[],
  peers:                   Peer[],
  mnaProducts:             MnaProduct[],
  faltantesSkuProducts:    FaltantesSku[],
  targets:                 KpiTarget[],
  ramps:                   RampTarget[],
  tenureByNameArmador:     Map<string, TenureRow>,
  tenureByNameRepartidor:  Map<string, TenureRow>,
  currentWeek:             string,
): Omit<ReportBundle, 'incidentesErroneas'> {
  // Week label: "vie 2 may — jue 8 may"
  const startDate = new Date(currentWeek + 'T00:00:00');
  const endDate   = new Date(currentWeek + 'T00:00:00');
  endDate.setDate(endDate.getDate() + 6);
  const fmt       = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short' });
  const weekLabel = `vie ${fmt.format(startDate)} — jue ${fmt.format(endDate)}`;

  // ── Hub-level KPI summary ─────────────────────────────────────────────────
  // Resumen operativo KPIs (volume/AOV/headcount) are excluded by default —
  // adding that context to the coordinator report is a separate, deliberate
  // change with its own prompt work (PLAN_RESUMEN_OPERATIVO.md §5).
  const kpiSummary = kpis
    .filter((kpi) => !isResumenKpi(kpi))
    .map((kpi) => {
      const snap = snapshots.find(
        (s) =>
          s.kpi_id      === kpi.id &&
          s.scope_level === 'hub'  &&
          s.scope_key   === hub.id &&
          s.week_start  === currentWeek,
      );
      if (!snap || snap.value === null) return null;

      // ── Rolling mean + the number of weeks behind it ────────────────────
      //
      // Computed client-side over the SAME window kpi-compute.ts's
      // enrichWithHistory uses (weeks with data in the 5 calendar weeks before
      // this one, at most the 4 most recent) even when the DB column is
      // populated. Two reasons: rolling_mean_4w is null for any week first
      // computed before its history existed (HANDOFF §12), and the report needs
      // `rollingWeeks` — how many weeks actually went into the mean. It used to
      // say "promedio de las últimas 4 semanas" for a mean that, early in a
      // KPI's life, was a single prior week. The DB column is the fallback when
      // no prior snapshot is loaded at all.
      const windowStart = new Date(currentWeek + 'T12:00:00');
      windowStart.setDate(windowStart.getDate() - 7 * 5);
      const windowStartIso = windowStart.toISOString().slice(0, 10);

      const priorVals = snapshots
        .filter(
          (s) =>
            s.kpi_id      === kpi.id         &&
            s.scope_level === 'hub'          &&
            s.scope_key   === hub.id         &&
            s.week_start  <  currentWeek     &&
            s.week_start  >= windowStartIso,
        )
        .sort((a, b) => (a.week_start > b.week_start ? -1 : 1)) // newest first
        .slice(0, 4)
        .map((s) => s.value)
        .filter((v): v is number => typeof v === 'number');

      const rollingMean4w: number | null =
        priorVals.length > 0
          ? priorVals.reduce((a, b) => a + b, 0) / priorVals.length
          : (snap.rolling_mean_4w ?? null);
      // null = mean came from the DB column, whose window size we can't know.
      const rollingWeeks: number | null = priorVals.length > 0 ? priorVals.length : null;

      return {
        id:            kpi.id,
        // Never the raw name_es — see lib/kpi-labels.ts for why "Incidentes
        // manuales (%)" must not reach the prompt.
        name:          reportKpiLabel(kpi.id, kpi.name_es),
        value:         snap.value,
        prevValue:     snap.prev_week_value   ?? null,
        rollingMean4w,
        rollingWeeks,
        unit:          kpi.unit,
        // Effective, not raw: the DB direction for tasa_armado may say
        // lower_is_better (HANDOFF §12), which would invert every PEOR/MEJORA
        // label the report prints for it.
        direction:     effectiveDirection(kpi.id, kpi.direction),
      };
    })
    .filter((k): k is NonNullable<typeof k> => k !== null);

  // ── Order count per assembler (context for incidentes % interpretation) ──
  // Populated by the pedidos_armados KPI (migration 20260511000001). May be
  // empty for existing data before the next kpi-compute run — that's fine,
  // entities will just have numOrders = null and Claude omits the context.
  const assemblerOrderCount = new Map<string, number | null>();
  for (const p of peers) {
    if (
      p.kpi_id      === 'pedidos_armados' &&
      p.entity_type === 'operator'        &&
      p.scope_type  === 'within_hub'      &&
      p.scope_key   === hub.id
    ) {
      assemblerOrderCount.set(p.entity_key, p.value);
    }
  }

  // ── Per-assembler data ────────────────────────────────────────────────────
  const armadoresPorKpi = ASSEMBLER_KPI_DEFS
    .map((def) => {
      const kpi = kpis.find((k) => k.id === def.id);
      if (!kpi) return null;

      const hubPeers = peers.filter(
        (p) =>
          p.kpi_id      === def.id       &&
          p.entity_type === 'operator'   &&
          p.scope_type  === 'within_hub' &&
          p.scope_key   === hub.id,
      );
      if (hubPeers.length === 0) return null;

      const hubMean = hubPeers[0].peer_mean ?? null;

      const effectiveHigherIsBetter = effectiveDirection(def.id, kpi.direction) === 'higher_is_better';

      // Configured /config target wins; falls back to def.defaultThreshold
      // (converted to a KpiTarget-shaped object so meetsTarget can be reused
      // unchanged); null when neither exists (pure outlier KPIs, e.g. FA
      // with no override set).
      const effectiveTarget = resolveEffectiveTarget(def.id, hub.id, kpi, def.defaultThreshold, targets);

      // Modo Entrenamiento (session 14) — tasa_armado only. A trainee flags
      // against their own ramp mínimo instead of the group's veteran target;
      // (RI) rides along as a badge but never changes the target (PLAN §5.2).
      const isTasaArmado = def.id === 'tasa_armado';

      const entities = hubPeers.map((p) => {
        // The badge rides along on EVERY assembler KPI group — a name printed
        // in the incidentes or FA lists needs its week label just as much as
        // one in Tasas. Only the personal ramp *target* below stays
        // tasa_armado-only (PLAN_MODO_ENTRENAMIENTO.md §5.3).
        const tenureRow = tenureByNameArmador.get(normalizeName(p.entity_key));
        const status: TenureStatus = tenureStatus(tenureRow, currentWeek);
        const tenureBadge = tenureCode(status);

        let entityTarget = effectiveTarget;
        let personalTarget: number | undefined;
        let personalStretch: number | undefined;
        if (isTasaArmado && status.kind === 'trainee') {
          const resolved = resolvePersonTarget(def.id, hub.id, status, 'armador', targets, ramps);
          if (resolved.target) {
            entityTarget = resolved.target;
            personalTarget = resolved.target.target_value;
            personalStretch = resolved.stretch ?? undefined;
          }
        }

        let flagged = false;
        if (entityTarget && p.value !== null) {
          flagged = !meetsTarget(p.value, entityTarget);
        } else if (hubMean !== null && p.value !== null) {
          // outlier: >2× hub mean (lower_is_better KPIs only)
          if (!effectiveHigherIsBetter) {
            flagged = p.value > hubMean * 2;
          }
        }
        return {
          name:      p.entity_key,
          value:     p.value,
          flagged,
          numOrders: assemblerOrderCount.get(p.entity_key) ?? null,
          tenureBadge,
          personalTarget,
          personalStretch,
        };
      });

      // Sort: flagged first, then worst → best
      entities.sort((a, b) => {
        if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
        if (a.value === null) return 1;
        if (b.value === null) return -1;
        // For higher_is_better (tasa_armado): worst = lowest value → ascending
        // For lower_is_better: worst = highest value → descending
        return effectiveHigherIsBetter
          ? a.value - b.value
          : b.value - a.value;
      });

      // threshold stays in DB-native units (pct as 0-1 fraction) — same units
      // as every other value in this bundle — so route.ts's existing
      // fmtVal()-based UMBRAL rendering keeps working unchanged. It now
      // reflects the resolved /config target instead of a hardcoded constant.
      const threshold = effectiveTarget
        ? (effectiveTarget.unit === 'pct' ? effectiveTarget.target_value / 100 : effectiveTarget.target_value)
        : undefined;

      return {
        kpiId:     def.id,
        kpiName:   def.name,
        unit:      kpi.unit,
        // Use effective direction so route.ts generates the correct UMBRAL label
        direction: effectiveHigherIsBetter ? 'higher_is_better' : 'lower_is_better',
        hubMean,
        threshold,
        entities,
      };
    })
    .filter((g): g is NonNullable<typeof g> => g !== null);

  // ── Per-driver data ───────────────────────────────────────────────────────
  const repartidoresPorKpi = DRIVER_KPI_DEFS
    .map((def) => {
      const kpi = kpis.find((k) => k.id === def.id);
      if (!kpi) return null;

      const hubPeers = peers.filter(
        (p) =>
          p.kpi_id      === def.id       &&
          p.entity_type === 'driver'     &&
          p.scope_type  === 'within_hub' &&
          p.scope_key   === hub.id,
      );
      if (hubPeers.length === 0) return null;

      const hubMean = hubPeers[0].peer_mean ?? null;

      // pct_tardias_reparto / pct_undelivered have no code-default threshold
      // (HANDOFF §13) — they're pure outlier KPIs unless /config sets a
      // fixed target, which then overrides the 2x-mean rule (spec §2.4).
      const effectiveTarget = resolveEffectiveTarget(def.id, hub.id, kpi, undefined, targets);

      // Repartidores are label-only in Modo Entrenamiento — badge rides along,
      // no ramp rows exist for this role, so targets/flagging are unchanged.
      let entities = hubPeers.map((p) => {
        let flagged = false;
        if (def.showAllPositive && p.value !== null) {
          flagged = p.value >= 1;
        } else if (effectiveTarget && p.value !== null) {
          flagged = !meetsTarget(p.value, effectiveTarget);
        } else if (hubMean !== null && p.value !== null) {
          flagged = p.value > hubMean * 2;
          // Apply absolute minimum threshold — e.g. retardos needs ≥3 to matter
          if (flagged && def.minValue !== undefined) {
            flagged = p.value >= def.minValue;
          }
        }
        const tenureRow = tenureByNameRepartidor.get(normalizeName(p.entity_key));
        const tenureBadge = tenureCode(tenureStatus(tenureRow, currentWeek));
        return { name: p.entity_key, value: p.value, flagged, tenureBadge };
      });

      // Sort: flagged first, then worst → best
      entities.sort((a, b) => {
        if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
        if (a.value === null) return 1;
        if (b.value === null) return -1;
        return b.value - a.value;
      });

      // For "show all positive" KPIs (discrepancia): only keep flagged entries
      if (def.showAllPositive) {
        entities = entities.filter((e) => e.flagged);
        if (entities.length === 0) return null;
      }

      const threshold = effectiveTarget
        ? (effectiveTarget.unit === 'pct' ? effectiveTarget.target_value / 100 : effectiveTarget.target_value)
        : undefined;

      return {
        kpiId:     def.id,
        kpiName:   def.name,
        unit:      kpi.unit,
        direction: kpi.direction,
        hubMean,
        threshold,
        entities,
      };
    })
    .filter((g): g is NonNullable<typeof g> => g !== null);

  // ── MNA products (top 8 for this hub, sorted by $ amount) ────────────────
  const mnaProductos = mnaProducts
    .filter((p) => p.hub_id === hub.id)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8)
    .map((p) => ({
      producto: p.producto,
      amount:   p.amount,
      pct:      p.pct,
      category: p.category === 'fyv' ? 'FyV' : p.category === 'carnes' ? 'Carnes' : 'Graneles',
    }));

  // ── Faltantes SKUs (top 8 for this hub, sorted by count) ─────────────────
  const faltantesSkus = faltantesSkuProducts
    .filter((s) => s.hub_id === hub.id)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((s) => ({
      producto: s.producto,
      count:    s.count,
      category: s.category === 'fyv' ? 'FyV' : s.category === 'carnes' ? 'Carnes' : 'Graneles',
    }));

  return {
    hub:     { id: hub.id, display_name: hub.display_name, city: hub.city },
    week:    { start: currentWeek, label: weekLabel },
    kpiSummary,
    armadoresPorKpi,
    repartidoresPorKpi,
    mnaProductos,
    faltantesSkus,
  };
}

// ─── Incidentes fetch (browser Supabase client) ───────────────────────────────

async function fetchIncidentesErroneas(
  currentWeek: string,
  peers:       Peer[],
  hubId:       string,
): Promise<IncidenteErroneo[]> {
  const sb = createClient();

  // Hub's drivers — any within_hub peer entry for this hub
  const hubDriverNames = new Set(
    peers
      .filter((p) => p.entity_type === 'driver' && p.scope_type === 'within_hub' && p.scope_key === hubId)
      .map((p) => p.entity_key.toLowerCase()),
  );

  if (hubDriverNames.size === 0) return [];

  // Find this week's validated incidentes uploads
  const { data: uploads } = await sb
    .from('uploads')
    .select('id')
    .eq('app_id', 'incidentes')
    .eq('week_start', currentWeek)
    .eq('status', 'validated');

  if (!uploads || uploads.length === 0) return [];

  const results: IncidenteErroneo[] = [];

  for (const upload of uploads) {
    const { data: rows } = await sb
      .from('upload_rows')
      .select('data')
      .eq('upload_id', (upload as any).id)
      .eq('is_excluded', false)
      .limit(10_000);

    for (const row of rows ?? []) {
      const d          = (row as any).data as Record<string, unknown>;
      const responsable = String(d['Responsable'] ?? '').toLowerCase();
      if (responsable === 'robertott@calii.com') continue;

      const operador = String(d['Operador'] ?? '').trim();
      if (!operador || !hubDriverNames.has(operador.toLowerCase())) continue;

      const notas = String(d['Notas'] ?? '');
      // Order code is required as the primary signal.
      if (!ORDER_CODE_RE.test(notas)) continue;
      // Known responsables: order code alone confirms the incident.
      // Other responsables (e.g. covering staff): also require delivery keywords.
      const byKnown = KNOWN_INCIDENTE_RESPONSABLES.has(responsable);
      if (!byKnown && !DELIVERY_RE.test(notas)) continue;

      // Format date.
      // IMPORTANT: coerceRows stores 'datetime' columns as full UTC ISO strings
      // via new Date(t).toISOString() — e.g. "2026-05-08T00:00:00.000Z".
      // Parsing that directly gives UTC midnight, which in Mexico City (UTC-6/-5)
      // is the evening of May 7 → toLocaleDateString shows "may 7" instead of
      // "may 8". Fix: extract only the YYYY-MM-DD portion with a regex, then
      // re-parse at local noon (T12:00:00) so the calendar date is always correct
      // regardless of timezone offset. Works for both 10-char date strings and
      // full UTC ISO strings — the regex always captures the date prefix.
      let fecha = String(d['Fecha'] ?? '');
      try {
        const raw      = fecha.trim();
        const datePart = /^(\d{4}-\d{2}-\d{2})/.exec(raw)?.[1];
        const parsed   = datePart ? new Date(datePart + 'T12:00:00') : new Date(raw);
        if (!isNaN(parsed.getTime())) {
          fecha = parsed.toLocaleDateString('es-MX', {
            weekday: 'short',
            day:     'numeric',
            month:   'short',
          });
        }
      } catch { /* keep raw string */ }

      results.push({
        driver: operador,
        fecha,
        notas:  notas.slice(0, 300), // truncate very long notes
      });
    }
  }

  return results;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GenerarReporte({
  hub,
  kpis,
  snapshots,
  peers,
  mnaProducts,
  faltantesSkuProducts,
  targets,
  ramps,
  tenureByNameArmador,
  tenureByNameRepartidor,
  currentWeek,
}: Props) {
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(false);
  const [text,    setText]    = useState<string | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [copied,  setCopied]  = useState(false);

  async function generate() {
    setLoading(true);
    setError(null);
    setText(null);
    setOpen(true);

    try {
      // 1. Build the data bundle from existing props
      const bundle: ReportBundle = {
        ...buildBundle(hub, kpis, snapshots, peers, mnaProducts, faltantesSkuProducts, targets, ramps, tenureByNameArmador, tenureByNameRepartidor, currentWeek),
        incidentesErroneas: [],
      };

      // 2. Fetch incidentes erróneas notes from Supabase (browser client)
      bundle.incidentesErroneas = await fetchIncidentesErroneas(currentWeek, peers, hub.id);

      // 3. Call server API route to generate via Claude
      const res = await fetch('/api/generar-reporte', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(bundle),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).message ?? `Error ${res.status}`);
      }

      const { text: generated } = await res.json();
      setText(generated);
    } catch (e: any) {
      setError(e.message ?? 'Error generando el reporte. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }

  async function copyText() {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={generate}
        className="shrink-0 px-3 py-1.5 text-[12px] font-medium bg-teal-500 hover:bg-teal-600 active:bg-teal-700 text-white rounded-full shadow-sm transition-colors"
      >
        Generar reporte
      </button>

      {/* Modal overlay */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          onClick={() => { if (!loading) setOpen(false); }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[var(--line)]">
              <div>
                <h3 className="font-bold text-[15px]">
                  Reporte semanal — {hub.display_name}
                </h3>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-[var(--muted)] hover:text-[var(--ink)] text-[22px] leading-none w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 transition-colors"
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {/* Loading state */}
              {loading && (
                <div className="flex flex-col items-center justify-center py-14 gap-4">
                  <div className="w-9 h-9 border-[3px] border-teal-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-[13px] text-[var(--muted)]">
                    Generando reporte con IA…
                  </p>
                </div>
              )}

              {/* Error state */}
              {!loading && error && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-[13px] text-red-700 leading-relaxed">
                  <span className="font-medium">Error:</span> {error}
                  <div className="mt-3">
                    <button
                      onClick={generate}
                      className="text-[12px] font-medium text-red-700 underline underline-offset-2"
                    >
                      Intentar de nuevo
                    </button>
                  </div>
                </div>
              )}

              {/* Result */}
              {!loading && text && (
                <textarea
                  readOnly
                  value={text}
                  rows={20}
                  className="w-full font-mono text-[12px] leading-relaxed p-4 bg-slate-50 border border-[var(--line)] rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-teal-400 focus:border-transparent"
                  onClick={(e) => (e.target as HTMLTextAreaElement).select()}
                />
              )}
            </div>

            {/* Modal footer */}
            {!loading && text && (
              <div className="px-6 py-4 border-t border-[var(--line)] flex justify-between items-center">
                <p className="text-[11px] text-[var(--muted)]">
                  Haz clic en el texto para seleccionar todo
                </p>
                <button
                  onClick={copyText}
                  className={`px-5 py-2 rounded-full text-[13px] font-semibold transition-all ${
                    copied
                      ? 'bg-emerald-500 text-white scale-95'
                      : 'bg-black hover:bg-slate-800 text-white'
                  }`}
                >
                  {copied ? '✓ Copiado' : 'Copiar para Slack'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
