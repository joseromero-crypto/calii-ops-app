import { createServerClient } from '@/lib/supabase-server';
import { HistoricosClient } from './HistoricosClient';

export const dynamic = 'force-dynamic';

interface PageProps { searchParams: { kpi?: string } }

export default async function HistoricosPage({ searchParams }: PageProps) {
  const supabase = createServerClient();

  const [{ data: kpis }, { data: hubs }] = await Promise.all([
    supabase
      .from('kpis')
      .select('id, name_es, unit, direction, category, watched_globally, parent_kpi_id, display_order')
      .eq('active', true)
      .order('display_order'),
    supabase.from('hubs').select('id, display_name, city').eq('active', true).order('id'),
  ]);

  const selectedKpi = searchParams.kpi ?? (kpis?.find((k: any) => k.watched_globally)?.id ?? kpis?.[0]?.id);
  if (!selectedKpi) {
    return (
      <div>
        <h1 className="text-[22px] font-bold tracking-tight mb-1">Históricos &amp; análisis</h1>
        <p className="text-[var(--muted)]">No hay KPIs configurados. Revisa Configuración.</p>
      </div>
    );
  }

  // Pull all snapshots for the selected KPI, last 26 weeks max
  const since = new Date();
  since.setDate(since.getDate() - 7 * 26);
  const sinceIso = since.toISOString().slice(0, 10);

  const { data: snapshots } = await supabase
    .from('kpi_snapshots')
    .select('week_start, scope_level, scope_key, value, numerator, denominator, prev_week_value')
    .eq('kpi_id', selectedKpi)
    .gte('week_start', sinceIso)
    .order('week_start', { ascending: true });

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-[22px] font-bold tracking-tight">Históricos &amp; análisis</h1>
        <div className="text-[var(--muted)] text-[13px] mt-1">
          Verifica, compara y forma tu propia opinión a partir de los datos cargados.
        </div>
      </div>

      <HistoricosClient
        kpis={kpis ?? []}
        hubs={hubs ?? []}
        selectedKpi={selectedKpi}
        snapshots={snapshots ?? []}
      />
    </div>
  );
}
