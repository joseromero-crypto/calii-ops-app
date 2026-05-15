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
import type { Kpi, Hub, Snapshot, Peer, MnaProduct, FaltantesSku } from '@/app/(app)/historicos/_shared';
import type { ReportBundle, IncidenteErroneo } from '@/app/api/generar-reporte/route';

interface Props {
  hub:                  Hub;
  kpis:                 Kpi[];
  snapshots:            Snapshot[];
  peers:                Peer[];
  mnaProducts:          MnaProduct[];
  faltantesSkuProducts: FaltantesSku[];
  currentWeek:          string;
}

// ─── KPI definitions for the report ──────────────────────────────────────────

/** Assembler KPIs that should appear in the "Armadores" section. */
const ASSEMBLER_KPI_DEFS: {
  id: string;
  name: string;
  threshold?: number;     // hard threshold in stored units (pct as 0-1, rate as raw)
  higherIsBetter?: boolean; // overrides kpi.direction when the DB value is wrong
}[] = [
  { id: 'incidentes_manuales_pct',            name: 'Incidentes armado',   threshold: 0.06 },
  { id: 'incidentes_calidad_pct',             name: 'calidades',           threshold: 0.04 },
  { id: 'incidentes_faltantes_pct',           name: 'faltantes',           threshold: 0.04 },
  { id: 'incidentes_faltantes_parciales_pct', name: 'faltantes parciales', threshold: 0.04 },
  { id: 'incidentes_faltantes_completos_pct', name: 'faltantes completos', threshold: 0.04 },
  { id: 'tasa_armado',                        name: 'Tasas',               threshold: 90, higherIsBetter: true }, // <90 = bad
  { id: 'faltantes_armador_pct',              name: 'FA' },                 // outlier >2× mean
];

/** Driver KPIs that should appear in the "Repartidores" section. */
const DRIVER_KPI_DEFS: {
  id: string;
  name: string;
  showAllPositive?: boolean; // show all entities with value > 0 (no outlier logic)
  minValue?: number;         // absolute minimum to flag (regardless of outlier logic)
}[] = [
  { id: 'pct_tardias_reparto', name: 'Reparto tardío'  },
  { id: 'pct_undelivered',    name: 'Entregas fallidas' },
];

// ─── Regex for identifying delivery-related incident notes ───────────────────
// Same patterns used in lib/kpi-compute.ts extractIncidentesValues.
const ORDER_CODE_RE = /\d[\w]*[-–]\w+[-–]\w+/;
const DELIVERY_RE   = /\bentregad?[ao]?\b/i;

// ─── Bundle builder ───────────────────────────────────────────────────────────

function buildBundle(
  hub:                  Hub,
  kpis:                 Kpi[],
  snapshots:            Snapshot[],
  peers:                Peer[],
  mnaProducts:          MnaProduct[],
  faltantesSkuProducts: FaltantesSku[],
  currentWeek:          string,
): Omit<ReportBundle, 'incidentesErroneas'> {
  // Week label: "vie 2 may — jue 8 may"
  const startDate = new Date(currentWeek + 'T00:00:00');
  const endDate   = new Date(currentWeek + 'T00:00:00');
  endDate.setDate(endDate.getDate() + 6);
  const fmt       = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short' });
  const weekLabel = `vie ${fmt.format(startDate)} — jue ${fmt.format(endDate)}`;

  // ── Hub-level KPI summary ─────────────────────────────────────────────────
  const kpiSummary = kpis
    .map((kpi) => {
      const snap = snapshots.find(
        (s) =>
          s.kpi_id      === kpi.id &&
          s.scope_level === 'hub'  &&
          s.scope_key   === hub.id &&
          s.week_start  === currentWeek,
      );
      if (!snap || snap.value === null) return null;

      // Compute rolling 4-week mean from snapshot history when the DB value is
      // null (e.g. current week was first computed before prior data existed).
      // This mirrors the same client-side fallback used in PorHubTab.
      let rollingMean4w: number | null = snap.rolling_mean_4w ?? null;
      if (rollingMean4w === null) {
        const priorVals = snapshots
          .filter(
            (s) =>
              s.kpi_id      === kpi.id &&
              s.scope_level === 'hub'  &&
              s.scope_key   === hub.id &&
              s.week_start  <  currentWeek,
          )
          .sort((a, b) => (a.week_start > b.week_start ? -1 : 1)) // newest first
          .slice(0, 4)
          .map((s) => s.value)
          .filter((v): v is number => typeof v === 'number');
        if (priorVals.length > 0) {
          rollingMean4w = priorVals.reduce((a, b) => a + b, 0) / priorVals.length;
        }
      }

      return {
        id:            kpi.id,
        name:          kpi.name_es,
        value:         snap.value,
        prevValue:     snap.prev_week_value   ?? null,
        rollingMean4w,
        unit:          kpi.unit,
        direction:     kpi.direction,
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

      // Use def.higherIsBetter override when set; otherwise fall back to DB direction.
      const effectiveHigherIsBetter = def.higherIsBetter !== undefined
        ? def.higherIsBetter
        : kpi.direction === 'higher_is_better';

      const entities = hubPeers.map((p) => {
        let flagged = false;
        if (def.threshold !== undefined && p.value !== null) {
          // higher_is_better (e.g. tasa_armado): flag if below threshold
          // lower_is_better: flag if above threshold
          flagged = effectiveHigherIsBetter
            ? p.value <= def.threshold
            : p.value >= def.threshold;
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

      return {
        kpiId:     def.id,
        kpiName:   def.name,
        unit:      kpi.unit,
        // Use effective direction so route.ts generates the correct UMBRAL label
        direction: effectiveHigherIsBetter ? 'higher_is_better' : 'lower_is_better',
        hubMean,
        threshold: def.threshold,
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

      let entities = hubPeers.map((p) => {
        let flagged = false;
        if (def.showAllPositive && p.value !== null) {
          flagged = p.value >= 1;
        } else if (hubMean !== null && p.value !== null) {
          flagged = p.value > hubMean * 2;
          // Apply absolute minimum threshold — e.g. retardos needs ≥3 to matter
          if (flagged && def.minValue !== undefined) {
            flagged = p.value >= def.minValue;
          }
        }
        return { name: p.entity_key, value: p.value, flagged };
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

      return {
        kpiId:     def.id,
        kpiName:   def.name,
        unit:      kpi.unit,
        direction: kpi.direction,
        hubMean,
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
      if (!ORDER_CODE_RE.test(notas) && !DELIVERY_RE.test(notas)) continue;

      // Format date.
      // IMPORTANT: date-only strings like "2026-05-08" (10 chars, no time) are
      // parsed by JS as UTC midnight. In Mexico City (UTC-6/-5) that becomes the
      // evening of May 7, so toLocaleDateString would show "may 7" instead of
      // "may 8". Appending T12:00:00 forces local-noon interpretation, matching
      // the same pattern used in the upload route's Friday validation.
      let fecha = String(d['Fecha'] ?? '');
      try {
        const raw    = fecha.trim();
        const parsed = new Date(raw.length === 10 ? raw + 'T12:00:00' : raw);
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
        ...buildBundle(hub, kpis, snapshots, peers, mnaProducts, faltantesSkuProducts, currentWeek),
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
