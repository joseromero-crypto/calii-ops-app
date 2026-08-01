'use client';
import { useMemo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer,
} from 'recharts';
import { HUB_COLORS, formatValue, weekEndLabel, type Kpi, type Hub, type Snapshot } from './_shared';

const CITY_ORDER = ['Monterrey', 'Saltillo', 'Guadalajara', 'CDMX'];
const CITY_COLORS: Record<string, string> = {
  Monterrey: '#0ea5e9',
  Saltillo: '#f59e0b',
  Guadalajara: '#06b6d4',
  CDMX: '#ec4899',
};

const TIME_RANGES = [
  { label: '5 sem', value: 5 },
  { label: '3 m', value: 13 },
  { label: '6 m', value: 26 },
  { label: '1 a', value: 52 },
  { label: 'YTD', value: -1 },
] as const;

type ScopeMode = 'total' | 'city' | 'hub';

function chronologicalSeries(snapshots: Snapshot[], kpiId: string, scopeLevel: string, scopeKey: string | null): Snapshot[] {
  return snapshots
    .filter((s) => s.kpi_id === kpiId && s.scope_level === scopeLevel && s.scope_key === scopeKey)
    .sort((a, b) => a.week_start.localeCompare(b.week_start));
}

function ChartTooltip({
  active, payload, label, unit, nameForKey,
}: {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number | null; stroke: string }>;
  label?: string;
  unit: string;
  nameForKey: (key: string) => string;
}) {
  if (!active || !payload?.length) return null;
  const sorted = [...payload].filter((p) => p.value != null).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 shadow-lg text-[12px] min-w-[160px]">
      <div className="font-semibold text-[var(--ink)] mb-1.5">{label}</div>
      {sorted.map((p) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-3 py-0.5">
          <div className="flex items-center gap-1.5">
            <span style={{ color: p.stroke }} className="text-[10px]">●</span>
            <span className="text-slate-700">{nameForKey(p.dataKey)}</span>
          </div>
          <span className="font-semibold tabular-nums">{formatValue(p.value == null ? null : Number(p.value), unit)}</span>
        </div>
      ))}
    </div>
  );
}

interface Props {
  title: string;
  kpi: Kpi;
  hubs: Hub[];
  snapshots: Snapshot[];
  currentWeek: string;
}

/**
 * One WoW trend chart scoped to the Resumen tab — Total / por ciudad / por
 * hub, switchable per chart. Total uses the same sum-vs-weighted rule as the
 * Resumen tree's Total row (§4a): count/currency sum the hub series,
 * currency_avg/rate read the DB global series directly (already weighted).
 */
export function ResumenTrendChart({ title, kpi, hubs, snapshots, currentWeek }: Props) {
  const [mode, setMode] = useState<ScopeMode>('total');
  const [selectedCities, setSelectedCities] = useState<Set<string>>(new Set(CITY_ORDER));
  const [selectedHubs, setSelectedHubs] = useState<Set<string>>(new Set(hubs.map((h) => h.id)));
  const [weeksShown, setWeeksShown] = useState(5);

  const orderedCities = useMemo(
    () => CITY_ORDER.filter((c) => hubs.some((h) => h.city === c)),
    [hubs]
  );

  function toggleCity(c: string) {
    setSelectedCities((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  }
  function toggleHub(id: string) {
    setSelectedHubs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const totalSeries = useMemo(() => {
    const weighted = kpi.unit === 'currency_avg' || kpi.unit === 'rate';
    if (weighted) {
      return chronologicalSeries(snapshots, kpi.id, 'global', null)
        .map((s) => ({ week_start: s.week_start, value: s.value }));
    }
    const byWeek = new Map<string, number>();
    for (const h of hubs) {
      for (const s of chronologicalSeries(snapshots, kpi.id, 'hub', h.id)) {
        if (s.value == null) continue;
        byWeek.set(s.week_start, (byWeek.get(s.week_start) ?? 0) + s.value);
      }
    }
    return [...byWeek.keys()].sort().map((week_start) => ({ week_start, value: byWeek.get(week_start)! }));
  }, [snapshots, kpi.id, kpi.unit, hubs]);

  const allChartData = useMemo(() => {
    const byWeek = new Map<string, Record<string, any>>();
    function ensure(week: string) {
      if (!byWeek.has(week)) byWeek.set(week, { week: weekEndLabel(week), _iso: week });
      return byWeek.get(week)!;
    }

    if (mode === 'total') {
      for (const pt of totalSeries) {
        ensure(pt.week_start).total = pt.value == null ? null : Number(pt.value);
      }
    } else if (mode === 'city') {
      for (const city of orderedCities) {
        if (!selectedCities.has(city)) continue;
        for (const s of chronologicalSeries(snapshots, kpi.id, 'city', city)) {
          ensure(s.week_start)[city] = s.value == null ? null : Number(s.value);
        }
      }
    } else {
      for (const h of hubs) {
        if (!selectedHubs.has(h.id)) continue;
        for (const s of chronologicalSeries(snapshots, kpi.id, 'hub', h.id)) {
          ensure(s.week_start)[h.id] = s.value == null ? null : Number(s.value);
        }
      }
    }

    return [...byWeek.values()].sort((a, b) => a._iso.localeCompare(b._iso));
  }, [mode, totalSeries, orderedCities, selectedCities, hubs, selectedHubs, snapshots, kpi.id]);

  const chartData = useMemo(() => {
    const filtered = weeksShown === -1
      ? allChartData.filter((d) => d._iso >= `${currentWeek.slice(0, 4)}-01-01`)
      : allChartData.slice(-weeksShown);
    return filtered.map(({ _iso, ...rest }) => rest);
  }, [allChartData, weeksShown, currentWeek]);

  function nameForKey(key: string): string {
    if (key === 'total') return 'Total';
    if (CITY_ORDER.includes(key)) return key;
    return hubs.find((h) => h.id === key)?.display_name ?? key;
  }

  const lineKeys: { key: string; color: string }[] = useMemo(() => {
    if (mode === 'total') return [{ key: 'total', color: '#0f172a' }];
    if (mode === 'city') {
      return orderedCities.filter((c) => selectedCities.has(c)).map((c) => ({ key: c, color: CITY_COLORS[c] ?? '#94a3b8' }));
    }
    return hubs.filter((h) => selectedHubs.has(h.id)).map((h) => ({ key: h.id, color: HUB_COLORS[h.id] ?? '#94a3b8' }));
  }, [mode, orderedCities, selectedCities, hubs, selectedHubs]);

  return (
    <div className="bg-white border border-[var(--line)] rounded-xl p-5 shadow-soft">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        <div className="flex items-center gap-1">
          {TIME_RANGES.map(({ label, value }) => (
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

      <div className="flex items-center gap-1 mb-3">
        {([['total', 'Total'], ['city', 'Por ciudad'], ['hub', 'Por hub']] as const).map(([m, label]) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-2.5 py-1 rounded-full text-[11.5px] font-medium border ${
              mode === m
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-600 border-[var(--line)] hover:border-slate-400'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'city' && (
        <div className="flex items-center gap-1.5 flex-wrap mb-3">
          {orderedCities.map((c) => (
            <button
              key={c}
              onClick={() => toggleCity(c)}
              className={`px-2 py-0.5 rounded text-[11px] font-medium border ${
                selectedCities.has(c) ? 'text-white border-transparent' : 'bg-white text-slate-400 border-[var(--line)]'
              }`}
              style={selectedCities.has(c) ? { backgroundColor: CITY_COLORS[c] ?? '#94a3b8' } : undefined}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      {mode === 'hub' && (
        <div className="flex items-center gap-1.5 flex-wrap mb-3">
          {hubs.map((h) => (
            <button
              key={h.id}
              onClick={() => toggleHub(h.id)}
              className={`px-2 py-0.5 rounded text-[11px] font-medium border ${
                selectedHubs.has(h.id) ? 'text-white border-transparent' : 'bg-white text-slate-400 border-[var(--line)]'
              }`}
              style={selectedHubs.has(h.id) ? { backgroundColor: HUB_COLORS[h.id] ?? '#94a3b8' } : undefined}
            >
              {h.display_name}
            </button>
          ))}
        </div>
      )}

      {chartData.length === 0 || lineKeys.length === 0 ? (
        <div className="border border-dashed border-[var(--line)] rounded-md p-10 text-center text-[var(--muted)] text-[13px]">
          Sin datos para mostrar.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={340}>
          <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="week" tick={{ fontSize: 11, fill: '#6b7280' }} />
            <YAxis
              tick={{ fontSize: 11, fill: '#6b7280' }}
              domain={['auto', 'auto']}
              tickFormatter={(v: any) => formatValue(Number(v), kpi.unit)}
              width={70}
            />
            <Tooltip content={(props: any) => <ChartTooltip {...props} unit={kpi.unit} nameForKey={nameForKey} />} />
            <Legend formatter={(value: string) => nameForKey(value)} wrapperStyle={{ fontSize: 11 }} />
            {lineKeys.map(({ key, color }) => (
              <Line key={key} type="monotone" dataKey={key} stroke={color} strokeWidth={1.8} dot={false} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
