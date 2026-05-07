'use client';
import type { Kpi, Hub, Snapshot, Peer, MnaProduct, FaltantesSku } from './_shared';
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
  currentWeek: string;
  tab: 'kpi' | 'hub' | 'cmp';
  selectedKpi?: string;
  selectedHub?: string;
  selectedCity?: string;
}
export function HistoricosClient(props: Props) {
  const { kpis, hubs, currentWeek, tab, mnaProducts } = props;
  const tabHref = (t: string, extras: Record<string, string | undefined> = {}) => {
    const params = new URLSearchParams();
    if (t !== 'kpi') params.set('tab', t);
    for (const [k, v] of Object.entries(extras)) if (v) params.set(k, v);
    return params.toString() ? `/historicos?${params.toString()}` : '/historicos';
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
        <Tab href={tabHref('kpi')}  active={tab === 'kpi'}>📈 Por KPI</Tab>
        <Tab href={tabHref('hub')}  active={tab === 'hub'}>🏬 Por hub<span className="hidden sm:inline"> · vista 1:1</span></Tab>
        <Tab href={tabHref('cmp')}  active={tab === 'cmp'}>⚖️ Comparativa<span className="hidden sm:inline"> entre MHs</span></Tab>
      </div>
      {tab === 'kpi' && <PorKpiTab {...props} />}
      {tab === 'hub' && <PorHubTab {...props} mnaProducts={mnaProducts} faltantesSkuProducts={props.faltantesSkuProducts} assemblerTrend={props.assemblerTrend} driverTrend={props.driverTrend} />}
      {tab === 'cmp' && <ComparativaTab {...props} />}
    </div>
  );
}
function Tab({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className={`shrink-0 whitespace-nowrap px-3.5 py-2.5 text-[13px] font-medium border-b-2 -mb-px ${
        active
          ? 'border-teal-400 text-[var(--ink)] font-semibold'
          : 'border-transparent text-[var(--muted)] hover:text-[var(--ink)]'
      }`}
    >
      {children}
    </a>
  );
}
