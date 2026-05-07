'use client';
import { useMemo, useState, useEffect } from 'react';
import {
  LineChart, Line, ResponsiveContainer, ReferenceLine, Tooltip,
  XAxis, YAxis, CartesianGrid,
} from 'recharts';
import {
  formatValue, formatDelta, weekEndLabel, deltaClassForDirection,
  type Kpi, type Hub, type Snapshot, type Peer, type MnaProduct, type FaltantesSku,
} from './_shared';
import type { MnaCategory } from '@/lib/sku-classifier';

/* ─── Sparkline tooltip ──────────────────────────────────────────────────── */
function SparkTooltip({
  active,
  payload,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ payload: { value: number | null; week: string } }>;
  unit?: string;
}) {
  if (!active || !payload?.length || !unit) return null;
  const { value, week } = payload[0].payload;
  return (
    <div className="bg-slate-800 text-white text-[10px] px-2 py-1 rounded-md shadow-lg pointer-events-none leading-snug z-50">
      <div className="font-semibold">{formatValue(value, unit)}</div>
      <div className="opacity-60 text-[9px]">{week}</div>
    </div>
  );
}

interface Props {
  kpis: Kpi[];
  hubs: Hub[];
  snapshots: Snapshot[];
  peers: Peer[];
  /** Multi-week operator peer rows (within_hub) for assembler WoW charts. */
  assemblerTrend: Peer[];
  /** Multi-week driver peer rows (within_hub) for driver WoW charts. */
  driverTrend: Peer[];
  mnaProducts: MnaProduct[];
  faltantesSkuProducts: FaltantesSku[];
  roles: { id: string; name_es: string }[];
  currentWeek: string;
  selectedHub?: string;
}

/**
 * Maps each MNA subdivision KPI id to the category it should show in the
 * tile flip. mna_pct shows all categories (null = no filter).
 *
 * Note: mna_graneles_pct → 'abarrotes' because "Graneles" is Calii's name
 * for the shelf-stable / dry goods category, which the classifier labels
 * 'abarrotes' to match the source catalog column values.
 */
const MNA_CATEGORY_FILTER: Record<string, MnaCategory | null> = {
  mna_pct:          null,        // all — no filter
  mna_graneles_pct: 'abarrotes', // shelf-stable / dry goods
  mna_fyv_pct:      'fyv',       // frutas y verduras
  mna_carnes_pct:   'carnes',    // refrigerated / cold-chain
};

/**
 * Maps each faltantes subcategory KPI id to its MnaCategory filter.
 * faltantes_armador_pct is intentionally excluded — its flip shows the
 * assembler ranking from peer_comparisons, not SKU data.
 */
const FALTANTES_SKU_CATEGORY_FILTER: Record<string, MnaCategory> = {
  faltantes_fyv_pct:      'fyv',
  faltantes_carnes_pct:   'carnes',
  faltantes_graneles_pct: 'abarrotes',
};

/**
 * Per-unit y-axis ceiling when slider is at the very bottom (most zoomed out).
 * pct values are in display units (0–100), not fractions.
 */
const UNIT_MAX_CEIL: Record<string, number> = { pct: 100, rate: 250, count: 20, currency: 50_000 };

/** Distinct color palette for individual assembler lines (up to 14). */
const ASSEMBLER_PALETTE = [
  '#0ea5e9', '#22c55e', '#a855f7', '#ef4444', '#f59e0b',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1',
  '#14b8a6', '#e11d48', '#7c3aed', '#059669',
];

/** KPI metadata for WoW charts — assemblers (7 KPIs) and drivers (3 KPIs). */
type KpiMeta = { title: string; unit: string; direction: string };
const KPI_META: Record<string, KpiMeta> = {
  // Assembler KPIs
  faltantes_armador_pct:              { title: 'Faltantes armador',       unit: 'pct',   direction: 'lower_is_better'  },
  incidentes_manuales_pct:            { title: 'Incidentes general',      unit: 'pct',   direction: 'lower_is_better'  },
  incidentes_calidad_pct:             { title: 'Incidentes calidad',      unit: 'pct',   direction: 'lower_is_better'  },
  incidentes_faltantes_pct:           { title: 'Incidentes faltantes',    unit: 'pct',   direction: 'lower_is_better'  },
  incidentes_faltantes_completos_pct: { title: 'Faltantes completos',     unit: 'pct',   direction: 'lower_is_better'  },
  incidentes_faltantes_parciales_pct: { title: 'Faltantes parciales',     unit: 'pct',   direction: 'lower_is_better'  },
  tasa_armado:                        { title: 'Velocidad de armado',     unit: 'rate',  direction: 'higher_is_better' },
  // Driver KPIs
  pct_tardias_reparto:                { title: '% entregas tardías',      unit: 'pct',      direction: 'lower_is_better'  },
  pct_undelivered:                    { title: '% entregas fallidas',     unit: 'pct',      direction: 'lower_is_better'  },
  entregas_erroneas:                  { title: 'Entregas erróneas',       unit: 'count',    direction: 'lower_is_better'  },
  discrepancia_mxn:                   { title: 'Discrepancia ($)',         unit: 'currency', direction: 'lower_is_better'  },
};

export function PorHubTab({ kpis, hubs, snapshots, peers, assemblerTrend = [], driverTrend = [], mnaProducts = [], faltantesSkuProducts = [], currentWeek, selectedHub }: Props) {
  const [flippedTiles, setFlippedTiles] = useState<Set<string>>(new Set());

  // Hub selection is client-side state — switching hubs does NOT hit the server.
  // All data is already loaded; we just filter it here.
  const [hubId, setHubId] = useState<string>(selectedHub || hubs[0]?.id || '');
  const hub = hubs.find((h) => h.id === hubId);

  function toggleTile(kpiId: string, e: React.MouseEvent) {
    e.stopPropagation();
    setFlippedTiles((prev) => {
      const next = new Set(prev);
      if (next.has(kpiId)) next.delete(kpiId);
      else next.add(kpiId);
      return next;
    });
  }

  // KPI tiles for this hub — all active KPIs, no parent_kpi_id filter needed
  // now that mna_monto child KPI has been deleted.
  const tiles = useMemo(() => {
    return kpis.map((k) => {
      const thisWeek = snapshots.find(
        (s) => s.kpi_id === k.id && s.scope_level === 'hub' && s.scope_key === hubId && s.week_start === currentWeek
      );
      const peerThis = snapshots.find(
        (s) => s.kpi_id === k.id && s.scope_level === 'global' && s.week_start === currentWeek
      );
      const trend = snapshots
        .filter((s) => s.kpi_id === k.id && s.scope_level === 'hub' && s.scope_key === hubId)
        .sort((a, b) => (a.week_start > b.week_start ? 1 : -1))
        .map((s) => ({ week: weekEndLabel(s.week_start), value: s.value === null ? null : Number(s.value) }));
      return { kpi: k, thisWeek, peerThis, trend };
    });
  }, [kpis, snapshots, hubId, currentWeek]);

  // Resolve the within_city scope_key for this hub.
  //
  // peer_comparisons.scope_key for within_city rows = upload.city (a City enum like 'mty', 'slp', …)
  // hubs.city = a display name like 'Monterrey', 'Saltillo', … — they may NOT match as strings.
  //
  // Strategy (in order):
  //   1. Exact string match of hub.city against existing within_city scope_keys.
  //   2. Cross-reference: find the within_city scope_key whose entity_keys overlap most
  //      with this hub's within_hub entities (reliable when within_hub data exists).
  //   3. Case/accent-insensitive match.
  //   4. For single-hub cities: the only within_city scope_key for that entity_type.
  const hubCityKey = useMemo((): string | null => {
    if (!hub) return null;
    const normalize = (s: string) =>
      s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const allCityKeys = [
      ...new Set(
        peers
          .filter((p) => p.scope_type === 'within_city' && p.scope_key)
          .map((p) => p.scope_key as string)
      ),
    ];
    // 1. Exact match
    if (allCityKeys.includes(hub.city)) return hub.city;
    // 2. Cross-reference via within_hub entity_keys
    const withinHubEntities = new Set(
      peers.filter((p) => p.scope_type === 'within_hub' && p.scope_key === hubId).map((p) => p.entity_key)
    );
    if (withinHubEntities.size > 0) {
      const counts = new Map<string, number>();
      for (const p of peers) {
        if (p.scope_type !== 'within_city' || !p.scope_key) continue;
        if (withinHubEntities.has(p.entity_key)) {
          counts.set(p.scope_key, (counts.get(p.scope_key) ?? 0) + 1);
        }
      }
      if (counts.size > 0) {
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      }
    }
    // 3. Normalize (strip accents, lowercase, non-alphanumeric)
    const normCity = normalize(hub.city);
    const normMatch = allCityKeys.find((k) => normalize(k) === normCity);
    if (normMatch) return normMatch;
    // 4. For single-hub-city scenario: if this hub is the only hub in its city AND
    //    only one within_city scope_key has data, pick that one.
    const siblingsInCity = hubs.filter((h) => h.city === hub.city);
    if (siblingsInCity.length === 1 && allCityKeys.length === 1) return allCityKeys[0];
    return hub.city; // last resort — may not match but won't crash
  }, [peers, hub, hubId, hubs]);

  // Per-tile peer data for the back face — operators and drivers only.
  // MNA product rankings come from mnaProducts (upload_rows), not peer_comparisons.
  const tilePeerData = useMemo(() => {
    const result = new Map<string, { ops: Peer[]; drvs: Peer[] }>();
    for (const k of kpis) {
      const opsHub = peers.filter(
        (p) => p.entity_type === 'operator' && p.kpi_id === k.id && p.scope_type === 'within_hub' && p.scope_key === hubId
      );
      const opsCity = peers.filter(
        (p) => p.entity_type === 'operator' && p.kpi_id === k.id && p.scope_type === 'within_city' && p.scope_key === hubCityKey
      );
      const drvsHub = peers.filter(
        (p) => p.entity_type === 'driver' && p.kpi_id === k.id && p.scope_type === 'within_hub' && p.scope_key === hubId
      );
      const drvsCity = peers.filter(
        (p) => p.entity_type === 'driver' && p.kpi_id === k.id && p.scope_type === 'within_city' && p.scope_key === hubCityKey
      );
      result.set(k.id, {
        ops:  opsHub.length  > 0 ? opsHub  : opsCity,
        drvs: drvsHub.length > 0 ? drvsHub : drvsCity,
      });
    }
    return result;
  }, [kpis, peers, hubId, hubCityKey]);

  // Header count: unique entities across ALL KPIs (within_hub, falling back to within_city)
  const operatorCount = useMemo(() => {
    const withinHub = peers.filter(
      (p) => p.entity_type === 'operator' && p.scope_type === 'within_hub' && p.scope_key === hubId
    );
    const source = withinHub.length > 0
      ? withinHub
      : peers.filter((p) => p.entity_type === 'operator' && p.scope_type === 'within_city' && p.scope_key === hubCityKey);
    return new Set(source.map((p) => p.entity_key)).size;
  }, [peers, hubId, hubCityKey]);

  const driverCount = useMemo(() => {
    const withinHub = peers.filter(
      (p) => p.entity_type === 'driver' && p.scope_type === 'within_hub' && p.scope_key === hubId
    );
    const source = withinHub.length > 0
      ? withinHub
      : peers.filter((p) => p.entity_type === 'driver' && p.scope_type === 'within_city' && p.scope_key === hubCityKey);
    return new Set(source.map((p) => p.entity_key)).size;
  }, [peers, hubId, hubCityKey]);

  if (!hub) return <p className="text-[var(--muted)]">No hay hubs configurados.</p>;

  return (
    <div className="space-y-4">
      {/* Hub chips */}
      <div className="flex flex-wrap gap-2">
        {hubs.map((h) => (
          <button
            key={h.id}
            onClick={() => setHubId(h.id)}
            className={`px-3 py-1.5 rounded-full text-[12px] font-medium border ${
              h.id === hubId ? 'bg-black text-white border-black' : 'bg-white text-slate-700 border-[var(--line)] hover:border-black'
            }`}
          >
            {h.display_name}
            <span className="ml-1.5 opacity-70 text-[10.5px]">{h.city}</span>
          </button>
        ))}
      </div>

      {/* Hub overview */}
      <div className="bg-white border border-[var(--line)] rounded-xl p-5 shadow-soft">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <h2 className="text-[19px] font-bold">{hub.display_name}</h2>
            <div className="text-[12px] text-[var(--muted)]">{hub.city} · semana del jue {weekEndLabel(currentWeek)}</div>
          </div>
          <div className="text-[11.5px] text-[var(--muted)]">
            {operatorCount} armadores · {driverCount} repartidores con datos esta sem
          </div>
        </div>
      </div>

      {/* KPI tiles grid */}
      <div className="flex items-center gap-2 mb-1">
        <div className="text-[13px] text-[var(--muted)] font-bold uppercase tracking-wide">KPIs · 12 semanas</div>
        <div className="text-[10.5px] text-[var(--muted)] opacity-60">· clic en tile para ver ranking</div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {tiles.map(({ kpi, thisWeek, peerThis, trend }) => {
          const rawValue = thisWeek?.value ?? null;
          // For count KPIs (e.g. entregas erróneas), null means no incidents this
          // week — display 0 rather than '—' so the tile isn't confusingly blank.
          const value = (rawValue === null && kpi.unit === 'count') ? 0 : rawValue;
          const prev  = thisWeek?.prev_week_value ?? null;
          const delta = formatDelta(value, prev, kpi.unit);
          const deltaCls = deltaClassForDirection(delta.isUp, kpi.direction);
          const peerVal = peerThis?.value ?? null;

          // ── Tile color: WoW trend vs own 4-week rolling average ─────────────
          //
          // Compare this week's value against the hub's own 4-week rolling mean
          // using std dev (σ) as the sensitivity yardstick:
          //
          //   • Baseline  = rolling_mean_4w (stored on the snapshot)
          //   • σ         = std dev of the last 4 non-null hub values (excl. current)
          //   • Green     = current is >0.75σ better than baseline (direction-aware)
          //   • Red       = current is >0.75σ worse  than baseline
          //   • White     = within ±0.75σ (normal week-to-week noise)
          //
          // Fallback when σ is undefined/0 (new hub, very stable KPI, first weeks):
          //   use a ±5% relative threshold instead.
          //
          // This replaces the old "vs peer mean" logic so each hub is judged
          // against its own history, not against other hubs with different ops.
          let z: 'good' | 'mid' | 'bad' | null = null;
          if (value !== null) {
            const mean4w  = thisWeek?.rolling_mean_4w ?? null;

            // Compute σ from the last 4 prior data points in trend (sorted asc,
            // exclude current week so we don't include today in its own baseline).
            const priorVals = trend
              .slice(0, -1)                          // drop current week (last entry)
              .map((t) => t.value)
              .filter((v): v is number => v !== null)
              .slice(-4);                            // at most 4 weeks

            let sigma: number | null = null;
            if (priorVals.length >= 3) {
              const mu  = priorVals.reduce((a, b) => a + b, 0) / priorVals.length;
              const variance = priorVals.reduce((a, b) => a + (b - mu) ** 2, 0) / priorVals.length;
              sigma = Math.sqrt(variance);
            }

            if (mean4w !== null) {
              const wantsLow   = kpi.direction === 'lower_is_better';
              const diff       = value - mean4w;  // positive = higher than baseline

              if (sigma !== null && sigma > 0) {
                // σ-based threshold: 0.75 standard deviations from own mean
                const SIGMA_THRESHOLD = 0.75;
                const sigmas = diff / sigma;
                const isBetter = wantsLow ? sigmas < -SIGMA_THRESHOLD : sigmas > SIGMA_THRESHOLD;
                const isWorse  = wantsLow ? sigmas > SIGMA_THRESHOLD  : sigmas < -SIGMA_THRESHOLD;
                z = isBetter ? 'good' : isWorse ? 'bad' : 'mid';
              } else if (mean4w !== 0) {
                // Fallback: ±5% relative when σ is unavailable or 0
                const PCT_THRESHOLD = 5;
                const pctDiff = (diff / Math.abs(mean4w)) * 100;
                const isBetter = wantsLow ? pctDiff < -PCT_THRESHOLD : pctDiff > PCT_THRESHOLD;
                const isWorse  = wantsLow ? pctDiff > PCT_THRESHOLD  : pctDiff < -PCT_THRESHOLD;
                z = isBetter ? 'good' : isWorse ? 'bad' : 'mid';
              }
            }
          }

          const tileClass =
            z === 'good' ? 'border-emerald-200 bg-emerald-50' :
            z === 'bad'  ? 'border-red-200 bg-red-50' :
                           'border-[var(--line)] bg-white';
          const lineStroke = z === 'bad' ? '#ef4444' : z === 'good' ? '#10b981' : '#0ea5e9';
          const isFlipped  = flippedTiles.has(kpi.id);

          // Back-face peer data — sorted WORST → BEST so attention goes to bottom performers.
          const { ops, drvs } = tilePeerData.get(kpi.id) ?? { ops: [], drvs: [] };
          const worstFirst = (a: Peer, b: Peer) => {
            const av = a.value ?? 0, bv = b.value ?? 0;
            return kpi.direction === 'higher_is_better' ? av - bv : bv - av;
          };
          const sortedOps  = [...ops].sort(worstFirst);
          const sortedDrvs = [...drvs].sort(worstFirst);
          const hasOps  = sortedOps.length > 0;
          const hasDrvs = sortedDrvs.length > 0;

          // MNA tile flip — built from upload_rows, not peer_comparisons.
          // For subdivision KPIs (mna_graneles_pct, mna_fyv_pct, mna_carnes_pct),
          // the flip shows only the products belonging to that category.
          const isMna = kpi.source_app_id === 'mna';
          const mnaCatFilter: MnaCategory | null = isMna
            ? (MNA_CATEGORY_FILTER[kpi.id] ?? null)
            : null;

          const mnaForHub = isMna
            ? mnaProducts.filter(
                (p) =>
                  p.hub_id === hubId &&
                  (mnaCatFilter === null || p.category === mnaCatFilter)
              )
            : [];

          const mnaSortedByAmount = isMna ? [...mnaForHub].sort((a, b) => b.amount - a.amount) : [];

          // Faltantes subcategory tile flip — top SKUs by count from breakdown upload.
          // faltantes_armador_pct (general) uses the normal assembler peer flip instead.
          const faltantesCatFilter = FALTANTES_SKU_CATEGORY_FILTER[kpi.id] ?? null;
          const isFaltantesSku     = faltantesCatFilter !== null;

          const faltantesForHub = isFaltantesSku
            ? faltantesSkuProducts
                .filter((p) => p.hub_id === hubId && p.category === faltantesCatFilter)
                .sort((a, b) => b.count - a.count)
            : [];

          return (
            <div
              key={kpi.id}
              className={`border rounded-xl shadow-soft ${tileClass} relative overflow-hidden cursor-pointer select-none`}
              style={{ perspective: '1000px' }}
              onClick={(e) => toggleTile(kpi.id, e)}
              title={isFlipped ? 'Clic para volver' : 'Clic para ver ranking de personas'}
            >
              {/* ── Flipper (rotates both faces together) ── */}
              <div
                style={{
                  transformStyle: 'preserve-3d',
                  transform: isFlipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
                  transition: 'transform 0.42s cubic-bezier(0.4, 0, 0.2, 1)',
                  position: 'relative',
                }}
              >
                {/* ── FRONT FACE ── */}
                <div
                  className="p-3"
                  style={{ backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }}
                >
                  <div className="flex items-start justify-between mb-1">
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-[var(--muted)] font-bold">{kpi.name_es}</div>
                      <div className="text-[10px] text-[var(--muted)]">{kpi.category}</div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-[10px] text-[var(--muted)]">{kpi.unit}</span>
                      {/* Flip hint */}
                      <svg
                        className="w-3 h-3 text-slate-400"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        aria-hidden="true"
                      >
                        <path d="M2 8C2 4.686 4.686 2 8 2c2.21 0 4.154 1.13 5.29 2.84M14 8c0 3.314-2.686 6-6 6-2.21 0-4.154-1.13-5.29-2.84" strokeLinecap="round"/>
                        <path d="M13 1.5v3.5h-3.5M3 14.5v-3.5h3.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  </div>
                  <div className="flex items-baseline justify-between gap-1">
                    <div className="text-[22px] font-bold">{formatValue(value, kpi.unit)}</div>
                    <div className={`text-[11px] font-bold ${deltaCls}`}>{delta.text}</div>
                  </div>
                  {trend.length > 1 && (
                    /* Stop click propagation so hovering/clicking the chart doesn't flip the tile */
                    <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
                      <ResponsiveContainer width="100%" height={32}>
                        <LineChart
                          data={trend.map((t) => ({ ...t }))}
                          margin={{ top: 2, right: 2, left: 2, bottom: 2 }}
                        >
                          {thisWeek?.rolling_mean_4w != null && (
                            <ReferenceLine y={thisWeek.rolling_mean_4w} stroke="#94a3b8" strokeDasharray="2 2" />
                          )}
                          <Tooltip
                            content={<SparkTooltip unit={kpi.unit} />}
                            cursor={{ stroke: '#94a3b8', strokeWidth: 1 }}
                            isAnimationActive={false}
                            position={{ y: -42 }}
                          />
                          <Line
                            type="monotone"
                            dataKey="value"
                            stroke={lineStroke}
                            strokeWidth={1.6}
                            dot={false}
                            connectNulls
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  <div className="text-[10.5px] text-[var(--muted)] mt-1.5 flex justify-between">
                    <span title="Promedio de las últimas 4 semanas de este hub">
                      4w avg: {formatValue(thisWeek?.rolling_mean_4w ?? null, kpi.unit)}
                    </span>
                    <span>{kpi.direction === 'lower_is_better' ? '↓ menor mejor' : '↑ mayor mejor'}</span>
                  </div>
                </div>

                {/* ── BACK FACE ── */}
                <div
                  className="absolute inset-0 p-3 overflow-y-auto"
                  style={{
                    backfaceVisibility: 'hidden',
                    WebkitBackfaceVisibility: 'hidden',
                    transform: 'rotateY(180deg)',
                  }}
                >
                  {/* Header */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--muted)] truncate pr-2">{kpi.name_es}</div>
                    <span className="text-[9px] text-[var(--muted)] shrink-0 opacity-70">esta sem · clic para volver</span>
                  </div>

                  {isFaltantesSku ? (
                    /* ── Faltantes subcategory: top SKUs by count from breakdown ── */
                    faltantesForHub.length === 0 ? (
                      <div className="text-[11px] text-[var(--muted)] text-center py-4 opacity-60">Sin datos esta semana.</div>
                    ) : (
                      <FaltantesSkuBackFaceList items={faltantesForHub} max={8} />
                    )
                  ) : isMna ? (
                    /* ── MNA: two columns read directly from upload_rows ──
                       Subdivision KPIs (graneles/fyv/carnes) show only their
                       own category's products. mna_pct shows all. ── */
                    mnaForHub.length === 0 ? (
                      <div className="text-[11px] text-[var(--muted)] text-center py-4 opacity-60">Sin datos MNA esta semana.</div>
                    ) : (
                      <MnaBackFaceList items={mnaSortedByAmount} max={10} />
                    )
                  ) : rawValue === null ? (
                    /* ── No hub snapshot this week (incl. count KPIs coerced to 0).
                         Don't show city-level fallback — it would leak other hubs' drivers. ── */
                    <div className="text-[11px] text-[var(--muted)] text-center py-4 opacity-60">
                      {kpi.unit === 'count' ? '0 incidentes esta semana.' : 'Sin datos esta semana.'}
                    </div>
                  ) : !hasOps && !hasDrvs ? (
                    <div className="text-[11px] text-[var(--muted)] text-center py-4 opacity-60">
                      Sin datos para este KPI.
                    </div>
                  ) : hasOps && !hasDrvs ? (
                    /* ── Single column: only assembler data ── */
                    <BackFaceList label="Armadores" items={sortedOps} unit={kpi.unit} />
                  ) : !hasOps && hasDrvs ? (
                    /* ── Single column: only driver data ── */
                    <BackFaceList label="Repartidores" items={sortedDrvs} unit={kpi.unit} />
                  ) : (
                    /* ── Two columns: both operator and driver data ── */
                    <div className="grid grid-cols-2 gap-x-3">
                      <BackFaceList label="Armadores"    items={sortedOps}  unit={kpi.unit} />
                      <BackFaceList label="Repartidores" items={sortedDrvs} unit={kpi.unit} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Assembler WoW trends ─────────────────────────────────────────────── */}
      <AssemblerWowSection assemblerTrend={assemblerTrend} hubId={hubId} hubName={hub.display_name} />

      {/* ── Driver WoW trends ────────────────────────────────────────────────── */}
      <DriverWowSection driverTrend={driverTrend} hubId={hubId} hubName={hub.display_name} />
    </div>
  );
}

/* ─── Back-face ranked list (worst → best, #1 = red, last shown = green) ─── */
function BackFaceList({ label, items, unit, max }: { label: string; items: Peer[]; unit: string; max?: number }) {
  const shown = max !== undefined ? items.slice(0, max) : items;
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide font-bold text-[var(--muted)] mb-1">{label}</div>
      {shown.length === 0 ? (
        <div className="text-[10px] text-[var(--muted)] opacity-60">—</div>
      ) : (
        <div className="space-y-0.5">
          {shown.map((p, i) => {
            const isWorst = i === 0;
            const isBest  = i === shown.length - 1 && shown.length > 1;
            return (
              <div key={p.entity_key} className="flex items-center justify-between gap-1">
                <div className="flex items-center gap-1 min-w-0">
                  <span className={`text-[9px] font-bold w-4 shrink-0 ${isWorst ? 'text-red-500' : isBest ? 'text-emerald-600' : 'text-slate-400'}`}>
                    {i + 1}
                  </span>
                  <span className="text-[10px] truncate">{p.entity_key}</span>
                </div>
                <span className="text-[10px] font-semibold shrink-0">{formatValue(p.value, unit)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Faltantes SKU back-face list (sorted by count, highest first) ──────── */
function FaltantesSkuBackFaceList({ items, max }: { items: FaltantesSku[]; max: number }) {
  const shown = items.slice(0, max);
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide font-bold text-[var(--muted)] mb-1">Top SKUs · eventos</div>
      {shown.length === 0 ? (
        <div className="text-[10px] text-[var(--muted)] opacity-60">—</div>
      ) : (
        <div className="space-y-0.5">
          {shown.map((p, i) => {
            const isWorst = i === 0;
            const isBest  = i === shown.length - 1 && shown.length > 1;
            return (
              <div key={`${p.hub_id}|${p.producto}`} className="flex items-center justify-between gap-1">
                <div className="flex items-center gap-1 min-w-0">
                  <span className={`text-[9px] font-bold w-4 shrink-0 ${isWorst ? 'text-red-500' : isBest ? 'text-emerald-600' : 'text-slate-400'}`}>
                    {i + 1}
                  </span>
                  <span className="text-[10px] truncate">{p.producto}</span>
                </div>
                <span className="text-[10px] font-semibold shrink-0">{p.count}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── MNA back-face list — sorted by highest $ amount, shows $ | % per row ── */
function MnaBackFaceList({ items, max }: {
  items: MnaProduct[];
  max: number;
}) {
  const shown = items.slice(0, max);
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide font-bold text-[var(--muted)] mb-1">Mayor MNA ($)</div>
      {shown.length === 0 ? (
        <div className="text-[10px] text-[var(--muted)] opacity-60">—</div>
      ) : (
        <div className="space-y-0.5">
          {shown.map((p, i) => {
            const isWorst = i === 0;
            const isBest  = i === shown.length - 1 && shown.length > 1;
            return (
              <div key={`${p.hub_id}|${p.producto}`} className="flex items-center justify-between gap-1">
                <div className="flex items-center gap-1 min-w-0">
                  <span className={`text-[9px] font-bold w-4 shrink-0 ${isWorst ? 'text-red-500' : isBest ? 'text-emerald-600' : 'text-slate-400'}`}>
                    {i + 1}
                  </span>
                  <span className="text-[10px] truncate">{p.producto}</span>
                </div>
                <span className="text-[10px] font-semibold shrink-0 text-right">
                  {formatValue(p.amount, 'currency')}&nbsp;<span className="text-[var(--muted)] font-normal">{formatValue(p.pct, 'pct')}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── WoW chart components ───────────────────────────────────────────────── */


/**
 * Tooltip for WoW line charts.
 *
 * Entries are sorted by the hovered week's value (highest first) so the ranking
 * updates dynamically as you pan across weeks — easier to read than a fixed order.
 */
function WowTooltip({
  active,
  payload,
  label,
  colorMap,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number | null }>;
  label?: string;
  colorMap: Map<string, string>;
  unit: string;
}) {
  if (!active || !payload?.length) return null;
  const fmt = (v: number | null | undefined) => {
    if (v === null || v === undefined) return '—';
    if (unit === 'pct')      return `${v.toFixed(1)}%`;
    if (unit === 'rate')     return v.toFixed(1);
    if (unit === 'currency') return `$${Math.round(v).toLocaleString('es-MX')}`;
    return v.toFixed(0);
  };
  // Sort by current-hovered-week value (highest first) — updates as you pan across weeks.
  const sorted = [...payload].sort((a, b) => {
    const av = a.value ?? -Infinity;
    const bv = b.value ?? -Infinity;
    return bv - av;
  });
  return (
    <div className="bg-slate-800 text-white text-[10px] px-3 py-2 rounded-lg shadow-lg pointer-events-none min-w-[150px]">
      <div className="font-semibold mb-1.5 text-[11px] opacity-80">{label}</div>
      {sorted.map((entry) => (
        <div key={entry.name} className="flex items-center justify-between gap-4 leading-5">
          <div className="flex items-center gap-1.5 min-w-0">
            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colorMap.get(entry.name) }} />
            <span className="opacity-90 truncate max-w-[110px]">{entry.name}</span>
          </div>
          <span className="font-bold tabular-nums">{fmt(entry.value)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Compute a y-axis ceiling that suppresses outliers.
 *
 * Works on NON-ZERO values only — zeros (no incidents / no waste) don't
 * represent the "normal active range" and would drag the percentile down to 0.
 *
 * Key fix: percentile index uses (n-1)*p (0-based interpolation), NOT n*p.
 * With n*p, p75 for 4 values = floor(3) = index 3 = the max → outlier wins.
 * With (n-1)*p, p75 for 4 values = floor(2.25) = index 2 = second-highest. ✓
 *
 * Headroom is 1.3× (30%) above the 75th percentile, then snapped up to a
 * nice magnitude ceiling. Values above the cap are clipped at the chart top;
 * users can hover to see the exact value.
 */
function computeYMax(vals: (number | null)[]): number | undefined {
  const nums = vals.filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
  if (nums.length === 0) return undefined;
  const sorted = [...nums].sort((a, b) => a - b);
  // Correct 0-based percentile: use (n-1) not n so the index never exceeds the last element.
  const p75idx = Math.floor((sorted.length - 1) * 0.75);
  const p75    = sorted[p75idx];
  const raw    = p75 * 1.3;
  if (raw <= 0) return undefined;
  const mag      = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm     = raw / mag;
  const niceMult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return niceMult * mag;
}

/**
 * Generic WoW line chart — works for both assemblers and drivers.
 *
 * Rules:
 *   • `displayWeeks` (passed by parent) is shared across all charts in a section
 *     so every chart shows the same date range on the x-axis.
 *   • Only graphs entities with a non-null value in the most recent data week.
 *     Departed assemblers (absent from the last week) are excluded automatically.
 *     New assemblers start mid-chart; gaps in history are bridged with connectNulls.
 *   • Entity line order is fixed by most-recent-week value, biggest → smallest.
 *     Hover tooltip sorts dynamically per hovered week.
 *   • Y-axis default is the smart p75 cap from computeYMax.
 *     A vertical drag slider on the left lets the user override the ceiling live:
 *       top    = most zoomed in (UNIT_MIN_CEIL)
 *       bottom = full unit range (UNIT_MAX_CEIL: 100% / 250 rate / 20 count)
 *     Slider resets to smart cap on hub switch.
 *   • `wide` = col-span-2 (full row width), used for the "hero" KPI in each section.
 */
function WowChart({
  rows,
  title,
  unit,
  direction,
  wide = false,
  displayWeeks,
}: {
  rows: Peer[];
  title: string;
  unit: string;
  direction: string;
  wide?: boolean;
  displayWeeks: string[];
}) {
  // ── Derive all chart values BEFORE hooks (hooks must be unconditional) ────
  const rowWeeks       = [...new Set(rows.map((r) => r.week_start))].sort();
  const mostRecentWeek = rowWeeks.length > 0 ? rowWeeks[rowWeeks.length - 1] : null;

  const activeEntities = new Set(
    mostRecentWeek
      ? rows.filter((r) => r.week_start === mostRecentWeek && r.value !== null).map((r) => r.entity_key)
      : []
  );

  // Fixed order: descending by most-recent-week value (biggest first).
  const entityOrder = [...activeEntities].sort((a, b) => {
    const av = rows.find((r) => r.week_start === mostRecentWeek && r.entity_key === a)?.value ?? null;
    const bv = rows.find((r) => r.week_start === mostRecentWeek && r.entity_key === b)?.value ?? null;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av;
  });

  const colorMap = new Map(
    entityOrder.map((e, i) => [e, ASSEMBLER_PALETTE[i % ASSEMBLER_PALETTE.length]])
  );

  // pct KPIs stored as 0–1 fractions in peer_comparisons → ×100 for display.
  const toDisplay = (v: number | null): number | null => {
    if (v === null) return null;
    return unit === 'pct' ? +(v * 100).toFixed(2) : v;
  };

  const data = displayWeeks.map((w) => {
    const point: Record<string, string | number | null> = { week: weekEndLabel(w) };
    for (const e of entityOrder) {
      const row = rows.find((r) => r.week_start === w && r.entity_key === e);
      point[e]  = toDisplay(row?.value ?? null);
    }
    return point;
  });

  const allDisplayVals = data.flatMap((pt) => entityOrder.map((e) => pt[e] as number | null));
  const smartYMax      = computeYMax(allDisplayVals);

  const unitMaxCeil = UNIT_MAX_CEIL[unit] ?? 100;
  const chartHeight = wide ? 210 : 180;

  // ── Hooks — called unconditionally, before any early return ───────────────
  // Default = smart cap so each chart loads at a sensible zoom level.
  // Full drag range: top = 0, bottom = unitMaxCeil (100% / 250 / 20).
  const [manualYMax, setManualYMax] = useState<number>(smartYMax ?? unitMaxCeil);

  // Reset to smart cap when the hub changes (scope_key in rows changes).
  const hubKey = rows.length > 0 ? (rows[0].scope_key ?? '') : '';
  useEffect(() => {
    setManualYMax(smartYMax ?? unitMaxCeil);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubKey]);

  // ── Early returns (after all hooks) ──────────────────────────────────────
  if (rowWeeks.length === 0 || activeEntities.size === 0) return null;

  const yFmt = (v: number) =>
    unit === 'pct'      ? `${v.toFixed(1)}%`
    : unit === 'rate'   ? v.toFixed(1)
    : unit === 'currency' ? `$${Math.round(v).toLocaleString('es-MX')}`
    : v.toFixed(0);

  return (
    <div className={`bg-white border border-[var(--line)] rounded-xl shadow-soft p-4${wide ? ' sm:col-span-2' : ''}`}>
      {/* Header — 18 px left offset matches slider width + gap so title aligns with plot */}
      <div
        className="text-[12px] font-semibold text-[var(--ink)] mb-3 flex items-center justify-between"
        style={{ paddingLeft: 22 }}
      >
        <span>{title}</span>
        <span className="text-[10px] font-normal text-[var(--muted)]">
          {direction === 'lower_is_better' ? '↓ menor mejor' : '↑ mayor mejor'}
        </span>
      </div>

      {/* Chart row: native vertical range slider (top=0, bottom=unitMaxCeil) + line chart */}
      <div className="flex items-stretch gap-1">
        <input
          type="range"
          min={0}
          max={unitMaxCeil}
          step={unit === 'pct' ? 0.5 : 1}
          value={manualYMax}
          onChange={(e) => setManualYMax(Number(e.target.value))}
          title={`Eje Y: ${manualYMax.toFixed(unit === 'pct' ? 1 : 0)}${unit === 'pct' ? '%' : ''} · arrastra para ajustar`}
          style={{
            writingMode: 'vertical-lr',
            width: 18,
            height: chartHeight,
            cursor: 'ns-resize',
            accentColor: '#475569',
            flexShrink: 0,
            padding: 0,
          } as React.CSSProperties}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis
                dataKey="week"
                tick={{ fontSize: 9, fill: '#94a3b8' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={yFmt}
                tick={{ fontSize: 9, fill: '#94a3b8' }}
                width={44}
                axisLine={false}
                tickLine={false}
                domain={[0, Math.max(0.1, manualYMax)]}
                allowDataOverflow
              />
              <Tooltip
                content={<WowTooltip colorMap={colorMap} unit={unit} />}
                cursor={{ stroke: '#cbd5e1', strokeWidth: 1 }}
                isAnimationActive={false}
                wrapperStyle={{ zIndex: 9999, pointerEvents: 'none' }}
              />
              {entityOrder.map((e) => (
                <Line
                  key={e}
                  type="monotone"
                  dataKey={e}
                  stroke={colorMap.get(e)!}
                  strokeWidth={1.6}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

/* ─── Assembler WoW section ──────────────────────────────────────────────── */

/**
 * 7 assembler KPI charts in 2-column grid.
 *
 * Layout (left → right, top → bottom):
 *   Faltantes armador    | Incidentes general
 *   Incidentes calidad   | Incidentes faltantes
 *   Faltantes completos  | Faltantes parciales
 *   Velocidad de armado  ← full width (col-span-2)
 */
function AssemblerWowSection({
  assemblerTrend,
  hubId,
  hubName,
}: {
  assemblerTrend: Peer[];
  hubId: string;
  hubName: string;
}) {
  const hubRows = assemblerTrend.filter((p) => p.scope_key === hubId);
  const rows    = (id: string) => hubRows.filter((r) => r.kpi_id === id);

  const hasAnyData = [
    'faltantes_armador_pct', 'incidentes_manuales_pct',
    'incidentes_calidad_pct', 'incidentes_faltantes_pct',
    'incidentes_faltantes_completos_pct', 'incidentes_faltantes_parciales_pct',
    'tasa_armado',
  ].some((id) => rows(id).length > 0);

  // Shared x-axis: last 5 weeks across ALL assembler KPIs for this hub so every
  // chart shows the same date range regardless of per-KPI data availability.
  const allSectionWeeks = [...new Set(hubRows.map((r) => r.week_start))].sort();
  const displayWeeks    = allSectionWeeks.slice(-5);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <div className="text-[13px] text-[var(--muted)] font-bold uppercase tracking-wide">
          Armadores · tendencia WoW · {hubName}
        </div>
        <div className="text-[10.5px] text-[var(--muted)] opacity-60">· últimas 5 semanas</div>
      </div>
      {!hasAnyData ? (
        <div className="bg-white border border-[var(--line)] rounded-xl shadow-soft p-8 text-center text-[12px] text-[var(--muted)]">
          Sin datos de armadores. Sube el archivo de desempeño operadores para habilitar esta sección.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <WowChart rows={rows('faltantes_armador_pct')}              {...KPI_META.faltantes_armador_pct}              displayWeeks={displayWeeks} />
          <WowChart rows={rows('incidentes_manuales_pct')}            {...KPI_META.incidentes_manuales_pct}            displayWeeks={displayWeeks} />
          <WowChart rows={rows('incidentes_calidad_pct')}             {...KPI_META.incidentes_calidad_pct}             displayWeeks={displayWeeks} />
          <WowChart rows={rows('incidentes_faltantes_pct')}           {...KPI_META.incidentes_faltantes_pct}           displayWeeks={displayWeeks} />
          <WowChart rows={rows('incidentes_faltantes_completos_pct')} {...KPI_META.incidentes_faltantes_completos_pct} displayWeeks={displayWeeks} />
          <WowChart rows={rows('incidentes_faltantes_parciales_pct')} {...KPI_META.incidentes_faltantes_parciales_pct} displayWeeks={displayWeeks} />
          <WowChart rows={rows('tasa_armado')}                        {...KPI_META.tasa_armado}                        displayWeeks={displayWeeks} wide />
        </div>
      )}
    </div>
  );
}

/* ─── Driver WoW section ─────────────────────────────────────────────────── */

/**
 * 3 driver KPI charts in 2-column grid.
 *
 * Layout:
 *   % entregas tardías | % entregas fallidas
 *   Entregas erróneas  ← full width (col-span-2)
 */
function DriverWowSection({
  driverTrend,
  hubId,
  hubName,
}: {
  driverTrend: Peer[];
  hubId: string;
  hubName: string;
}) {
  const hubRows = driverTrend.filter((p) => p.scope_key === hubId);
  const rows    = (id: string) => hubRows.filter((r) => r.kpi_id === id);

  const hasAnyData = [
    'pct_tardias_reparto', 'pct_undelivered', 'entregas_erroneas', 'discrepancia_mxn',
  ].some((id) => rows(id).length > 0);

  // Shared x-axis: last 5 weeks across ALL driver KPIs for this hub.
  const allSectionWeeks = [...new Set(hubRows.map((r) => r.week_start))].sort();
  const displayWeeks    = allSectionWeeks.slice(-5);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <div className="text-[13px] text-[var(--muted)] font-bold uppercase tracking-wide">
          Repartidores · tendencia WoW · {hubName}
        </div>
        <div className="text-[10.5px] text-[var(--muted)] opacity-60">· últimas 5 semanas</div>
      </div>
      {!hasAnyData ? (
        <div className="bg-white border border-[var(--line)] rounded-xl shadow-soft p-8 text-center text-[12px] text-[var(--muted)]">
          Sin datos de repartidores. Sube el archivo de desempeño repartidores para habilitar esta sección.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <WowChart rows={rows('pct_tardias_reparto')} {...KPI_META.pct_tardias_reparto} displayWeeks={displayWeeks} />
          <WowChart rows={rows('pct_undelivered')}     {...KPI_META.pct_undelivered}     displayWeeks={displayWeeks} />
          <WowChart rows={rows('entregas_erroneas')}   {...KPI_META.entregas_erroneas}   displayWeeks={displayWeeks} wide />
          <WowChart rows={rows('discrepancia_mxn')}    {...KPI_META.discrepancia_mxn}    displayWeeks={displayWeeks} wide />
        </div>
      )}
    </div>
  );
}
