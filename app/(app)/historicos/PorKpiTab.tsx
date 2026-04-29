'use client';

import { useMemo } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import {
  HUB_COLORS, formatValue, formatDelta, weekEndLabel, weekEndLabelLong,
  deltaClassForDirection, zToHeatmapClass, groupBy,
  type Kpi, type Hub, type Snapshot, type Peer,
} from './_shared';

interface Props {
  kpis: Kpi[];
  hubs: Hub[];
  snapshots: Snapshot[];
  peers: Peer[];
  roles: { id: string; name_es: string }[];
  currentWeek: string;
  selectedKpi?: string;
}

export function PorKpiTab({ kpis, hubs, snapshots, peers, roles, currentWeek, selectedKpi }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const defaultKpi = kpis.find((k) => k.watched_globally)?.id ?? kpis[0]?.id;
  const kpiId = selectedKpi || defaultKpi;
  const kpi = kpis.find((k) => k.id === kpiId);
  const roleById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);

  if (!kpi) return <p className="text-[var(--muted)]">No hay KPIs configurados.</p>;

  function pickKpi(id: string) {
    const params = new URLSearchParams(sp);
    params.set('kpi', id);
    router.push(`${pathname}?${params.toString()}`);
  }

  // ------------------------------ Top movers ------------------------------
  // Across all watched KPIs at hub level: biggest |WoW deltas| this week.
  const topMovers = useMemo(() => {
    const watchedIds = new Set(kpis.filter((k) => k.watched_globally).map((k) => k.id));
    const thisWeekHub = snapshots.filter(
      (s) => s.week_start === currentWeek && s.scope_level === 'hub' && watchedIds.has(s.kpi_id) && s.value !== null && s.prev_week_value !== null
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
  const chartData = useMemo(() => {
    const byWeek = new Map<string, Record<string, any>>();
    for (const s of snapshots) {
      if (s.kpi_id !== kpi.id) continue;
      if (s.scope_level !== 'hub' || !s.scope_key) continue;
      if (!byWeek.has(s.week_start)) {
        byWeek.set(s.week_start, { week: weekEndLabel(s.week_start), _iso: s.week_start });
      }
      byWeek.get(s.week_start)![s.scope_key] = s.value === null ? null : Number(s.value);
    }
    return [...byWeek.values()]
      .sort((a, b) => (a._iso > b._iso ? 1 : a._iso < b._iso ? -1 : 0))
      .map(({ _iso, ...rest }) => rest);
  }, [snapshots, kpi.id]);

  // Peer mean from global snapshots
  const peerMeanThisWeek = useMemo(() => {
    const g = snapshots.find((s) => s.kpi_id === kpi.id && s.week_start === currentWeek && s.scope_level === 'global');
    return g?.value ?? null;
  }, [snapshots, kpi.id, currentWeek]);

  // ------------------------------ Per-entity drill ------------------------------
  // Use peer_comparisons within_hub for operator/driver level visibility.
  const drillEntities = useMemo(() => {
    const entityType = ['tasa_armado', 'pct_armado_tardio', 'incidentes_manuales_pct', 'incidentes_calidad_pct',
      'incidentes_faltantes_pct', 'incidentes_faltantes_completos_pct', 'incidentes_faltantes_parciales_pct'].includes(kpi.id) ? 'operator' :
      ['pct_tardias_reparto', 'pct_undelivered', 'eggs_issue_rate'].includes(kpi.id) ? 'driver' : null;
    if (!entityType) return null;
    return peers
      .filter((p) => p.kpi_id === kpi.id && p.entity_type === entityType && p.scope_type === 'within_hub' && p.value !== null)
      .sort((a, b) => {
        // worst first (depends on direction)
        if (kpi.direction === 'lower_is_better') return (b.value ?? 0) - (a.value ?? 0);
        return (a.value ?? 0) - (b.value ?? 0);
      });
  }, [peers, kpi]);

  // ------------------------------ Heatmap pivot ------------------------------
  const heatmapData = useMemo(() => {
    const weeks = [...new Set(snapshots.filter((s) => s.kpi_id === kpi.id).map((s) => s.week_start))]
      .sort((a, b) => (a > b ? -1 : 1)); // most recent first
    const cells: Record<string, Record<string, { value: number | null; z: number | null }>> = {};
    for (const h of hubs) cells[h.id] = {};
    // Compute z-scores per week using std dev across hubs
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
        cells[hubId][wk] = { value: v, z: std > 0 ? (v - mean) / std : null };
      }
    }
    return { weeks, cells };
  }, [snapshots, kpi.id, hubs]);

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
        <h3 className="text-[15px] font-semibold mb-1">{kpi.name_es} · por micro-hub · 12 sem</h3>
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
                formatter={(v: any, name: string) => [
                  v == null ? '—' : formatValue(Number(v), kpi.unit),
                  hubs.find((h) => h.id === name)?.display_name ?? name,
                ]}
                contentStyle={{ fontSize: 12 }}
              />
              <Legend
                formatter={(value: string) => hubs.find((h) => h.id === value)?.display_name ?? value}
                wrapperStyle={{ fontSize: 11 }}
              />
              {peerMeanThisWeek !== null && (
                <ReferenceLine y={peerMeanThisWeek} stroke="#94a3b8" strokeDasharray="4 4" label={{ value: 'peer mean', position: 'right', fill: '#64748b', fontSize: 10 }} />
              )}
              {hubs.map((h) => (
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

      {/* Per-entity drill table */}
      {drillEntities && drillEntities.length > 0 && (
        <div className="bg-white border border-[var(--line)] rounded-xl shadow-soft overflow-hidden">
          <div className="px-5 py-3 border-b border-[var(--line)]">
            <h3 className="text-[14px] font-semibold">Acercamiento por entidad · esta sem.</h3>
            <p className="text-[11.5px] text-[var(--muted)]">
              {drillEntities[0].entity_type === 'operator' ? 'Armadores' : 'Repartidores'} ordenados peor → mejor (según dirección del KPI).
            </p>
          </div>
          <table className="w-full text-[12.5px]">
            <thead className="bg-slate-50 text-[10.5px] uppercase tracking-wide text-[var(--muted)] font-bold">
              <tr>
                <th className="px-5 py-2 text-left">Rank</th>
                <th className="px-5 py-2 text-left">{drillEntities[0].entity_type === 'operator' ? 'Armador ID' : 'Repartidor ID'}</th>
                <th className="px-5 py-2 text-left">Hub</th>
                <th className="px-5 py-2 text-right">Valor</th>
                <th className="px-5 py-2 text-right">Peer mean</th>
                <th className="px-5 py-2 text-right">z-score</th>
                <th className="px-5 py-2 text-right">Posición</th>
              </tr>
            </thead>
            <tbody>
              {drillEntities.slice(0, 25).map((p) => {
                const hub = hubs.find((h) => h.id === p.scope_key);
                const z = p.z_score ?? 0;
                const flip = kpi.direction === 'higher_is_better' ? -1 : 1;
                const adj = z * flip;
                const rowClass = adj >= 1.5 ? 'bg-red-50' : adj <= -1.5 ? 'bg-emerald-50' : '';
                return (
                  <tr key={`${p.entity_key}-${p.scope_key}`} className={`border-t border-slate-100 ${rowClass}`}>
                    <td className="px-5 py-2 text-[var(--muted)] font-bold">{p.rank ?? '—'}</td>
                    <td className="px-5 py-2 font-medium">{p.entity_key}</td>
                    <td className="px-5 py-2">{hub?.display_name ?? p.scope_key}</td>
                    <td className="px-5 py-2 text-right font-semibold">{formatValue(p.value, kpi.unit)}</td>
                    <td className="px-5 py-2 text-right text-[var(--muted)]">{formatValue(p.peer_mean, kpi.unit)}</td>
                    <td className="px-5 py-2 text-right text-[var(--muted)] font-mono">{p.z_score === null ? '—' : p.z_score.toFixed(2)}</td>
                    <td className="px-5 py-2 text-right text-[var(--muted)]">{p.rank}/{p.rank_total}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {drillEntities.length > 25 && (
            <div className="px-5 py-2 text-center text-[11.5px] text-[var(--muted)] bg-slate-50 border-t border-slate-100">
              Mostrando 25 de {drillEntities.length}.
            </div>
          )}
        </div>
      )}

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
              {hubs.map((h) => (
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
