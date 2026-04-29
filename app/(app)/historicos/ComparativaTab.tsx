'use client';
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts';
import {
  HUB_COLORS, formatValue, weekEndLabel,
  type Kpi, type Hub, type Snapshot,
} from './_shared';

interface Props {
  kpis: Kpi[];
  hubs: Hub[];
  snapshots: Snapshot[];
  currentWeek: string;
  selectedCity?: string;
}

export function ComparativaTab({ kpis, hubs, snapshots, currentWeek, selectedCity }: Props) {
  const router = useRouter();

  function pickCity(c: string | null) {
    if (c) {
      router.push(`/historicos?tab=comparativa&city=${encodeURIComponent(c)}`);
    } else {
      router.push('/historicos?tab=comparativa');
    }
  }

  const filteredHubs = selectedCity ? hubs.filter((h) => h.city === selectedCity) : hubs;
  const cities = [...new Set(hubs.map((h) => h.city))];

  return (
    <div className="space-y-3">
      <div className="bg-white border border-[var(--line)] rounded-xl p-3 shadow-soft flex items-center gap-2 flex-wrap">
        <span className="text-[11px] uppercase tracking-wide text-[var(--muted)] font-bold mr-2">Filtrar por ciudad:</span>
        <button
          onClick={() => pickCity(null)}
          className={`px-3 py-1 rounded-full text-[11.5px] font-medium border ${
            !selectedCity ? 'bg-black text-white border-black' : 'bg-white text-slate-700 border-[var(--line)] hover:border-black'
          }`}
        >Todas</button>
        {cities.map((c) => (
          <button
            key={c}
            onClick={() => pickCity(c)}
            className={`px-3 py-1 rounded-full text-[11.5px] font-medium border ${
              selectedCity === c ? 'bg-black text-white border-black' : 'bg-white text-slate-700 border-[var(--line)] hover:border-black'
            }`}
          >{c}</button>
        ))}
        <span className="ml-auto text-[11.5px] text-[var(--muted)]">
          {filteredHubs.length} hubs · {kpis.length} KPIs
        </span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
        {kpis.map((kpi) => (
          <KpiCompareCard key={kpi.id} kpi={kpi} hubs={filteredHubs} snapshots={snapshots} currentWeek={currentWeek} />
        ))}
      </div>
    </div>
  );
}

function KpiCompareCard({ kpi, hubs, snapshots, currentWeek }: { kpi: Kpi; hubs: Hub[]; snapshots: Snapshot[]; currentWeek: string }) {
  const chartData = useMemo(() => {
    const byWeek = new Map<string, Record<string, any>>();
    for (const s of snapshots) {
      if (s.kpi_id !== kpi.id) continue;
      if (s.scope_level !== 'hub' || !s.scope_key) continue;
      if (!hubs.find((h) => h.id === s.scope_key)) continue;
      if (!byWeek.has(s.week_start)) {
        byWeek.set(s.week_start, { week: weekEndLabel(s.week_start), _iso: s.week_start });
      }
      byWeek.get(s.week_start)![s.scope_key] = s.value === null ? null : Number(s.value);
    }
    return [...byWeek.values()].sort((a, b) => (a._iso > b._iso ? 1 : -1)).map(({ _iso, ...rest }) => rest);
  }, [snapshots, kpi.id, hubs]);

  const thisWeekValues = useMemo(() => {
    const list: Array<{ hubId: string; value: number; hub: Hub }> = [];
    for (const h of hubs) {
      const s = snapshots.find(
        (x) => x.kpi_id === kpi.id && x.scope_level === 'hub' && x.scope_key === h.id && x.week_start === currentWeek
      );
      if (s && s.value !== null) list.push({ hubId: h.id, value: Number(s.value), hub: h });
    }
    list.sort((a, b) => kpi.direction === 'lower_is_better' ? b.value - a.value : a.value - b.value);
    return list;
  }, [snapshots, hubs, kpi.id, kpi.direction, currentWeek]);

  const maxVal = thisWeekValues.reduce((m, v) => Math.max(m, Math.abs(v.value)), 0) || 1;

  return (
    <div className="bg-white border border-[var(--line)] rounded-xl p-4 shadow-soft">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div>
          <h3 className="text-[13px] font-semibold">{kpi.name_es}</h3>
          <div className="text-[10.5px] text-[var(--muted)]">
            {kpi.unit} · {kpi.direction === 'lower_is_better' ? '↓ menor mejor' : '↑ mayor mejor'} · {kpi.category}
          </div>
        </div>
      </div>
      {chartData.length > 0 ? (
        <ResponsiveContainer width="100%" height={80}>
          <LineChart data={chartData}>
            <Tooltip
              formatter={(v: any, name: string) => [
                v == null ? '—' : formatValue(Number(v), kpi.unit),
                hubs.find((h) => h.id === name)?.display_name ?? name,
              ]}
              contentStyle={{ fontSize: 11 }}
              labelStyle={{ fontSize: 11 }}
            />
            {hubs.map((h) => (
              <Line
                key={h.id}
                type="monotone"
                dataKey={h.id}
                stroke={HUB_COLORS[h.id] ?? '#94a3b8'}
                strokeWidth={1.4}
                dot={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-[80px] flex items-center justify-center text-[11px] text-[var(--muted)]">Sin datos</div>
      )}
      <div className="mt-2 pt-2 border-t border-slate-100 space-y-1">
        {thisWeekValues.map((v, i) => {
          const isWorst = i === 0 && thisWeekValues.length > 1;
          const isBest = i === thisWeekValues.length - 1 && thisWeekValues.length > 1;
          const widthPct = (Math.abs(v.value) / maxVal) * 100;
          return (
            <div key={v.hubId} className="grid grid-cols-[80px_1fr_44px] gap-1.5 items-center text-[10.5px]">
              <span className={`truncate ${isWorst ? 'text-red-700 font-bold' : isBest ? 'text-emerald-700 font-bold' : 'text-slate-700'}`}>
                {v.hub.display_name.replace('MH ', '')}
              </span>
              <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${widthPct}%`, background: HUB_COLORS[v.hubId] ?? '#94a3b8' }}
                />
              </div>
              <span className="text-right font-mono font-semibold tabular-nums">
                {formatValue(v.value, kpi.unit)}
              </span>
            </div>
          );
        })}
        {thisWeekValues.length === 0 && (
          <div className="text-[11px] text-[var(--muted)] py-1">Sin valores esta sem.</div>
        )}
      </div>
    </div>
  );
}
