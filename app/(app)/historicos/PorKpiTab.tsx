'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import {
  HUB_COLORS, formatValue, formatDelta, weekEndLabel, weekEndLabelLong,
  deltaClassForDirection, zToHeatmapClass,
  type Kpi, type Hub, type Snapshot, type Peer,
} from './_shared';

// Custom tooltip that re-sorts hubs by the hovered week's value (highest → lowest).
// This way the legend order matches the tooltip order for every week, not just currentWeek.
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
      {sorted.map((p) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-3 py-0.5">
          <div className="flex items-center gap-1.5">
            <span style={{ color: p.stroke }} className="text-[10px]">●</span>
            <span className="text-slate-700">{hubs.find((h) => h.id === p.dataKey)?.display_name ?? p.dataKey}</span>
          </div>
          <span className="font-semibold tabular-nums">{formatValue(p.value == null ? null : Number(p.value), unit)}</span>
        </div>
      ))}
    </div>
  );
}

interface Props {
  kpis: Kpi[];
  hubs: Hub[];
  snapshots: Snapshot[];
  peers: Peer[];
  roles: { id: string; name_es: string }[];
  currentWeek: string;
  selectedKpi?: string;
}

export function PorKpiTab({ kpis, hubs, snapshots, currentWeek, selectedKpi }: Props) {
  const router = useRouter();

  const defaultKpi = kpis.find((k) => k.watched_globally)?.id ?? kpis[0]?.id;
  const kpiId = selectedKpi || defaultKpi;
  const kpi = kpis.find((k) => k.id === kpiId);

  // -1 = YTD, otherwise number of weeks to show
  const [weeksShown, setWeeksShown] = useState(5);

  if (!kpi) return <p className="text-[var(--muted)]">No hay KPIs configurados.</p>;

  function pickKpi(id: string) {
    router.push(`/historicos?tab=kpi&kpi=${id}`);
  }

  // ------------------------------ Top movers (all KPIs, biggest WoW) -------
  const topMovers = useMemo(() => {
    // All KPIs, not just watched — user wants to see the biggest absolute changes
    const thisWeekHub = snapshots.filter(
      (s) => s.week_start === currentWeek && s.scope_level === 'hub' && s.value !== null && s.prev_week_value !== null
    );
    const enriched = thisWeekHub.map((s) => {
      const kp = kpis.find((k) => k.id === s.kpi_id)!;
      const isPct = kp.unit === 'pct';
      const delta = isPct
        ? (s.value! - s.prev_week_value!) * 100
        : ((s.value! - s.prev_week_value!) / Math.abs(s.prev_week_value!)) * 100;
      return { snap: s, kpi: kp, delta, absDelta: Math.abs(delta) };
    });
    enriched.sort((a, b) => b.absDelta - a.absDelta);
    return enriched.slice(0, 5);
  }, [snapshots, kpis, currentWeek]);

  // ------------------------------ Chart data ------------------------------
  const allChartData = useMemo(() => {
    const byWeek = new Map<string, Record<string, any>>();
    for (const s of snapshots) {
      if (s.kpi_id !== kpi.id) continue;
      if (s.scope_level !== 'hub' || !s.scope_key) continue;
      if (!byWeek.has(s.week_start)) {
        byWeek.set(s.week_start, { week: weekEndLabel(s.week_start), _iso: s.week_start });
      }
      byWeek.get(s.week_start)![s.scope_key] = s.value === null ? null : Number(s.value);
    }
    // For count KPIs a missing row means 0 (no incidents), not unknown — fill so the chart plots 0 instead of a gap.
  if (kpi.unit === 'count') {
    for (const weekData of byWeek.values()) {
      for (const h of hubs) {
        if (!(h.id in weekData)) weekData[h.id] = 0;
      }
    }
  }
  return [...byWeek.values()].sort((a, b) => (a._iso > b._iso ? 1 : a._iso < b._iso ? -1 : 0));
}, [snapshots, kpi.id, kpi.unit, hubs]);

  const chartData = useMemo(() => {
    let filtered = allChartData;
    if (weeksShown === -1) {
      // YTD: from Jan 1 of the current year
      const yearStart = `${currentWeek.slice(0, 4)}-01-01`;
      filtered = allChartData.filter((d) => d._iso >= yearStart);
    } else {
      filtered = allChartData.slice(-weeksShown);
    }
    return filtered.map(({ _iso, ...rest }) => rest);
  }, [allChartData, weeksShown, currentWeek]);

  // Peer mean from global snapshots
  const peerMeanThisWeek = useMemo(() => {
    const g = snapshots.find((s) => s.kpi_id === kpi.id && s.week_start === currentWeek && s.scope_level === 'global');
    return g?.value ?? null;
  }, [snapshots, kpi.id, currentWeek]);

  // ------------------------------ Heatmap pivot ------------------------------
  const heatmapData = useMemo(() => {
    const weeks = [...new Set(snapshots.filter((s) => s.kpi_id === kpi.id).map((s) => s.week_start))]
      .sort((a, b) => (a > b ? -1 : 1));
    const cells: Record<string, Record<string, { value: number | null; z: number | null }>> = {};
    for (const h of hubs) cells[h.id] = {};
    for (const wk of weeks) {
      const hubVals: Array<{ hubId: string; v: number }> = [];
      for (const s of snapshots) {
        if (s.kpi_id !== kpi.id || s.week_start !== wk || s.scope_level !== 'hub' || !s.scope_key || s.value === null) continue;
        hubVals.push({ hubId: s.scope_key, v: Number(s.value) });
      }
      const mean = hubVals.length > 0 ? hubVals.reduce((a, b) => a + b.v, 0) / hubVals.length : 0;
      const variance = hubVals.length > 1 ? hubVals.reduce((a, b) => a + (b.v - mean) ** 2, 0) / (hubVals.length - 1) : 0;
      const std = Math.sqrt(variance);
      for (const { hubId, v } of hubVals) {
        if (!cells[hubId]) continue; // skip hub IDs in snapshots that aren't in the hubs list
        cells[hubId][wk] = { value: v, z: std > 0 ? (v - mean) / std : null };
      }
    }
    return { weeks, cells };
  }, [snapshots, kpi.id, hubs]);

  // Hubs sorted by current week value — drives both the chart legend order and the
  // heatmap rows so the highest/lowest performing hub is always first visually.
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
      // Always highest value first — matches top-to-bottom visual order on the chart
      return bv - av;
    });
  }, [hubs, snapshots, kpi.id, kpi.direction, currentWeek]);

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
              Peer mean: <b className="text-[var(--ink)]">{formatValue(peerMeanThisWeek, kpi.unit)}</b>
            </span>
          )}
        </div>
      </div>

      {/* Main chart */}
      <div className="bg-white border border-[var(--line)] rounded-xl p-5 shadow-soft">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
          <h3 className="text-[15px] font-semibold">{kpi.name_es} · por micro-hub</h3>
          {/* Timeline selector */}
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
          Línea por hub. Línea punteada = peer mean global esta semana.
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
                formatter={(value: string) => hubs.find((h) => h.id === value)?.display_name ?? value}
                wrapperStyle={{ fontSize: 11 }}
              />
              {peerMeanThisWeek !== null && (
                <ReferenceLine y={peerMeanThisWeek} stroke="#94a3b8" strokeDasharray="4 4" label={{ value: 'peer mean', position: 'right', fill: '#64748b', fontSize: 10 }} />
              )}
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

      {/* Heatmap pivot */}
      <div className="bg-white border border-[var(--line)] rounded-xl shadow-soft overflow-hidden">
        <div className="px-5 py-3 border-b border-[var(--line)]">
          <h3 className="text-[14px] font-semibold">Heatmap · semana × hub · color = z-score vs peers de la semana</h3>
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
                  <td className="px-5 py-2 font-semibold">{h.display_name}<span className="text-[10px] text-[var(--muted)] ml-2">{h.city}</span></td>
                  {heatmapData.weeks.slice(0, 8).map((wk) => {
                    const cell = heatmapData.cells[h.id]?.[wk];
                    const cls = zToHeatmapClass(cell?.z ?? null, kpi.direction);
                    return (
                      <td key={wk} className={`px-3 py-2 text-right font-mono text-[11.5px] ${cls}`}>
                        {cell?.value !== undefined && cell?.value !== null ? formatValue(cell.value, kpi.unit) : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-2 text-[10.5px] text-[var(--muted)] border-t border-slate-100">
          Verde = z-score "bueno" (vs el promedio de los hubs en esa semana, ajustado por dirección del KPI). Rojo = malo.
        </div>
      </div>
    </div>
  );
}
