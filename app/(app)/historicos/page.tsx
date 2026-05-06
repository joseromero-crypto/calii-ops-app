import { createServerClient } from '@/lib/supabase-server';
import { lastCompletedWeekStart } from '@/lib/types';
import { classifyMnaProduct } from '@/lib/sku-classifier';
import type { MnaCategory } from '@/lib/sku-classifier';
import type { FaltantesSku } from './_shared';
import { HistoricosClient } from './HistoricosClient';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: { tab?: string; kpi?: string; hub?: string; city?: string };
}

const PAGE = 1000;

export default async function HistoricosPage({ searchParams }: PageProps) {
  const sb = createServerClient();

  // ── Step 1: resolve current week ────────────────────────────────────────────
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
  since.setDate(since.getDate() - 7 * 51);
  const sinceIso = since.toISOString().slice(0, 10);

  // ── Step 2: parallel counts + registry + MNA upload list ────────────────────
  const [
    snapCountRes,
    peerCountRes,
    mnaUploadsRes,
    faltantesUploadsRes,
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
    sb
      .from('uploads')
      .select('id, hub_id')
      .eq('week_start', currentWeek)
      .eq('status', 'validated')
      .eq('app_id', 'faltantes_armador'),
    sb.from('kpis').select('*').eq('active', true).order('display_order'),
    sb.from('hubs').select('id, display_name, city').eq('active', true).order('id'),
    sb.from('hub_roles').select('id, name_es'),
  ]);

  const snapTotal          = snapCountRes.count ?? 0;
  const peerTotal          = peerCountRes.count ?? 0;
  const mnaUploadList      = mnaUploadsRes.data ?? [];
  const faltantesUploadList = faltantesUploadsRes.data ?? [];

  // ── Step 3: MNA + faltantes row counts ──────────────────────────────────────
  let mnaTotal       = 0;
  let faltantesTotal = 0;
  await Promise.all([
    mnaUploadList.length > 0
      ? sb
          .from('upload_rows')
          .select('*', { count: 'exact', head: true })
          .in('upload_id', mnaUploadList.map((u) => u.id))
          .eq('is_excluded', false)
          .then(({ count }) => { mnaTotal = count ?? 0; })
      : Promise.resolve(),
    faltantesUploadList.length > 0
      ? sb
          .from('upload_rows')
          .select('*', { count: 'exact', head: true })
          .in('upload_id', faltantesUploadList.map((u) => u.id))
          .eq('is_excluded', false)
          .then(({ count }) => { faltantesTotal = count ?? 0; })
      : Promise.resolve(),
  ]);

  // ── Step 4: fetch ALL pages in parallel ─────────────────────────────────────
  const snapIdxs      = Array.from({ length: Math.ceil(snapTotal      / PAGE) }, (_, i) => i);
  const peerIdxs      = Array.from({ length: Math.ceil(peerTotal      / PAGE) }, (_, i) => i);
  const mnaIdxs       = Array.from({ length: Math.ceil(mnaTotal       / PAGE) }, (_, i) => i);
  const faltantesIdxs = Array.from({ length: Math.ceil(faltantesTotal / PAGE) }, (_, i) => i);

  const [snapPages, peerPages, mnaRawPages, faltantesRawPages] = await Promise.all([
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
    faltantesIdxs.length > 0
      ? Promise.all(
          faltantesIdxs.map((i) =>
            sb
              .from('upload_rows')
              .select('upload_id, data')
              .in('upload_id', faltantesUploadList.map((u) => u.id))
              .eq('is_excluded', false)
              .range(i * PAGE, (i + 1) * PAGE - 1)
          )
        )
      : Promise.resolve([]),
  ]);

  const allSnaps         = snapPages.flatMap((r) => r.data ?? []);
  const allPeers         = peerPages.flatMap((r) => r.data ?? []);
  const allMnaRows       = mnaRawPages.flatMap((r) => r.data ?? []);
  const allFaltantesRows = faltantesRawPages.flatMap((r) => r.data ?? []);

  // ── Step 5: aggregate MNA products for tile flip ─────────────────────────────
  //
  // Formula: MNA($) / (MNA($) + Recibido × Source price) — monetary, same as
  // kpi_snapshots. Price cancels at individual SKU level so the ranking is
  // equivalent to volume-based, but we use monetary for consistency.
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
      mh_contry: 'mh_contry',          contry: 'mh_contry',
      mh_cumbres: 'mh_cumbres',        cumbres: 'mh_cumbres',
      mh_san_nicolas: 'mh_san_nicolas', san_nicolas: 'mh_san_nicolas',
      mh_guadalupe: 'mh_guadalupe',    guadalupe: 'mh_guadalupe',
      mh_avicola: 'mh_avicola',        avicola: 'mh_avicola',
      mh_saltillo: 'mh_avicola',       saltillo: 'mh_avicola',
      mh_zapopan: 'mh_zapopan',        zapopan: 'mh_zapopan',
      mh_condesa: 'mh_condesa',        condesa: 'mh_condesa',
      mh_san_pedro: 'mh_san_pedro',    san_pedro: 'mh_san_pedro',
    };
    return map[s] ?? s;
  }

  type MnaAggEntry = {
    hub_id: string;
    producto: string;
    pctNum: number;   // SUM(MNA $)
    pctDen: number;   // SUM(Recibido × Source price)
    amount: number;   // SUM(MNA $) — same as pctNum, kept for clarity
    category: MnaCategory;
  };

  const mnaProducts: { hub_id: string; producto: string; pct: number; amount: number; category: MnaCategory }[] = [];

  if (allMnaRows.length > 0) {
    const mnaById = new Map<string, { id: string; hub_id: string | null }>();
    for (const u of mnaUploadList) {
      mnaById.set(u.id, u);
    }

    const mnaAgg = new Map<string, MnaAggEntry>();

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

      const producto   = String((r.data as any)['Producto']     ?? '').trim();
      const proveedor  = String((r.data as any)['Proveedor']    ?? '').trim();
      if (!producto) continue;

      const mnaAmount  = Number((r.data as any)['MNA ($)'])      || 0;
      const recibido   = Number((r.data as any)['Recibido'])     || 0;
      const srcPrice   = Number((r.data as any)['Source price']) || 0;
      const revenue    = recibido * srcPrice;

      const key = `${hubId}|${producto}`;
      const ex  = mnaAgg.get(key);
      if (ex) {
        ex.pctNum += mnaAmount;
        ex.pctDen += revenue;
        ex.amount += mnaAmount;
      } else {
        // Category is set on first encounter — consistent across rows for the
        // same producto since supplier doesn't vary within a product.
        const category = classifyMnaProduct(producto, proveedor);
        mnaAgg.set(key, {
          hub_id: hubId,
          producto,
          pctNum: mnaAmount,
          pctDen: revenue,
          amount: mnaAmount,
          category,
        });
      }
    }

    for (const m of mnaAgg.values()) {
      const throughput = m.pctNum + m.pctDen;
      mnaProducts.push({
        hub_id:   m.hub_id,
        producto: m.producto,
        pct:      throughput > 0 ? m.pctNum / throughput : 0,
        amount:   m.amount,
        category: m.category,
      });
    }
  }

  // ── Step 6: aggregate faltantes SKUs for subcategory tile flips ─────────────
  //
  // Category is resolved by cross-referencing the product name against MNA rows
  // (which carry supplier data for accurate classification). Products not found
  // in MNA fall back to keyword-only classification via classifyMnaProduct.
  //
  // The hub_id for each row is read from the breakdown upload's hub_id field;
  // if that is null (city-level upload), resolved via the Hub column instead.
  const skuCategoryFromMna = new Map<string, MnaCategory>();
  for (const r of allMnaRows) {
    const producto  = String((r.data as any)['Producto']  ?? '').trim();
    const proveedor = String((r.data as any)['Proveedor'] ?? '').trim();
    if (producto && !skuCategoryFromMna.has(producto)) {
      skuCategoryFromMna.set(producto, classifyMnaProduct(producto, proveedor));
    }
  }

  const faltantesSkuAgg = new Map<string, FaltantesSku>();

  if (allFaltantesRows.length > 0) {
    const faltantesById = new Map<string, { id: string; hub_id: string | null }>();
    for (const u of faltantesUploadList) faltantesById.set(u.id, u);

    for (const r of allFaltantesRows) {
      const u = faltantesById.get(r.upload_id);
      if (!u) continue;

      const rawHub =
        u.hub_id ||
        String((r.data as any)['Hub'] ?? '').trim() ||
        null;
      const hubId = resolveHubId(rawHub);
      if (!hubId) continue;

      const producto = String((r.data as any)['Producto'] ?? '').trim();
      if (!producto) continue;

      // Resolve category: prefer MNA cross-reference, fall back to keyword-only
      const category: MnaCategory =
        skuCategoryFromMna.get(producto) ?? classifyMnaProduct(producto, '');

      const key = `${hubId}|${producto}`;
      const ex  = faltantesSkuAgg.get(key);
      if (ex) {
        ex.count += 1;
      } else {
        faltantesSkuAgg.set(key, { hub_id: hubId, producto, count: 1, category });
      }
    }
  }

  const faltantesSkuProducts: FaltantesSku[] = Array.from(faltantesSkuAgg.values());

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <HistoricosClient
      kpis={kpisRes.data ?? []}
      hubs={hubsRes.data ?? []}
      snapshots={allSnaps}
      peers={allPeers}
      mnaProducts={mnaProducts}
      faltantesSkuProducts={faltantesSkuProducts}
      roles={rolesRes.data ?? []}
      currentWeek={currentWeek}
      tab={(searchParams.tab as 'kpi' | 'hub' | 'cmp' | undefined) ?? 'kpi'}
      selectedKpi={searchParams.kpi}
      selectedHub={searchParams.hub}
      selectedCity={searchParams.city}
    />
  );
}
