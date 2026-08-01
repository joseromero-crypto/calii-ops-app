'use client';
import { useMemo, useState } from 'react';
import {
  formatValue, formatDelta, deltaClassForDirection, groupBy, isResumenKpi,
  type Kpi, type Hub, type Snapshot, type Peer, type KpiTarget,
} from './_shared';
import { ResumenTrendChart } from './ResumenCharts';

interface Props {
  kpis: Kpi[];
  hubs: Hub[];
  snapshots: Snapshot[];
  peers: Peer[];
  currentWeek: string;
  targets: KpiTarget[];
}

interface CellData {
  value: number | null;
  delta: { text: string; isUp: boolean | null };
}

const CITY_ORDER = ['Monterrey', 'Saltillo', 'Guadalajara', 'CDMX'];
const EXPECTED_CITIES = 4;

/** Snapshots for one (kpi, scope) key, sorted chronologically. */
function chronological(snapshots: Snapshot[], kpiId: string, scopeLevel: string, scopeKey: string | null): Snapshot[] {
  return snapshots
    .filter((s) => s.kpi_id === kpiId && s.scope_level === scopeLevel && s.scope_key === scopeKey)
    .sort((a, b) => a.week_start.localeCompare(b.week_start));
}

/**
 * Current week's row + the row immediately before it in the chronological
 * series (NOT snap.prev_week_value — only populated for recent weeks, and
 * for the Total row summing per-hub prev_week_value would mix a summed
 * current against a DB-global (meaned) previous — see PLAN §4a/§7).
 */
function currentAndPrev(rows: Snapshot[], currentWeek: string): { current?: Snapshot; prev?: Snapshot } {
  const idx = rows.findIndex((r) => r.week_start === currentWeek);
  if (idx === -1) return {};
  return { current: rows[idx], prev: idx > 0 ? rows[idx - 1] : undefined };
}

export function ResumenTab({ kpis, hubs, snapshots, currentWeek }: Props) {
  const resumenKpis = useMemo(() => kpis.filter(isResumenKpi), [kpis]);

  const cityGroups = useMemo(() => groupBy(hubs, (h) => h.city), [hubs]);
  const orderedCities = useMemo(
    () => [...cityGroups.keys()].sort((a, b) => CITY_ORDER.indexOf(a) - CITY_ORDER.indexOf(b)),
    [cityGroups]
  );

  // Cities collapsed by default; Total is always expanded (not user-toggled).
  const [expandedCities, setExpandedCities] = useState<Set<string>>(new Set());
  function toggleCity(city: string) {
    setExpandedCities((prev) => {
      const next = new Set(prev);
      if (next.has(city)) next.delete(city);
      else next.add(city);
      return next;
    });
  }

  // Upload completeness — with 4 files feeding one Total, a missing city
  // silently understates it. Derived from distinct city scope_keys present
  // for any Resumen KPI this week, across all 4 expected cities.
  const citiesPresent = useMemo(() => {
    const ids = new Set(resumenKpis.map((k) => k.id));
    const set = new Set<string>();
    for (const s of snapshots) {
      if (s.week_start === currentWeek && s.scope_level === 'city' && s.scope_key && ids.has(s.kpi_id)) {
        set.add(s.scope_key);
      }
    }
    return set;
  }, [snapshots, resumenKpis, currentWeek]);

  // Hub / city rows read straight from the DB — both scopes are already
  // correct there (hub trivially; city because aggregateAllScopes sums/
  // weights correctly at that level too).
  function scopeCell(kpi: Kpi, scopeLevel: 'hub' | 'city', scopeKey: string): CellData {
    const rows = chronological(snapshots, kpi.id, scopeLevel, scopeKey);
    const { current, prev } = currentAndPrev(rows, currentWeek);
    const value = current?.value ?? null;
    return { value, delta: formatDelta(value, prev?.value ?? null, kpi.unit) };
  }

  // Total row: true sum of the 7 hub rows for count/currency KPIs — the DB
  // global row for those units is a MEAN of hub totals (correct for the Por
  // KPI reference line, wrong under a "Total" heading — PLAN §4a). For
  // currency_avg/rate the DB global is already the correct weighted average,
  // so read it directly. The previous-week value is summed the same way as
  // the current one — never the DB global's prev_week_value.
  function totalCell(kpi: Kpi): CellData {
    if (kpi.unit === 'currency_avg' || kpi.unit === 'rate') {
      const rows = chronological(snapshots, kpi.id, 'global', null);
      const { current, prev } = currentAndPrev(rows, currentWeek);
      const value = current?.value ?? null;
      return { value, delta: formatDelta(value, prev?.value ?? null, kpi.unit) };
    }
    let curSum = 0, curCount = 0, prevSum = 0, prevCount = 0;
    for (const h of hubs) {
      const rows = chronological(snapshots, kpi.id, 'hub', h.id);
      const { current, prev } = currentAndPrev(rows, currentWeek);
      if (current?.value != null) { curSum += current.value; curCount += 1; }
      if (prev?.value != null) { prevSum += prev.value; prevCount += 1; }
    }
    const value = curCount > 0 ? curSum : null;
    const prevValue = prevCount > 0 ? prevSum : null;
    return { value, delta: formatDelta(value, prevValue, kpi.unit) };
  }

  if (resumenKpis.length === 0) {
    return (
      <p className="text-[var(--muted)]">
        No hay KPIs de Resumen operativo configurados todavía. Corre las migraciones y sube el primer archivo semanal.
      </p>
    );
  }

  const pedidosEntregadosKpi = resumenKpis.find((k) => k.id === 'pedidos_entregados');
  const aovKpi = resumenKpis.find((k) => k.id === 'aov_mxn');
  const ingresosKpi = resumenKpis.find((k) => k.id === 'ingresos_hub');

  return (
    <div className="space-y-3">
      {citiesPresent.size < EXPECTED_CITIES && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-3 py-2 text-[12.5px]">
          ⚠️ {citiesPresent.size} de {EXPECTED_CITIES} ciudades cargadas — el total está incompleto
        </div>
      )}
      <div className="overflow-x-auto bg-white border border-[var(--line)] rounded-xl shadow-soft">
        <table className="min-w-full text-[12.5px] border-collapse">
          <thead>
            <tr className="border-b border-[var(--line)]">
              <th className="sticky left-0 bg-white z-10 text-left px-3 py-2 font-semibold whitespace-nowrap">Scope</th>
              {resumenKpis.map((k) => (
                <th key={k.id} className="text-right px-3 py-2 font-semibold whitespace-nowrap">{k.name_es}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-[var(--line)] bg-slate-50 font-semibold">
              <td className="sticky left-0 bg-slate-50 z-10 px-3 py-2 whitespace-nowrap">▾ Total</td>
              {resumenKpis.map((k) => {
                const { value, delta } = totalCell(k);
                return (
                  <td key={k.id} className="text-right px-3 py-2 tabular-nums whitespace-nowrap">
                    <div>{formatValue(value, k.unit)}</div>
                    <div className={`text-[10.5px] font-normal ${deltaClassForDirection(delta.isUp, k.direction)}`}>{delta.text}</div>
                  </td>
                );
              })}
            </tr>

            {orderedCities.map((city) => {
              const cityHubs = cityGroups.get(city) ?? [];
              const expanded = expandedCities.has(city);
              return (
                <FragmentCityBlock
                  key={city}
                  city={city}
                  cityHubs={cityHubs}
                  kpis={resumenKpis}
                  expanded={expanded}
                  onToggle={() => toggleCity(city)}
                  scopeCell={scopeCell}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {(pedidosEntregadosKpi || aovKpi || ingresosKpi) && (
        <div className="space-y-3">
          {pedidosEntregadosKpi && (
            <ResumenTrendChart
              title="Pedidos entregados"
              kpi={pedidosEntregadosKpi}
              hubs={hubs}
              snapshots={snapshots}
              currentWeek={currentWeek}
            />
          )}
          {aovKpi && (
            <ResumenTrendChart
              title="AOV"
              kpi={aovKpi}
              hubs={hubs}
              snapshots={snapshots}
              currentWeek={currentWeek}
            />
          )}
          {ingresosKpi && (
            <ResumenTrendChart
              title="Ingresos estimados"
              kpi={ingresosKpi}
              hubs={hubs}
              snapshots={snapshots}
              currentWeek={currentWeek}
            />
          )}
        </div>
      )}
    </div>
  );
}

function FragmentCityBlock({
  city, cityHubs, kpis, expanded, onToggle, scopeCell,
}: {
  city: string;
  cityHubs: Hub[];
  kpis: Kpi[];
  expanded: boolean;
  onToggle: () => void;
  scopeCell: (kpi: Kpi, scopeLevel: 'hub' | 'city', scopeKey: string) => CellData;
}) {
  return (
    <>
      <tr className="border-b border-[var(--line)] hover:bg-slate-50 cursor-pointer" onClick={onToggle}>
        <td className="sticky left-0 bg-white z-10 px-3 py-2 pl-6 whitespace-nowrap">
          <span className="inline-block w-3">{expanded ? '▾' : '▸'}</span> {city}
        </td>
        {kpis.map((k) => {
          const { value, delta } = scopeCell(k, 'city', city);
          return (
            <td key={k.id} className="text-right px-3 py-2 tabular-nums whitespace-nowrap">
              <div>{formatValue(value, k.unit)}</div>
              <div className={`text-[10.5px] ${deltaClassForDirection(delta.isUp, k.direction)}`}>{delta.text}</div>
            </td>
          );
        })}
      </tr>
      {expanded && cityHubs.map((h) => (
        <tr key={h.id} className="border-b border-[var(--line)]">
          <td className="sticky left-0 bg-white z-10 px-3 py-2 pl-10 text-[var(--muted)] whitespace-nowrap">{h.display_name}</td>
          {kpis.map((k) => {
            const { value, delta } = scopeCell(k, 'hub', h.id);
            return (
              <td key={k.id} className="text-right px-3 py-2 tabular-nums whitespace-nowrap">
                <div>{formatValue(value, k.unit)}</div>
                <div className={`text-[10.5px] ${deltaClassForDirection(delta.isUp, k.direction)}`}>{delta.text}</div>
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
