import { createServerClient } from '@/lib/supabase-server';
import { lastCompletedWeekStart } from '@/lib/types';
import { HistoricosClient } from './HistoricosClient';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: { tab?: string; kpi?: string; hub?: string; city?: string };
}

const PAGE = 1000;

export default async function HistoricosPage({ searchParams }: PageProps) {
  const sb = createServerClient();

  // ── Step 1: resolve current week ────────────────────────────────────────────
  // Try the current_week view first; fall back to MAX(week_start) from snapshots.
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
  since.setDate(since.getDate() - 7 * 51); // 52 weeks for timeline selector
  const sinceIso = since.toISOString().slice(0, 10);

  // ── Step 2: parallel counts + registry + MNA upload list ────────────────────
  // Run everything that doesn't depend on row data simultaneously.
  // head:true / count:'exact' queries return only the row count (no data),
  // so they are very fast and let us size the parallel page fetches below.
  const [
    snapCountRes,
    peerCountRes,
    mnaUploadsRes,
    kpisRes,
    hubsRes,
    rolesRes,
  ] = await Promise.all([
    sb
      .from('kpi_snapshots')
      .select('*', { count: 'exact', head: true })
      .gte('week_start', sinceIso)
      .lte('week_start', currentWeek)
      .in('scope_level', ['hub', 'city', 'global']),
    sb
      .from('peer_comparisons')
      .select('*', { count: 'exact', head: true })
      .eq('week_start', currentWeek),
    sb
      .from('uploads')
      .select('id, hub_id')
      .eq('week_start', currentWeek)
      .eq('status', 'validated')
      .eq('app_id', 'mna'),
    sb.from('kpis').select('*').eq('active', true).order('display_order'),
    sb.from('hubs').select('id, display_name, city').eq('active', true).order('id'),
    sb.from('hub_roles').select('id, name_es'),
  ]);

  const snapTotal    = snapCountRes.count ?? 0;
  const peerTotal    = peerCountRes.count ?? 0;
  const mnaUploadList = mnaUploadsRes.data ?? [];

  // ── Step 3: MNA row count (needs upload IDs from step 2) ────────────────────
  // This is the only sequential dependency: we need the upload IDs before we
  // can count (and then fetch) their rows.  MNA is small (≤ 7 hubs × ~200 rows)
  // so one extra round-trip here is negligible.
  let mnaTotal = 0;
  if (mnaUploadList.length > 0) {
    const { count } = await sb
      .from('upload_rows')
      .select('*', { count: 'exact', head: true })
      .in('upload_id', mnaUploadList.map((u) => u.id))
      .eq('is_excluded', false);
    mnaTotal = count ?? 0;
  }

  // ── Step 4: fetch ALL pages in parallel ─────────────────────────────────────
  // Generate page-index arrays from the counts we already have, then fire
  // every page request simultaneously across all three tables.
  const snapIdxs = Array.from({ length: Math.ceil(snapTotal / PAGE) }, (_, i) => i);
  const peerIdxs = Array.from({ length: Math.ceil(peerTotal / PAGE) }, (_, i) => i);
  const mnaIdxs  = Array.from({ length: Math.ceil(mnaTotal  / PAGE) }, (_, i) => i);

  const [snapPages, peerPages, mnaRawPages] = await Promise.all([
    Promise.all(
      snapIdxs.map((i) =>
        sb
          .from('kpi_snapshots')
          .select(
            'kpi_id, week_start, scope_level, scope_key, value, numerator, denominator, prev_week_value, rolling_mean_4w'
          )
          .gte('week_start', sinceIso)
          .lte('week_start', currentWeek)
          .in('scope_level', ['hub', 'city', 'global'])
          .order('week_start', { ascending: true })
          .range(i * PAGE, (i + 1) * PAGE - 1)
      )
    ),
    Promise.all(
      peerIdxs.map((i) =>
        sb
          .from('peer_comparisons')
          .select(
            'kpi_id, week_start, entity_type, entity_key, hub_id, scope_type, scope_key, value, peer_mean, z_score, rank, rank_total'
          )
          .eq('week_start', currentWeek)
          .order('entity_type', { ascending: true })
          .range(i * PAGE, (i + 1) * PAGE - 1)
      )
    ),
    mnaIdxs.length > 0
      ? Promise.all(
          mnaIdxs.map((i) =>
            sb
              .from('upload_rows')
              .select('upload_id, data')
              .in('upload_id', mnaUploadList.map((u) => u.id))
              .eq('is_excluded', false)
              .range(i * PAGE, (i + 1) * PAGE - 1)
          )
        )
      : Promise.resolve([]),
  ]);

  const allSnaps   = snapPages.flatMap((r) => r.data ?? []);
  const allPeers   = peerPages.flatMap((r) => r.data ?? []);
  const allMnaRows = mnaRawPages.flatMap((r) => r.data ?? []);

  // ── Step 5: aggregate MNA products for tile flip ─────────────────────────────
  // Normalize a raw hub string to the canonical slug used in hubs.id.
  // Mirrors HUB_ALIAS_MAP in kpi-compute.ts.
  function resolveHubId(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const s = raw
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '_');
    if (s.startsWith('ch_')) return null;
    const map: Record<string, string> = {
      mh_contry: 'mh_contry',     contry: 'mh_contry',
      mh_cumbres: 'mh_cumbres',   cumbres: 'mh_cumbres',
      mh_san_nicolas: 'mh_san_nicolas', san_nicolas: 'mh_san_nicolas',
      mh_guadalupe: 'mh_guadalupe',    guadalupe: 'mh_guadalupe',
      mh_avicola: 'mh_avicola',   avicola: 'mh_avicola',
      mh_saltillo: 'mh_avicola',  saltillo: 'mh_avicola',
      mh_zapopan: 'mh_zapopan',   zapopan: 'mh_zapopan',
      mh_condesa: 'mh_condesa',   condesa: 'mh_condesa',
      mh_san_pedro: 'mh_san_pedro', san_pedro: 'mh_san_pedro',
    };
    return map[s] ?? s;
  }

  const mnaProducts: { hub_id: string; producto: string; pct: number; amount: number }[] = [];

  if (allMnaRows.length > 0) {
    const mnaById = new Map(mnaUploadList.map((u) => [u.id, u]));
    const mnaAgg  = new Map<
      string,
      { hub_id: string; producto: string; pctNum: number; pctDen: number; amount: number }
    >();

    for (const r of allMnaRows) {
      const u = mnaById.get(r.upload_id);
      if (!u) continue;

      const rawHub =
        u.hub_id ||
        String(
          (r.data as any)['Hub'] ??
            (r.data as any)['geofence'] ??
            (r.data as any)['Geofence'] ??
            ''
        ).trim() ||
        null;
      const hubId = resolveHubId(rawHub);
      if (!hubId) continue;

      const producto = String((r.data as any)['Producto'] ?? '').trim();
      if (!producto) continue;

      // Use MNA (kg/pz) — exact measured missing units — as numerator.
      // Avoids MNA(%) × Recibido float rounding; matches Retool's calculation.
      const mnaUnits = Number((r.data as any)['MNA (kg/pz)']) || 0;
      const recibido = Number((r.data as any)['Recibido'])    || 1;
      const amount   = Number((r.data as any)['MNA ($)'])     || 0;

      const key = `${hubId}|${producto}`;
      const ex  = mnaAgg.get(key);
      if (ex) {
        ex.pctNum += mnaUnits;
        ex.pctDen += recibido;
        ex.amount += amount;
      } else {
        mnaAgg.set(key, { hub_id: hubId, producto, pctNum: mnaUnits, pctDen: recibido, amount });
      }
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

  // ── Render ───────────────────────────────────────────────────────────────────
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
