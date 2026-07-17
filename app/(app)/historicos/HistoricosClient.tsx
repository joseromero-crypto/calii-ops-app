'use client';
import { useState } from 'react';
import type { Kpi, Hub, Snapshot, Peer, MnaProduct, FaltantesSku, KpiTarget } from './_shared';
import { weekEndLabel } from './_shared';
import { PorKpiTab } from './PorKpiTab';
import { PorHubTab } from './PorHubTab';
import { ComparativaTab } from './ComparativaTab';
interface Props {
  kpis: Kpi[];
  hubs: Hub[];
  snapshots: Snapshot[];
  peers: Peer[];
  /** Multi-week operator peer rows (within_hub) for the assembler WoW charts. */
  assemblerTrend: Peer[];
  /** Multi-week driver peer rows (within_hub) for the driver WoW charts. */
  driverTrend: Peer[];
  mnaProducts: MnaProduct[];
  faltantesSkuProducts: FaltantesSku[];
  roles: { id: string; name_es: string }[];
  targets: KpiTarget[];
  currentWeek: string;
  tab: 'kpi' | 'hub' | 'cmp';
  selectedKpi?: string;
  selectedHub?: string;
  selectedCity?: string;
}
export function HistoricosClient(props: Props) {
  const { currentWeek, mnaProducts } = props;

  // ── Client-side navigation state ─────────────────────────────────────────────
  // All three state variables are initialised from server-provided props (which
  // come from URL searchParams on first load / direct links / back-navigation).
  // Subsequent changes are pure client state + history.pushState — no Supabase
  // re-fetch, no server round-trip, same mechanism as hub switching in PorHubTab.

  const [activeTab, setActiveTab] = useState<'kpi' | 'hub' | 'cmp'>(props.tab);
  const defaultKpi = props.kpis.find((k) => k.watched_globally)?.id ?? props.kpis[0]?.id ?? '';
  const [activeKpi, setActiveKpi] = useState<string>(props.selectedKpi ?? defaultKpi);

  // Build and push URL without triggering a Next.js server navigation.
  function syncUrl(tab: 'kpi' | 'hub' | 'cmp', kpi: string) {
    const params = new URLSearchParams();
    if (tab !== 'kpi') params.set('tab', tab);
    if (tab === 'kpi' && kpi && kpi !== defaultKpi) params.set('kpi', kpi);
    const url = params.toString() ? `/historicos?${params.toString()}` : '/historicos';
    window.history.pushState(null, '', url);
  }

  const switchTab = (t: 'kpi' | 'hub' | 'cmp') => {
    setActiveTab(t);
    syncUrl(t, activeKpi);
  };

  const switchKpi = (id: string) => {
    setActiveKpi(id);
    syncUrl('kpi', id);
    // If the user is on a different tab, also switch to kpi tab.
    if (activeTab !== 'kpi') setActiveTab('kpi');
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
      <div className="flex gap-1 border-b border-[var(--line)] mb-5 overflow-x-auto">
        <Tab onClick={() => switchTab('kpi')} active={activeTab === 'kpi'}>📈 Por KPI</Tab>
        <Tab onClick={() => switchTab('hub')} active={activeTab === 'hub'}>🏬 Por hub<span className="hidden sm:inline"> · vista 1:1</span></Tab>
        <Tab onClick={() => switchTab('cmp')} active={activeTab === 'cmp'}>⚖️ Comparativa<span className="hidden sm:inline"> entre MHs</span></Tab>
      </div>
      {activeTab === 'kpi' && <PorKpiTab {...props} selectedKpi={activeKpi} onKpiChange={switchKpi} />}
      {activeTab === 'hub' && <PorHubTab {...props} mnaProducts={mnaProducts} faltantesSkuProducts={props.faltantesSkuProducts} assemblerTrend={props.assemblerTrend} driverTrend={props.driverTrend} />}
      {activeTab === 'cmp' && <ComparativaTab {...props} />}
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
