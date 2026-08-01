'use client';
import { useMemo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import {
  HUB_COLORS, formatValue, formatDelta, weekEndLabel, weekEndLabelLong,
  deltaClassForDirection, resolveTarget, isResumenKpi,
  type Kpi, type Hub, type Snapshot, type Peer, type KpiTarget,
} from './_shared';

// ─── Chart tooltip ────────────────────────────────────────────────────────────
function ChartTooltip({
  active, payload, label, unit, hubs,
}: {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number | null; stroke: string }>;
  label?: string;
  unit: string;
  hubs: Hub[];
}) {
  if (!active || !payload?.length) return null;
  const sorted = [...payload]
    .filter((p) => p.value != null)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 shadow-lg text-[12px] min-w-[180px]">
      <div className="font-semibold text-[var(--ink)] mb-1.5">{label}</div>
      {sorted.map((p) => {
        const isGlobal = p.dataKey === '__global__';
        const name = isGlobal ? 'Media global' : (hubs.find((h) => h.id === p.dataKey)?.display_name ?? p.dataKey);
        return (
          <div key={p.dataKey} className="flex items-center justify-between gap-3 py-0.5">
            <div className="flex items-center gap-1.5">
              <span style={{ color: p.stroke }} className="text-[10px]">{isGlobal ? '- -' : '●'}</span>
              <span className={`${isGlobal ? 'text-slate-500 italic' : 'text-slate-700'}`}>{name}</span>
            </div>
            <span className="font-semibold tabular-nums">{formatValue(p.value == null ? null : Number(p.value), unit)}</span>
          </div>
        );
      })}
    </div>
  );
}

interface Props {
  kpis: Kpi[];
  hubs: Hub[];
  snapshots: Snapshot[];
  peers: Peer[];
  roles: { id: string; name_es: string }[];
  targets: KpiTarget[];
  currentWeek: string;
  selectedKpi?: string;
  /** Called when the user picks a different KPI. Parent owns the state. */
  onKpiChange?: (id: string) => void;
}

export function PorKpiTab({ kpis, hubs, snapshots, currentWeek, selectedKpi, onKpiChange, targets = [] }: Props) {
  const defaultKpi = kpis.find((k) => k.watched_globally)?.id ?? kpis[0]?.id;
  const kpiId = selectedKpi || defaultKpi;
  const kpi = kpis.find((k) => k.id === kpiId);

  const [weeksShown, setWeeksShown] = useState(5);

  if (!kpi) return <p className="text-[var(--muted)]">No hay KPIs configurados.</p>;

  // Instant client-side KPI switch — no server round-trip.
  function pickKpi(id: string) {
    onKpiChange?.(id);
  }

  // ── Top movers ──────────────────────────────────────────────────────────────
  const topMovers = useMemo(() => {
    const thisWeekHub = snapshots.filter(
      (s) => s.week_start === currentWeek && s.scope_level === 'hub' && s.value !== null && s.prev_week_value !== null
    );
    const enriched = thisWeekHub
      .map((s) => {
        const kp = kpis.find((k) => k.id === s.kpi_id)!;
        const isPct = kp.unit === 'pct';
        const delta = isPct
          ? (s.value! - s.prev_week_value!) * 100
          : ((s.value! - s.prev_week_value!) / Math.abs(s.prev_week_value!)) * 100;
        return { snap: s, kpi: kp, delta, absDelta: Math.abs(delta) };
      })
      // Volume/headcount KPIs (Resumen operativo) swing far harder in relative
      // terms than any quality pct — excluded here only, so they still get a
      // selector entry + heatmap row like every other KPI.
      .filter((e) => !isResumenKpi(e.kpi));
    enriched.sort((a, b) => b.absDelta - a.absDelta);
    return enriched.slice(0, 5);
  }, [snapshots, kpis, currentWeek]);

  // ── Chart data (hub lines + global mean line) ───────────────────────────────
  const allChartData = useMemo(() => {
    const byWeek = new Map<string, Record<string, any>>();

    for (const s of snapshots) {
      if (s.kpi_id !== kpi.id) continue;

      if (s.scope_level === 'hub' && s.scope_key) {
        if (!byWeek.has(s.week_start))
          byWeek.set(s.week_start, { week: weekEndLabel(s.week_start), _iso: s.week_start });
        byWeek.get(s.week_start)![s.scope_key] = s.value === null ? null : Number(s.value);
      } else if (s.scope_level === 'global') {
        if (!byWeek.has(s.week_start))
          byWeek.set(s.week_start, { week: weekEndLabel(s.week_start), _iso: s.week_start });
        byWeek.get(s.week_start)!['__global__'] = s.value === null ? null : Number(s.value);
      }
    }

    if (kpi.unit === 'count') {
      for (const weekData of byWeek.values()) {
        for (const h of hubs) {
          if (!(h.id in weekData)) weekData[h.id] = 0;
        }
      }
    }

    // For count and currency KPIs the DB-stored global was historically written
    // as the raw sum of all entity values, not the mean of hub totals. Old weeks
    // won't be corrected by a single recompute. Recompute the global client-side
    // as mean of hub values so every week shows the right reference line,
    // regardless of when (or whether) those weeks were recomputed.
    // pct and rate keep the DB global (correct weighted sum: Σnum/Σden).
    if (kpi.unit === 'count' || kpi.unit === 'currency') {
      for (const weekData of byWeek.values()) {
        const hubVals = hubs
          .map((h) => weekData[h.id])
          .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
        weekData['__global__'] = hubVals.length > 0
          ? hubVals.reduce((a, b) => a + b, 0) / hubVals.length
          : null;
      }
    }

    return [...byWeek.values()].sort((a, b) => (a._iso > b._iso ? 1 : a._iso < b._iso ? -1 : 0));
  }, [snapshots, kpi.id, kpi.unit, hubs]);

  const chartData = useMemo(() => {
    let filtered = allChartData;
    if (weeksShown === -1) {
      const yearStart = `${currentWeek.slice(0, 4)}-01-01`;
      filtered = allChartData.filter((d) => d._iso >= yearStart);
    } else {
      filtered = allChartData.slice(-weeksShown);
    }
    return filtered.map(({ _iso, ...rest }) => rest);
  }, [allChartData, weeksShown, currentWeek]);

  // For the toolbar "Media global esta sem" badge, use the same client-side
  // mean for count/currency so it matches the chart reference line.
  const peerMeanThisWeek = useMemo(() => {
    if (kpi.unit === 'count' || kpi.unit === 'currency') {
      const hubVals = hubs
        .map((h) => snapshots.find(
          (s) => s.kpi_id === kpi.id && s.week_start === currentWeek && s.scope_level === 'hub' && s.scope_key === h.id
        )?.value)
        .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(Number(v)))
        .map(Number);
      return hubVals.length > 0
        ? hubVals.reduce((a, b) => a + b, 0) / hubVals.length
        : null;
    }
    const g = snapshots.find((s) => s.kpi_id === kpi.id && s.week_start === currentWeek && s.scope_level === 'global');
    return g?.value ?? null;
  }, [snapshots, kpi.id, kpi.unit, hubs, currentWeek]);

  // ── Heatmap: value + WoW delta, cell color = absolute vs own 4w baseline ───
  const heatmapData = useMemo(() => {
    const weeks = [...new Set(
      snapshots.filter((s) => s.kpi_id === kpi.id && s.scope_level === 'hub').map((s) => s.week_start)
    )].sort((a, b) => (a > b ? -1 : 1)); // most recent first

    // Pre-sort hub values chronologically for σ computation
    const hubChronological = new Map<string, Array<{ week: string; value: number | null }>>();
    for (const h of hubs) hubChronological.set(h.id, []);
    for (const s of snapshots) {
      if (s.kpi_id !== kpi.id || s.scope_level !== 'hub' || !s.scope_key) continue;
      const arr = hubChronological.get(s.scope_key);
      if (arr) arr.push({ week: s.week_start, value: s.value === null ? null : Number(s.value) });
    }
    for (const [, arr] of hubChronological) arr.sort((a, b) => (a.week > b.week ? 1 : -1));

    const cells: Record<string, Record<string, {
      value: number | null;
      deltaDisplay: number | null; // WoW delta in display units (pp for pct)
      deltaGood: boolean | null;   // true = improvement, false = worse, null = flat/no data
      bgClass: string;
    }>> = {};

    for (const h of hubs) cells[h.id] = {};

    for (const wk of weeks) {
      for (const h of hubs) {
        const snap = snapshots.find(
          (s) => s.kpi_id === kpi.id && s.week_start === wk && s.scope_level === 'hub' && s.scope_key === h.id
        );

        if (!snap || snap.value === null) {
          cells[h.id][wk] = { value: null, deltaDisplay: null, deltaGood: null, bgClass: '' };
          continue;
        }

        const value = Number(snap.value);
        const hubVals = hubChronological.get(h.id) ?? [];
        const wkIdx   = hubVals.findIndex((v) => v.week === wk);

        // Prior values from chronological array — more reliable than DB prev_week_value
        // which is only populated for the most recent weeks.
        const priorVals = hubVals
          .slice(Math.max(0, wkIdx - 4), wkIdx)
          .map((v) => v.value)
          .filter((v): v is number => v !== null);

        // WoW delta: use adjacent chronological value, not snap.prev_week_value
        const prevVal = wkIdx > 0 ? hubVals[wkIdx - 1]?.value ?? null : null;
        let deltaDisplay: number | null = null;
        let deltaGood: boolean | null = null;
        if (prevVal !== null) {
          const rawDiff = value - prevVal;
          deltaDisplay = kpi.unit === 'pct' ? rawDiff * 100 : rawDiff;
          const isFlat = Math.abs(rawDiff) < 0.00001;
          if (!isFlat) {
            deltaGood = kpi.direction === 'lower_is_better' ? rawDiff < 0 : rawDiff > 0;
          }
        }

        // Cell background: absolute value vs hub's own 4w rolling mean (σ-based).
        // Use DB rolling_mean_4w if available; otherwise compute from chronological array.
        const mean4w = snap.rolling_mean_4w !== null
          ? Number(snap.rolling_mean_4w)
          : priorVals.length > 0
            ? priorVals.reduce((a, b) => a + b, 0) / priorVals.length
            : null;

        let bgClass = '';
        if (mean4w !== null) {
          const wantsLow = kpi.direction === 'lower_is_better';
          const diff = value - mean4w;

          if (priorVals.length >= 2) {
            const mu       = priorVals.reduce((a, b) => a + b, 0) / priorVals.length;
            const variance = priorVals.reduce((a, b) => a + (b - mu) ** 2, 0) / priorVals.length;
            const sigma    = Math.sqrt(variance);
            if (sigma > 0) {
              const sigmas = diff / sigma;
              const T = 0.75;
              if (wantsLow ? sigmas < -T : sigmas > T) bgClass = 'bg-emerald-50';
              else if (wantsLow ? sigmas > T : sigmas < -T) bgClass = 'bg-red-50';
            }
          }

          // Fallback: ±5% relative (works even with just 1 prior week)
          if (!bgClass && mean4w !== 0) {
            const pctDiff = (diff / Math.abs(mean4w)) * 100;
            const PCT = 5;
            if (wantsLow ? pctDiff < -PCT : pctDiff > PCT) bgClass = 'bg-emerald-50';
            else if (wantsLow ? pctDiff > PCT : pctDiff < -PCT) bgClass = 'bg-red-50';
          }
        }

        cells[h.id][wk] = { value, deltaDisplay, deltaGood, bgClass };
      }
    }

    return { weeks, cells };
  }, [snapshots, kpi.id, kpi.unit, kpi.direction, hubs]);


  // Target reference line — global target only (spec: start with the global
  // line to keep the chart readable; per-hub overrides get a small note
  // instead of one line per hub). resolveTarget(kpi.id, null, targets)
  // skips the hub-lookup branch and returns the global row directly.
  const globalTarget = useMemo(() => resolveTarget(kpi.id, null, targets), [kpi.id, targets]);
  const targetDbUnits = globalTarget
    ? (globalTarget.unit === 'pct' ? globalTarget.target_value / 100 : globalTarget.target_value)
    : null;
  const hubOverrideCount = useMemo(
    () => targets.filter((t) => t.active && t.kpi_id === kpi.id && t.scope_level === 'hub').length,
    [targets, kpi.id],
  );

  // Hubs sorted by current week value
  const sortedHubsByValue = useMemo(() => {
    return [...hubs].sort((a, b) => {
      const av = snapshots.find(
        (s) => s.kpi_id === kpi.id && s.scope_level === 'hub' && s.scope_key === a.id && s.week_start === currentWeek
      )?.value ?? null;
      const bv = snapshots.find(
        (s) => s.kpi_id === kpi.id && s.scope_level === 'hub' && s.scope_key === b.id && s.week_start === currentWeek
      )?.value ?? null;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    });
  }, [hubs, snapshots, kpi.id, currentWeek]);

  return (
    <div className="space-y-4">
      {/* Top movers */}
      {topMovers.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {topMovers.map(({ snap, kpi: mk, delta }, i) => {
            const isUp = delta > 0;
            const wantsUp = mk.direction === 'higher_is_better';
            const good = wantsUp ? isUp : !isUp;
            const hub = hubs.find((h) => h.id === snap.scope_key);
            return (
              <button
                key={i}
                onClick={() => pickKpi(mk.id)}
                className="text-left bg-white border border-[var(--line)] rounded-xl px-3 py-2.5 shadow-soft hover:border-black"
              >
                <div className="text-[10px] uppercase tracking-wide text-[var(--muted)] font-bold truncate">{mk.name_es}</div>
                <div className="text-[11px] text-[var(--ink-2)] truncate">{hub?.display_name ?? snap.scope_key}</div>
                <div className="flex items-baseline justify-between mt-1.5">
                  <div className="text-[18px] font-bold">{formatValue(snap.value, mk.unit)}</div>
                  <div className={`text-[11px] font-bold ${good ? 'text-emerald-600' : 'text-red-600'}`}>
                    {delta > 0 ? '+' : ''}{delta.toFixed(1)}{mk.unit === 'pct' ? 'pp' : '%'}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* KPI selector toolbar */}
      <div className="bg-white border border-[var(--line)] rounded-xl p-4 shadow-soft">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[11px] uppercase tracking-wide text-[var(--muted)] font-bold">KPI:</span>
          <select
            value={kpi.id}
            onChange={(e) => pickKpi(e.target.value)}
            className="border border-[var(--line)] rounded-md px-3 py-1.5 text-[13px] font-semibold bg-white"
          >
            {kpis.map((k) => (
              <option key={k.id} value={k.id}>
                {k.parent_kpi_id ? '↳ ' : ''}{k.name_es}
              </option>
            ))}
          </select>
          <span className="text-[11px] uppercase tracking-wide text-[var(--muted)] font-bold">{kpi.unit}</span>
          <span className="text-[11px] text-[var(--muted)]">
            {kpi.direction === 'lower_is_better' ? '↓ menor mejor' : '↑ mayor mejor'} · {kpi.category}
          </span>
          {kpi.watched_globally && (
            <span className="text-[10px] bg-teal-100 text-teal-800 px-1.5 py-0.5 rounded font-bold">en home</span>
          )}
          {peerMeanThisWeek !== null && (
            <span className="ml-auto text-[11.5px] text-[var(--muted)]">
              Media global esta sem: <b className="text-[var(--ink)]">{formatValue(peerMeanThisWeek, kpi.unit)}</b>
            </span>
          )}
        </div>
      </div>

      {/* Main chart — hub lines + global mean trend */}
      <div className="bg-white border border-[var(--line)] rounded-xl p-5 shadow-soft">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
          <h3 className="text-[15px] font-semibold">{kpi.name_es} · por micro-hub</h3>
          <div className="flex items-center gap-1">
            {([
              { label: '5 sem', value: 5 },
              { label: '3 m',   value: 13 },
              { label: '6 m',   value: 26 },
              { label: '1 a',   value: 52 },
              { label: 'YTD',   value: -1 },
            ] as const).map(({ label, value }) => (
              <button
                key={value}
                onClick={() => setWeeksShown(value)}
                className={`px-2 py-0.5 rounded text-[11px] font-medium border ${
                  weeksShown === value
                    ? 'bg-black text-white border-black'
                    : 'bg-white text-slate-500 border-[var(--line)] hover:border-slate-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[12px] text-[var(--muted)] mb-3">
          Línea sólida por hub · línea punteada gris = media global histórica
          {targetDbUnits != null && (
            <>
              {' · '}
              <span className="text-teal-700">línea punteada verde = meta ({formatValue(targetDbUnits, kpi.unit)})</span>
              {hubOverrideCount > 0 && (
                <span className="text-[var(--muted)]"> — {hubOverrideCount} hub{hubOverrideCount > 1 ? 's' : ''} con meta distinta, ver /config</span>
              )}
            </>
          )}
        </p>
        {chartData.length === 0 ? (
          <div className="border border-dashed border-[var(--line)] rounded-md p-10 text-center text-[var(--muted)] text-[13px]">
            Sin datos para este KPI. Sube los CSVs y corre Recomputar.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={chartData} margin={{ top: 12, right: 24, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="week" tick={{ fontSize: 11, fill: '#6b7280' }} />
              <YAxis
                tick={{ fontSize: 11, fill: '#6b7280' }}
                domain={['auto', 'auto']}
                tickFormatter={(v: any) => formatValue(Number(v), kpi.unit)}
                width={70}
              />
              <Tooltip
                content={(props: any) => (
                  <ChartTooltip {...props} unit={kpi.unit} hubs={hubs} />
                )}
              />
              <Legend
                formatter={(value: string) =>
                  value === '__global__'
                    ? 'Media global'
                    : hubs.find((h) => h.id === value)?.display_name ?? value
                }
                wrapperStyle={{ fontSize: 11 }}
              />
              {/* Configured target — global row only, see hubOverrideCount note above */}
              {targetDbUnits != null && (
                <ReferenceLine
                  y={targetDbUnits}
                  stroke="#0d9488"
                  strokeDasharray="4 2"
                  strokeWidth={1.3}
                  label={{ value: 'meta', position: 'insideTopLeft', fontSize: 10, fill: '#0d9488' }}
                />
              )}
              {/* Global mean trend line */}
              <Line
                key="__global__"
                type="monotone"
                dataKey="__global__"
                stroke="#94a3b8"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                dot={false}
                connectNulls
              />
              {/* Hub lines */}
              {sortedHubsByValue.map((h) => (
                <Line
                  key={h.id}
                  type="monotone"
                  dataKey={h.id}
                  stroke={HUB_COLORS[h.id] ?? '#94a3b8'}
                  strokeWidth={1.8}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Heatmap — value + WoW delta, color = absolute vs own 4w baseline */}
      <div className="bg-white border border-[var(--line)] rounded-xl shadow-soft overflow-hidden">
        <div className="px-5 py-3 border-b border-[var(--line)]">
          <h3 className="text-[14px] font-semibold">Heatmap · semana × hub</h3>
          <p className="text-[11px] text-[var(--muted)] mt-0.5">
            Valor de la semana + delta WoW · color = valor vs promedio propio 4 semanas
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead className="bg-slate-50 text-[10.5px] uppercase tracking-wide text-[var(--muted)] font-bold">
              <tr>
                <th className="px-5 py-2 text-left">Hub</th>
                {heatmapData.weeks.slice(0, 8).map((wk) => (
                  <th key={wk} className="px-3 py-2 text-right" title={weekEndLabelLong(wk)}>
                    jue {weekEndLabel(wk)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedHubsByValue.map((h) => (
                <tr key={h.id} className="border-t border-slate-100">
                  <td className="px-5 py-2 font-semibold">
                    {h.display_name}
                    <span className="text-[10px] text-[var(--muted)] ml-2">{h.city}</span>
                  </td>
                  {heatmapData.weeks.slice(0, 8).map((wk) => {
                    const cell = heatmapData.cells[h.id]?.[wk];
                    return (
                      <td key={wk} className={`px-3 py-1.5 text-right ${cell?.bgClass ?? ''}`}>
                        {cell?.value !== null && cell?.value !== undefined ? (
                          <>
                            <div className="font-mono text-[11.5px] font-semibold">
                              {formatValue(cell.value, kpi.unit)}
                            </div>
                            {cell.deltaDisplay !== null ? (
                              <div className={`text-[9.5px] font-mono ${
                                cell.deltaGood === true  ? 'text-emerald-600' :
                                cell.deltaGood === false ? 'text-red-500' :
                                'text-[var(--muted)]'
                              }`}>
                                {cell.deltaDisplay > 0 ? '+' : ''}
                                {kpi.unit === 'pct'
                                  ? `${cell.deltaDisplay.toFixed(1)}pp`
                                  : cell.deltaDisplay.toFixed(kpi.unit === 'rate' ? 1 : 0)}
                              </div>
                            ) : (
                              <div className="text-[9.5px] text-[var(--muted)]">—</div>
                            )}
                          </>
                        ) : (
                          <div className="font-mono text-[11.5px] text-[var(--muted)]">—</div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-2 text-[10.5px] text-[var(--muted)] border-t border-slate-100">
          Verde = por encima de su propio promedio 4w · Rojo = por debajo · Delta WoW: verde = mejora, rojo = empeora
        </div>
      </div>

    </div>
  );
}
