'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer,
} from 'recharts';

interface Kpi {
  id: string;
  name_es: string;
  unit: string;
  direction: string;
  category: string;
  watched_globally: boolean;
  parent_kpi_id: string | null;
  display_order: number;
}
interface Hub { id: string; display_name: string; city: string }
interface Snapshot {
  week_start: string;
  scope_level: string;
  scope_key: string | null;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  prev_week_value: number | null;
}

const HUB_COLORS: Record<string, string> = {
  mh_contry:      '#0ea5e9',
  mh_cumbres:     '#22c55e',
  mh_san_nicolas: '#a855f7',
  mh_guadalupe:   '#ef4444',
  mh_avicola:     '#f59e0b',
  mh_zapopan:     '#06b6d4',
  mh_condesa:     '#ec4899',
};

export function HistoricosClient({
  kpis, hubs, selectedKpi, snapshots,
}: {
  kpis: Kpi[]; hubs: Hub[]; selectedKpi: string; snapshots: Snapshot[];
}) {
  const router = useRouter();
  const pathname = usePathname();

  const currentKpi = kpis.find((k) => k.id === selectedKpi);

  // Build chart data: one row per week, one column per hub.
  // Label shows the Thursday END of the Fri-Thu week (matches mental model).
  // Sort by ISO date (chronological), not by the label.
  const chartData = useMemo(() => {
    const byWeek = new Map<string, Record<string, any>>();
    for (const s of snapshots) {
      if (s.scope_level !== 'hub' || !s.scope_key) continue;
      if (!byWeek.has(s.week_start)) {
        byWeek.set(s.week_start, { week: weekEndLabel(s.week_start), _iso: s.week_start });
      }
      byWeek.get(s.week_start)![s.scope_key] = s.value === null ? null : Number(s.value);
    }
    return [...byWeek.values()]
      .sort((a, b) => (a._iso > b._iso ? 1 : a._iso < b._iso ? -1 : 0))
      .map(({ _iso, ...rest }) => rest);
  }, [snapshots]);

  // Latest week per hub for the table
  const tableRows = useMemo(() => {
    const latestSnapByHub = new Map<string, Snapshot>();
    for (const s of snapshots) {
      if (s.scope_level !== 'hub' || !s.scope_key) continue;
      const cur = latestSnapByHub.get(s.scope_key);
      if (!cur || s.week_start > cur.week_start) latestSnapByHub.set(s.scope_key, s);
    }
    return hubs.map((h) => {
      const snap = latestSnapByHub.get(h.id);
      return {
        hub: h,
        value: snap?.value ?? null,
        prev: snap?.prev_week_value ?? null,
        weekStart: snap?.week_start ?? null,
      };
    });
  }, [snapshots, hubs]);

  // Global rolling line (peer mean)
  const globalSeries = useMemo(() => {
    const series: Record<string, number | null> = {};
    for (const s of snapshots) {
      if (s.scope_level === 'global') {
        series[shortLabel(s.week_start)] = s.value === null ? null : Number(s.value);
      }
    }
    return series;
  }, [snapshots]);

  const hasData = chartData.length > 0;

  function pickKpi(id: string) {
    const params = new URLSearchParams();
    params.set('kpi', id);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="space-y-4">
      {/* KPI selector + summary */}
      <div className="bg-white border border-[var(--line)] rounded-xl p-4 shadow-soft">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[11px] uppercase tracking-wide text-[var(--muted)] font-bold">KPI:</span>
          <select
            value={selectedKpi}
            onChange={(e) => pickKpi(e.target.value)}
            className="border border-[var(--line)] rounded-md px-3 py-1.5 text-[13px] font-semibold bg-white"
          >
            {kpis.map((k) => (
              <option key={k.id} value={k.id}>
                {k.parent_kpi_id ? '↳ ' : ''}{k.name_es}
              </option>
            ))}
          </select>
          {currentKpi && (
            <>
              <span className="text-[11px] uppercase tracking-wide text-[var(--muted)] font-bold">
                {currentKpi.unit}
              </span>
              <span className="text-[11px] text-[var(--muted)]">
                {currentKpi.direction === 'lower_is_better' ? '↓ menor mejor' : '↑ mayor mejor'} · {currentKpi.category}
              </span>
              {currentKpi.watched_globally && (
                <span className="text-[10px] bg-teal-100 text-teal-800 px-1.5 py-0.5 rounded font-bold">en home</span>
              )}
            </>
          )}
          <div className="ml-auto text-[11.5px] text-[var(--muted)]">
            {chartData.length} semanas · {hubs.length} hubs
          </div>
        </div>
      </div>

      {/* Main chart */}
      <div className="bg-white border border-[var(--line)] rounded-xl p-5 shadow-soft">
        <h3 className="text-[15px] font-semibold mb-1">
          {currentKpi?.name_es ?? selectedKpi} · por micro-hub
        </h3>
        <p className="text-[12px] text-[var(--muted)] mb-3">
          Una línea por hub, semanas vie-jue. Pasa el mouse para ver valores semanales.
        </p>

        {!hasData ? (
          <div className="border border-dashed border-[var(--line)] rounded-md p-10 text-center text-[var(--muted)] text-[13px]">
            No hay snapshots para este KPI todavía. Sube CSVs para esta KPI y haz click en "Recomputar snapshots" en /upload.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={chartData} margin={{ top: 12, right: 24, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="week" tick={{ fontSize: 11, fill: '#6b7280' }} />
              <YAxis
                tick={{ fontSize: 11, fill: '#6b7280' }}
                domain={['auto', 'auto']}
                tickFormatter={(v: any) => formatValue(Number(v), currentKpi?.unit ?? '')}
                width={60}
              />
              <Tooltip
                formatter={(v: any, name: string) => {
                  if (v == null) return ['—', name];
                  const fmt = formatValue(Number(v), currentKpi?.unit ?? '');
                  return [fmt, hubLabel(name, hubs)];
                }}
                contentStyle={{ fontSize: 12 }}
              />
              <Legend
                formatter={(value: string) => hubLabel(value, hubs)}
                wrapperStyle={{ fontSize: 11 }}
              />
              {hubs.map((h) => (
                <Line
                  key={h.id}
                  type="monotone"
                  dataKey={h.id}
                  stroke={HUB_COLORS[h.id] ?? '#94a3b8'}
                  strokeWidth={h.id === 'mh_guadalupe' ? 2.4 : 1.8}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Table */}
      <div className="bg-white border border-[var(--line)] rounded-xl shadow-soft overflow-hidden">
        <div className="px-5 py-3 border-b border-[var(--line)]">
          <h3 className="text-[14px] font-semibold">Esta semana · por hub</h3>
          <p className="text-[11.5px] text-[var(--muted)]">Valor más reciente por hub, con WoW delta y peer mean global.</p>
        </div>
        <table className="w-full text-[12.5px]">
          <thead className="bg-slate-50 text-[10.5px] uppercase tracking-wide text-[var(--muted)] font-bold">
            <tr>
              <th className="px-5 py-2 text-left">Hub</th>
              <th className="px-5 py-2 text-left">Ciudad</th>
              <th className="px-5 py-2 text-right">Valor</th>
              <th className="px-5 py-2 text-right">WoW</th>
              <th className="px-5 py-2 text-right">Semana</th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map(({ hub, value, prev, weekStart }) => {
              const delta = value !== null && prev !== null && prev !== 0
                ? ((value - prev) / Math.abs(prev)) * 100
                : null;
              const deltaColor =
                delta === null ? 'text-[var(--muted)]' :
                (currentKpi?.direction === 'lower_is_better' ? delta < 0 : delta > 0)
                  ? 'text-emerald-600' : 'text-red-600';
              return (
                <tr key={hub.id} className="border-t border-slate-100">
                  <td className="px-5 py-2 font-semibold">{hub.display_name}</td>
                  <td className="px-5 py-2 text-[var(--muted)]">{hub.city}</td>
                  <td className="px-5 py-2 text-right font-medium">
                    {value === null ? '—' : formatValue(value, currentKpi?.unit ?? '')}
                  </td>
                  <td className={`px-5 py-2 text-right ${deltaColor} font-medium`}>
                    {delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`}
                  </td>
                  <td className="px-5 py-2 text-right text-[var(--muted)] text-[11px]">
                    {weekStart ? `jue ${weekEndLabel(weekStart)}` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="text-[11px] text-[var(--muted)] italic">
        v1: una KPI a la vez, gráfica por hub + tabla. Drill-down per-armador, anomaly bands, correlaciones y comparativas en próxima iteración.
      </div>
    </div>
  );
}

function formatValue(v: number, unit: string): string {
  if (unit === 'pct') return `${(v * 100).toFixed(1)}%`;
  if (unit === 'currency') return `$${v.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  if (unit === 'rate') return v.toFixed(1);
  if (unit === 'count') return v.toFixed(0);
  return String(v);
}

function shortLabel(weekStart: string): string {
  const d = new Date(weekStart + 'T00:00:00');
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short' }).format(d);
}

/** Returns the Thursday (end of Fri-Thu week) given a Friday week_start. */
function weekEndLabel(weekStart: string): string {
  const d = new Date(weekStart + 'T00:00:00');
  d.setDate(d.getDate() + 6);   // Friday + 6 = Thursday next
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short' }).format(d);
}

function hubLabel(hubId: string, hubs: Hub[]): string {
  const h = hubs.find((x) => x.id === hubId);
  return h ? h.display_name : hubId;
}
