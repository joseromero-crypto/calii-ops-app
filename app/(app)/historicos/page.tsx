import { createServerClient } from '@/lib/supabase-server';
import { lastCompletedWeekStart } from '@/lib/types';
import { HistoricosClient } from './HistoricosClient';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: { tab?: string; kpi?: string; hub?: string; city?: string };
}

export default async function HistoricosPage({ searchParams }: PageProps) {
  const sb = createServerClient();

  // 1. Try the current_week view first.
  // 2. If null (view missing or no uploads yet), fall back to the most recent week
  //    that actually has snapshot data — avoids the off-by-one where
  //    lastCompletedWeekStart() returns the week AFTER the last uploaded week.
  const { data: cw } = await sb.from('current_week').select('week_start').single();
  let currentWeek = cw?.week_start as string | undefined;

  if (!currentWeek) {
    const { data: latestSnap } = await sb
      .from('kpi_snapshots')
      .select('week_start')
      .order('week_start', { ascending: false })
      .limit(1)
      .single();
    currentWeek =
      (latestSnap?.week_start as string | undefined) ??
      lastCompletedWeekStart(new Date()).toISOString().slice(0, 10);
  }

  const since = new Date(currentWeek + 'T00:00:00');
  since.setDate(since.getDate() - 7 * 51); // fetch 52 weeks so timeline selector has full range
  const sinceIso = since.toISOString().slice(0, 10);

  // PostgREST applies a hard max-rows cap server-side that .limit() cannot override.
  // Paginate kpi_snapshots in 1000-row chunks to guarantee we get everything.
  const SNAP_PAGE = 1000;
  const allSnaps: any[] = [];
  let snapFrom = 0;
  while (true) {
    const { data: page, error: snapErr } = await sb
      .from('kpi_snapshots')
      .select('kpi_id, week_start, scope_level, scope_key, value, numerator, denominator, prev_week_value, rolling_mean_4w')
      .gte('week_start', sinceIso)
      .lte('week_start', currentWeek)
      .in('scope_level', ['hub', 'city', 'global'])
      .order('week_start', { ascending: true })
      .range(snapFrom, snapFrom + SNAP_PAGE - 1);
    if (snapErr) break; // surface as empty rather than crashing
    if (!page || page.length === 0) break;
    allSnaps.push(...page);
    if (page.length < SNAP_PAGE) break;
    snapFrom += page.length;
  }

  const [kpisRes, hubsRes, peersRes, rolesRes] = await Promise.all([
    sb.from('kpis').select('*').eq('active', true).order('display_order'),
    sb.from('hubs').select('id, display_name, city').eq('active', true).order('id'),
    sb
      .from('peer_comparisons')
      .select('kpi_id, week_start, entity_type, entity_key, hub_id, scope_type, scope_key, value, peer_mean, z_score, rank, rank_total')
      .eq('week_start', currentWeek),
    sb.from('hub_roles').select('id, name_es'),
  ]);

  return (
    <HistoricosClient
      kpis={kpisRes.data ?? []}
      hubs={hubsRes.data ?? []}
      snapshots={allSnaps}
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
