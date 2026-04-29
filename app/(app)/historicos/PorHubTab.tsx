'use client';

import { useMemo } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { LineChart, Line, ResponsiveContainer, ReferenceLine } from 'recharts';
import {
  formatValue, formatDelta, weekEndLabel, deltaClassForDirection,
  type Kpi, type Hub, type Snapshot, type Peer,
} from './_shared';

interface Props {
  kpis: Kpi[];
  hubs: Hub[];
  snapshots: Snapshot[];
  peers: Peer[];
  roles: { id: string; name_es: string }[];
  currentWeek: string;
  selectedHub?: string;
}

export function PorHubTab({ kpis, hubs, snapshots, peers, currentWeek, selectedHub }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const hubId = selectedHub || hubs[0]?.id;
  const hub = hubs.find((h) => h.id === hubId);

  function pickHub(id: string) {
    const params = new URLSearchParams(sp);
    params.set('hub', id);
    router.push(`${pathname}?${params.toString()}`);
  }

  // KPI tiles for this hub
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
      return {
        kpi: k,
        thisWeek,
        peerThis,
        trend,
      };
    });
  }, [kpis, snapshots, hubId, currentWeek]);

  // Operator/driver rankings within this hub
  const operators = useMemo(
    () =>
      peers
        .filter((p) => p.entity_type === 'operator' && p.scope_type === 'within_hub' && p.scope_key === hubId)
        .filter((p) => p.kpi_id === 'tasa_armado'),
    [peers, hubId]
  );
  const drivers = useMemo(
    () =>
      peers
        .filter((p) => p.entity_type === 'driver' && p.scope_type === 'within_hub' && p.scope_key === hubId)
        .filter((p) => p.kpi_id === 'pct_tardias_reparto'),
    [peers, hubId]
  );

  if (!hub) return <p className="text-[var(--muted)]">No hay hubs configurados.</p>;

  return (
    <div className="space-y-4">
      {/* Hub chips */}
      <div className="flex flex-wrap gap-2">
        {hubs.map((h) => (
          <button
            key={h.id}
            onClick={() => pickHub(h.id)}
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
            {operators.length} armadores · {drivers.length} repartidores con datos esta sem
          </div>
        </div>
      </div>

      {/* KPI tiles grid */}
      <div className="text-[13px] text-[var(--muted)] mb-1 font-bold uppercase tracking-wide">KPIs · 12 semanas</div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {tiles.map(({ kpi, thisWeek, peerThis, trend }) => {
          const value = thisWeek?.value ?? null;
          const prev = thisWeek?.prev_week_value ?? null;
          const delta = formatDelta(value, prev, kpi.unit);
          const deltaCls = deltaClassForDirection(delta.isUp, kpi.direction);
          const peerVal = peerThis?.value ?? null;

          // Compare current vs peer mean
          let z: 'good' | 'mid' | 'bad' | null = null;
          if (value !== null && peerVal !== null && peerVal !== 0) {
            const pctDiff = ((value - peerVal) / Math.abs(peerVal)) * 100;
            const wantsLow = kpi.direction === 'lower_is_better';
            const goodDiff = wantsLow ? pctDiff < -10 : pctDiff > 10;
            const badDiff = wantsLow ? pctDiff > 10 : pctDiff < -10;
            z = goodDiff ? 'good' : badDiff ? 'bad' : 'mid';
          }
          const tileClass =
            z === 'good' ? 'border-emerald-200 bg-emerald-50' :
            z === 'bad' ? 'border-red-200 bg-red-50' :
            'border-[var(--line)] bg-white';

          return (
            <div key={kpi.id} className={`border rounded-xl p-3 shadow-soft ${tileClass}`}>
              <div className="flex items-start justify-between mb-1">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-[var(--muted)] font-bold">{kpi.name_es}</div>
                  <div className="text-[10px] text-[var(--muted)]">{kpi.category}</div>
                </div>
                <span className="text-[10px] text-[var(--muted)]">{kpi.unit}</span>
              </div>
              <div className="flex items-baseline justify-between gap-1">
                <div className="text-[22px] font-bold">{formatValue(value, kpi.unit)}</div>
                <div className={`text-[11px] font-bold ${deltaCls}`}>{delta.text}</div>
              </div>
              {trend.length > 1 && (
                <div className="mt-1.5">
                  <ResponsiveContainer width="100%" height={32}>
                    <LineChart data={trend.map((t) => ({ ...t }))}>
                      {peerVal !== null && (
                        <ReferenceLine y={peerVal} stroke="#94a3b8" strokeDasharray="2 2" />
                      )}
                      <Line type="monotone" dataKey="value" stroke={z === 'bad' ? '#ef4444' : z === 'good' ? '#10b981' : '#0ea5e9'} strokeWidth={1.6} dot={false} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div className="text-[10.5px] text-[var(--muted)] mt-1.5 flex justify-between">
                <span>Peer: {formatValue(peerVal, kpi.unit)}</span>
                <span>{kpi.direction === 'lower_is_better' ? '↓ menor mejor' : '↑ mayor mejor'}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Picker/Driver rankings side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <RankList
          title={`Pickers de ${hub.display_name} · Tasa de armado`}
          items={operators}
          unit="rate"
          subtitle="Ordenados por tasa, mejor → peor"
          highlightLowest
        />
        <RankList
          title={`Repartidores de ${hub.display_name} · % tardías`}
          items={drivers}
          unit="pct"
          subtitle="Ordenados por % tardías, mejor → peor"
          highlightHighest
        />
      </div>
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
    if (highlightLowest) return (b.value ?? 0) - (a.value ?? 0);  // higher first (best)
    return (a.value ?? 0) - (b.value ?? 0);                       // lower first (best)
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
              <th className="px-4 py-1.5 text-left">ID</th>
              <th className="px-4 py-1.5 text-right">Valor</th>
              <th className="px-4 py-1.5 text-right">z</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 12).map((p, i) => {
              const isWorst = i === sorted.length - 1;
              const isBest = i === 0;
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
