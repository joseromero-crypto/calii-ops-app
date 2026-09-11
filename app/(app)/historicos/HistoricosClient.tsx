'use client';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Kpi, Hub, Snapshot, Peer, KpiTarget, RampTarget } from './_shared';
import { weekEndLabel } from './_shared';
import { buildTenureNameIndex, type TenureRow } from '@/lib/tenure';
import { PorKpiTab } from './PorKpiTab';
import { PorHubTab } from './PorHubTab';
import { ComparativaTab } from './ComparativaTab';
import { ResumenTab } from './ResumenTab';
interface Props {
  kpis: Kpi[];
  hubs: Hub[];
  snapshots: Snapshot[];
  peers: Peer[];
  /** Multi-week operator peer rows (within_hub) for the assembler WoW charts. */
  assemblerTrend: Peer[];
  /** Multi-week driver peer rows (within_hub) for the driver WoW charts. */
  driverTrend: Peer[];
  roles: { id: string; name_es: string }[];
  targets: KpiTarget[];
  /** Derived tenure ledger, both roles combined — see lib/tenure.ts. */
  tenureRows: TenureRow[];
  ramps: RampTarget[];
  currentWeek: string;
  tab: 'kpi' | 'hub' | 'cmp' | 'res';
  selectedKpi?: string;
  selectedHub?: string;
  selectedCity?: string;
}
export function HistoricosClient(props: Props) {
  const { currentWeek, tenureRows } = props;

  // Built once here (not per tile/dropdown/tooltip) and passed down as Maps —
  // every consumer does name lookups, rebuilding this per render is wasteful.
  // Two separate indexes: an armador and a repartidor could share a normalized
  // name and collide in a single shared map.
  const tenureByNameArmador = useMemo(
    () => buildTenureNameIndex(tenureRows.filter((r) => r.role === 'armador')),
    [tenureRows],
  );
  const tenureByNameRepartidor = useMemo(
    () => buildTenureNameIndex(tenureRows.filter((r) => r.role === 'repartidor')),
    [tenureRows],
  );

  // ── Navigation state ─────────────────────────────────────────────────────────
  //
  // Session 16 — tab switching is a SERVER navigation now, KPI switching is not.
  //
  // The page fetches per tab (see page.tsx header): three of the four tabs read
  // only `snapshots`, and everything expensive belongs to Por hub. That only
  // holds if changing tab re-runs the server component, so `switchTab` uses
  // router.push instead of the old history.pushState. Next's router cache keeps
  // a recently-visited tab instant on the way back, and loading.tsx covers the
  // first visit.
  //
  // Switching KPI inside Por KPI needs no new data — every snapshot is already
  // loaded — so it stays pure client state + pushState, as before. Hub
  // switching inside Por hub likewise stays client-side.

  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const activeTab = props.tab;
  const defaultKpi = props.kpis.find((k) => k.watched_globally)?.id ?? props.kpis[0]?.id ?? '';
  const [activeKpi, setActiveKpi] = useState<string>(props.selectedKpi ?? defaultKpi);

  const hrefFor = (tab: 'kpi' | 'hub' | 'cmp' | 'res', kpi: string) => {
    const params = new URLSearchParams();
    if (tab !== 'kpi') params.set('tab', tab);
    if (tab === 'kpi' && kpi && kpi !== defaultKpi) params.set('kpi', kpi);
    return params.toString() ? `/historicos?${params.toString()}` : '/historicos';
  };

  const switchTab = (t: 'kpi' | 'hub' | 'cmp' | 'res') => {
    if (t === activeTab) return;
    startTransition(() => router.push(hrefFor(t, activeKpi)));
  };

  const switchKpi = (id: string) => {
    setActiveKpi(id);
    // No refetch needed — snapshots for every KPI are already on the client.
    window.history.pushState(null, '', hrefFor('kpi', id));
    if (activeTab !== 'kpi') switchTab('kpi');
  };

  return (
    <div>
      <div className="flex items-baseline justify-between flex-wrap gap-3 mb-4">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight">Históricos &amp; análisis</h1>
          <div className="text-[var(--muted)] text-[13px] mt-1">
            Verifica, compara y forma tu propia opinión a partir de los datos cargados.
          </div>
        </div>
        <span className="inline-flex items-center gap-2 bg-white border border-[var(--line)] rounded-full px-3 py-1.5 text-[12.5px] shadow-soft">
          <span className="w-2 h-2 rounded-full bg-teal-400" />
          Esta sem: jue {weekEndLabel(currentWeek)}
        </span>
      </div>
      <div className={`flex gap-1 border-b border-[var(--line)] mb-5 overflow-x-auto transition-opacity ${isPending ? 'opacity-50 pointer-events-none' : ''}`}>
        <Tab onClick={() => switchTab('kpi')} active={activeTab === 'kpi'}>📈 Por KPI</Tab>
        <Tab onClick={() => switchTab('hub')} active={activeTab === 'hub'}>🏬 Por hub<span className="hidden sm:inline"> · vista 1:1</span></Tab>
        <Tab onClick={() => switchTab('cmp')} active={activeTab === 'cmp'}>⚖️ Comparativa<span className="hidden sm:inline"> entre MHs</span></Tab>
        <Tab onClick={() => switchTab('res')} active={activeTab === 'res'}>📦 Resumen</Tab>
      </div>
      {activeTab === 'kpi' && <PorKpiTab {...props} selectedKpi={activeKpi} onKpiChange={switchKpi} />}
      {activeTab === 'hub' && <PorHubTab {...props} assemblerTrend={props.assemblerTrend} driverTrend={props.driverTrend} tenureByNameArmador={tenureByNameArmador} tenureByNameRepartidor={tenureByNameRepartidor} />}
      {activeTab === 'cmp' && <ComparativaTab {...props} />}
      {activeTab === 'res' && <ResumenTab {...props} />}
    </div>
  );
}
function Tab({ onClick, active, children }: { onClick: () => void; active: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 whitespace-nowrap px-3.5 py-2.5 text-[13px] font-medium border-b-2 -mb-px ${
        active
          ? 'border-teal-400 text-[var(--ink)] font-semibold'
          : 'border-transparent text-[var(--muted)] hover:text-[var(--ink)]'
      }`}
    >
      {children}
    </button>
  );
}
