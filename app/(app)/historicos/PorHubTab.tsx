'use client';
import { useMemo, useState } from 'react';
import { LineChart, Line, ResponsiveContainer, ReferenceLine, Tooltip } from 'recharts';
import {
  formatValue, formatDelta, weekEndLabel, deltaClassForDirection,
  type Kpi, type Hub, type Snapshot, type Peer, type MnaProduct,
} from './_shared';

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
  mnaProducts: MnaProduct[];
  roles: { id: string; name_es: string }[];
  currentWeek: string;
  selectedHub?: string;
}

export function PorHubTab({ kpis, hubs, snapshots, peers, mnaProducts, currentWeek, selectedHub }: Props) {
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
        ops: opsHub.length > 0 ? opsHub : opsCity,
        drvs: drvsHub.length > 0 ? drvsHub : drvsCity,
      });
    }
    return result;
  }, [kpis, peers, hubId, hubCityKey]);

  // Operator/driver rankings for the bottom rank tables — prefer within_hub; fall back to within_city.
  const operators = useMemo(() => {
    const withinHub = peers.filter(
      (p) => p.entity_type === 'operator' && p.scope_type === 'within_hub' && p.scope_key === hubId && p.kpi_id === 'tasa_armado'
    );
    if (withinHub.length > 0) return withinHub;
    return peers.filter(
      (p) => p.entity_type === 'operator' && p.scope_type === 'within_city' && p.scope_key === hubCityKey && p.kpi_id === 'tasa_armado'
    );
  }, [peers, hubId, hubCityKey]);

  const drivers = useMemo(() => {
    const withinHub = peers.filter(
      (p) => p.entity_type === 'driver' && p.scope_type === 'within_hub' && p.scope_key === hubId && p.kpi_id === 'pct_tardias_reparto'
    );
    if (withinHub.length > 0) return withinHub;
    return peers.filter(
      (p) => p.entity_type === 'driver' && p.scope_type === 'within_city' && p.scope_key === hubCityKey && p.kpi_id === 'pct_tardias_reparto'
    );
  }, [peers, hubId, hubCityKey]);

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
          const prev = thisWeek?.prev_week_value ?? null;
          const delta = formatDelta(value, prev, kpi.unit);
          const deltaCls = deltaClassForDirection(delta.isUp, kpi.direction);
          const peerVal = peerThis?.value ?? null;
          let z: 'good' | 'mid' | 'bad' | null = null;
          if (value !== null && peerVal !== null && peerVal !== 0) {
            const pctDiff = ((value - peerVal) / Math.abs(peerVal)) * 100;
            const wantsLow = kpi.direction === 'lower_is_better';
            const goodDiff = wantsLow ? pctDiff < -10 : pctDiff > 10;
            const badDiff  = wantsLow ? pctDiff > 10  : pctDiff < -10;
            z = goodDiff ? 'good' : badDiff ? 'bad' : 'mid';
          }
          const tileClass =
            z === 'good' ? 'border-emerald-200 bg-emerald-50' :
            z === 'bad'  ? 'border-red-200 bg-red-50' :
                           'border-[var(--line)] bg-white';
          const lineStroke = z === 'bad' ? '#ef4444' : z === 'good' ? '#10b981' : '#0ea5e9';
          const isFlipped = flippedTiles.has(kpi.id);

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
          const isMna = kpi.source_app_id === 'mna';
          const mnaForHub         = isMna ? mnaProducts.filter((p) => p.hub_id === hubId) : [];
          const mnaSortedByPct    = isMna ? [...mnaForHub].sort((a, b) => b.pct - a.pct)    : [];
          const mnaSortedByAmount = isMna ? [...mnaForHub].sort((a, b) => b.amount - a.amount) : [];

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
                        <LineChart data={trend.map((t) => ({ ...t }))}>
                          {peerVal !== null && (
                            <ReferenceLine y={peerVal} stroke="#94a3b8" strokeDasharray="2 2" />
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
                    <span>Peer: {formatValue(peerVal, kpi.unit)}</span>
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

                  {isMna ? (
                    /* ── MNA: two columns read directly from upload_rows ── */
                    mnaForHub.length === 0 ? (
                      <div className="text-[11px] text-[var(--muted)] text-center py-4 opacity-60">Sin datos MNA esta semana.</div>
                    ) : (
                      <div className="grid grid-cols-2 gap-x-3">
                        <MnaBackFaceList label="Peor %" items={mnaSortedByPct}    field="pct"    max={6} />
                        <MnaBackFaceList label="Peor $" items={mnaSortedByAmount} field="amount" max={6} />
                      </div>
                    )
                  ) : value === null ? (
                    /* ── No hub snapshot this week: don't show misleading city-level fallback ── */
                    <div className="text-[11px] text-[var(--muted)] text-center py-4 opacity-60">
                      Sin datos esta semana.
                    </div>
                  ) : !hasOps && !hasDrvs ? (
                    <div className="text-[11px] text-[var(--muted)] text-center py-4 opacity-60">
                      Sin datos para este KPI.
                    </div>
                  ) : hasOps && !hasDrvs ? (
                    /* ── Single column: only assembler data ── */
                    <BackFaceList label="Armadores" items={sortedOps} unit={kpi.unit} max={8} />
                  ) : !hasOps && hasDrvs ? (
                    /* ── Single column: only driver data ── */
                    <BackFaceList label="Repartidores" items={sortedDrvs} unit={kpi.unit} max={8} />
                  ) : (
                    /* ── Two columns: both operator and driver data ── */
                    <div className="grid grid-cols-2 gap-x-3">
                      <BackFaceList label="Armadores"    items={sortedOps}  unit={kpi.unit} max={5} />
                      <BackFaceList label="Repartidores" items={sortedDrvs} unit={kpi.unit} max={5} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Armador / Driver rank tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <RankList
          title={`Armadores · ${operators[0]?.scope_type === 'within_city' ? hub.city : hub.display_name} · Tasa de armado`}
          items={operators}
          unit="rate"
          subtitle={operators[0]?.scope_type === 'within_city' ? `Ciudad ${hub.city} · ordenados por tasa, mejor → peor` : 'Ordenados por tasa, mejor → peor'}
          highlightLowest
        />
        <RankList
          title={`Repartidores · ${drivers[0]?.scope_type === 'within_city' ? hub.city : hub.display_name} · % tardías`}
          items={drivers}
          unit="pct"
          subtitle={drivers[0]?.scope_type === 'within_city' ? `Ciudad ${hub.city} · ordenados por % tardías, mejor → peor` : 'Ordenados por % tardías, mejor → peor'}
          highlightHighest
        />
      </div>
    </div>
  );
}

/* ─── Back-face ranked list (worst → best, #1 = red, last shown = green) ─── */
function BackFaceList({ label, items, unit, max }: { label: string; items: Peer[]; unit: string; max: number }) {
  const shown = items.slice(0, max);
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

/* ─── MNA back-face list (reads directly from upload_rows aggregate) ─────── */
function MnaBackFaceList({ label, items, field, max }: {
  label: string;
  items: MnaProduct[];
  field: 'pct' | 'amount';
  max: number;
}) {
  const shown = items.slice(0, max);
  const unit = field === 'pct' ? 'pct' : 'currency';
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
            const val = field === 'pct' ? p.pct : p.amount;
            return (
              <div key={`${p.hub_id}|${p.producto}|${field}`} className="flex items-center justify-between gap-1">
                <div className="flex items-center gap-1 min-w-0">
                  <span className={`text-[9px] font-bold w-4 shrink-0 ${isWorst ? 'text-red-500' : isBest ? 'text-emerald-600' : 'text-slate-400'}`}>
                    {i + 1}
                  </span>
                  <span className="text-[10px] truncate">{p.producto}</span>
                </div>
                <span className="text-[10px] font-semibold shrink-0">{formatValue(val, unit)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RankList({
  title, items, unit, subtitle, highlightLowest, highlightHighest,
}: {
  title: string;
  items: Peer[];
  unit: string;
  subtitle: string;
  highlightLowest?: boolean;
  highlightHighest?: boolean;
}) {
  const sorted = [...items].sort((a, b) => {
    if (highlightLowest) return (b.value ?? 0) - (a.value ?? 0);
    return (a.value ?? 0) - (b.value ?? 0);
  });
  return (
    <div className="bg-white border border-[var(--line)] rounded-xl shadow-soft overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--line)]">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <p className="text-[10.5px] text-[var(--muted)]">{subtitle}</p>
      </div>
      {sorted.length === 0 ? (
        <div className="p-6 text-center text-[12px] text-[var(--muted)]">Sin datos esta semana.</div>
      ) : (
        <table className="w-full text-[12px]">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-[var(--muted)] font-bold">
            <tr>
              <th className="px-4 py-1.5 text-left">#</th>
              <th className="px-4 py-1.5 text-left">Nombre</th>
              <th className="px-4 py-1.5 text-right">Valor</th>
              <th className="px-4 py-1.5 text-right">z</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 50).map((p, i) => {
              const isWorst = i === sorted.length - 1;
              const isBest  = i === 0;
              return (
                <tr key={p.entity_key} className={`border-t border-slate-100 ${isWorst ? 'bg-red-50' : isBest ? 'bg-emerald-50' : ''}`}>
                  <td className="px-4 py-1.5 text-[var(--muted)] font-bold">{p.rank ?? i + 1}</td>
                  <td className="px-4 py-1.5">{p.entity_key}</td>
                  <td className="px-4 py-1.5 text-right font-semibold">{formatValue(p.value, unit)}</td>
                  <td className="px-4 py-1.5 text-right text-[var(--muted)] font-mono text-[11px]">{p.z_score === null ? '—' : p.z_score.toFixed(1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
