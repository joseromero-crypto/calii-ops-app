import { createServerClient } from '@/lib/supabase-server';
import { lastCompletedWeekStart } from '@/lib/types';
import { HistoricosClient } from './HistoricosClient';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: { tab?: string; kpi?: string; hub?: string; city?: string };
}

export default async function HistoricosPage({ searchParams }: PageProps) {
  const sb = createServerClient();

  const { data: cw } = await sb.from('current_week').select('week_start').single();
  const currentWeek = cw?.week_start ?? lastCompletedWeekStart(new Date()).toISOString().slice(0, 10);

  const since = new Date(currentWeek + 'T00:00:00');
  since.setDate(since.getDate() - 7 * 11);    // 12 weeks total including current
  const sinceIso = since.toISOString().slice(0, 10);

  const [kpisRes, hubsRes, snapshotsRes, peersRes, rolesRes] = await Promise.all([
    sb.from('kpis').select('*').eq('active', true).order('display_order'),
    sb.from('hubs').select('id, display_name, city').eq('active', true).order('id'),
    sb
      .from('kpi_snapshots')
      .select('kpi_id, week_start, scope_level, scope_key, value, numerator, denominator, prev_week_value, rolling_mean_4w')
      .gte('week_start', sinceIso)
      .lte('week_start', currentWeek)
      .in('scope_level', ['hub', 'city', 'global']),
    sb
      .from('peer_comparisons')
      .select('kpi_id, week_start, entity_type, entity_key, scope_type, scope_key, value, peer_mean, z_score, rank, rank_total')
      .eq('week_start', currentWeek),
    sb.from('hub_roles').select('id, name_es'),
  ]);

  return (
    <HistoricosClient
      kpis={kpisRes.data ?? []}
      hubs={hubsRes.data ?? []}
      snapshots={snapshotsRes.data ?? []}
      peers={peersRes.data ?? []}
      roles={rolesRes.data ?? []}
      currentWeek={currentWeek}
      tab={(searchParams.tab as 'kpi' | 'hub' | 'cmp' | undefined) ?? 'kpi'}
      selectedKpi={searchParams.kpi}
      selectedHub={searchParams.hub}
      selectedCity={searchParams.city}
    />
  );
}
