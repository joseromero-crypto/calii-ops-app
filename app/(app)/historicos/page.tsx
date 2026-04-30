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
    if (snapErr) break;
    if (!page || page.length === 0) break;
    allSnaps.push(...page);
    if (page.length < SNAP_PAGE) break;
    snapFrom += page.length;
  }
  // Paginate peer_comparisons the same way — operator rows alone can exceed 1000.
  const PEER_PAGE = 1000;
  const allPeers: any[] = [];
  let peerFrom = 0;
  while (true) {
    const { data: ppage, error: peerErr } = await sb
      .from('peer_comparisons')
      .select('kpi_id, week_start, entity_type, entity_key, hub_id, scope_type, scope_key, value, peer_mean, z_score, rank, rank_total')
      .eq('week_start', currentWeek)
      .order('entity_type', { ascending: true })
      .range(peerFrom, peerFrom + PEER_PAGE - 1);
    if (peerErr) break;
    if (!ppage || ppage.length === 0) break;
    allPeers.push(...ppage);
    if (ppage.length < PEER_PAGE) break;
    peerFrom += ppage.length;
  }
  // MNA products for tile flip — read directly from upload_rows for the current week.
  // This avoids storing SKU-level rows in peer_comparisons entirely.
  const { data: mnaUploads } = await sb
    .from('uploads')
    .select('id, hub_id')
    .eq('week_start', currentWeek)
    .eq('status', 'validated')
    .eq('app_id', 'mna');
  // Normalize a raw hub string (from uploads.hub_id or a row data column) to the
  // canonical slug used in hubs.id.  Mirrors the HUB_ALIAS_MAP in kpi-compute.ts.
  function resolveHubId(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const s = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, '_');
    if (s.startsWith('ch_')) return null;
    const map: Record<string, string> = {
      mh_contry: 'mh_contry', contry: 'mh_contry',
      mh_cumbres: 'mh_cumbres', cumbres: 'mh_cumbres',
      mh_san_nicolas: 'mh_san_nicolas', san_nicolas: 'mh_san_nicolas',
      mh_guadalupe: 'mh_guadalupe', guadalupe: 'mh_guadalupe',
      mh_avicola: 'mh_avicola', avicola: 'mh_avicola', mh_saltillo: 'mh_avicola', saltillo: 'mh_avicola',
      mh_zapopan: 'mh_zapopan', zapopan: 'mh_zapopan',
      mh_condesa: 'mh_condesa', condesa: 'mh_condesa',
      mh_san_pedro: 'mh_san_pedro', san_pedro: 'mh_san_pedro',
    };
    return map[s] ?? s; // already-canonical IDs (e.g. 'mh_contry') pass through unchanged
  }

  const mnaProducts: { hub_id: string; producto: string; pct: number; amount: number }[] = [];
  if (mnaUploads && mnaUploads.length > 0) {
    const mnaById = new Map(mnaUploads.map((u) => [u.id, u]));
    const mnaAgg = new Map<string, { hub_id: string; producto: string; pctNum: number; pctDen: number; amount: number }>();
    let mnaFrom = 0;
    while (true) {
      const { data: mnaPage } = await sb
        .from('upload_rows')
        .select('upload_id, data')
        .in('upload_id', mnaUploads.map((u) => u.id))
        .eq('is_excluded', false)
        .range(mnaFrom, mnaFrom + 999);
      if (!mnaPage || mnaPage.length === 0) break;
      for (const r of mnaPage) {
        const u = mnaById.get(r.upload_id);
        if (!u) continue;
        // Prefer upload.hub_id; fall back to Hub/geofence columns inside the row
        // (city-level uploads may have hub_id = null with a hub column per row).
        const rawHub = u.hub_id
          || String((r.data as any)['Hub'] ?? (r.data as any)['geofence'] ?? (r.data as any)['Geofence'] ?? '').trim()
          || null;
        const hubId = resolveHubId(rawHub);
        if (!hubId) continue;
        const producto = String((r.data as any)['Producto'] ?? '').trim();
        if (!producto) continue;
        const mnaPct   = Number((r.data as any)['MNA (%)'])  || 0;
        const recibido = Number((r.data as any)['Recibido']) || 1;
        const amount   = Number((r.data as any)['MNA ($)'])  || 0;
        const key = `${hubId}|${producto}`;
        const ex = mnaAgg.get(key);
        if (ex) {
          ex.pctNum += mnaPct * recibido;
          ex.pctDen += recibido;
          ex.amount += amount;
        } else {
          mnaAgg.set(key, { hub_id: hubId, producto, pctNum: mnaPct * recibido, pctDen: recibido, amount });
        }
      }
      mnaFrom += mnaPage.length;
      if (mnaPage.length < 1000) break;
    }
    for (const m of mnaAgg.values()) {
      mnaProducts.push({
        hub_id:   m.hub_id,
        producto: m.producto,
        pct:      m.pctDen > 0 ? m.pctNum / m.pctDen : 0,
        amount:   m.amount,
      });
    }
  }
  const [kpisRes, hubsRes, rolesRes] = await Promise.all([
    sb.from('kpis').select('*').eq('active', true).order('display_order'),
    sb.from('hubs').select('id, display_name, city').eq('active', true).order('id'),
    sb.from('hub_roles').select('id, name_es'),
  ]);
  return (
    <HistoricosClient
      kpis={kpisRes.data ?? []}
      hubs={hubsRes.data ?? []}
      snapshots={allSnaps}
      peers={allPeers}
      mnaProducts={mnaProducts}
      roles={rolesRes.data ?? []}
      currentWeek={currentWeek}
      tab={(searchParams.tab as 'kpi' | 'hub' | 'cmp' | undefined) ?? 'kpi'}
      selectedKpi={searchParams.kpi}
      selectedHub={searchParams.hub}
      selectedCity={searchParams.city}
    />
  );
}
