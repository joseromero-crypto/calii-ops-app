import { createServerClient } from '@/lib/supabase-server';
import { lastCompletedWeekStart } from '@/lib/types';
import { classifyMnaProduct } from '@/lib/sku-classifier';
import type { MnaCategory } from '@/lib/sku-classifier';
import type { FaltantesSku } from './_shared';
import { HistoricosClient } from './HistoricosClient';
import { resolveHubId } from '@/lib/hub-aliases';

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
    assemblerTrendCountRes,
    driverTrendCountRes,
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
    // Multi-week operator peer data for the assembler WoW charts in Por Hub tab.
    // Scoped to within_hub only — one row per assembler × KPI × week.
    sb
      .from('peer_comparisons')
      .select('*', { count: 'exact', head: true })
      .eq('entity_type', 'operator')
      .eq('scope_type', 'within_hub')
      .gte('week_start', sinceIso)
      .lte('week_start', currentWeek),
    // Multi-week driver peer data for the driver WoW charts in Por Hub tab.
    // Scoped to within_hub — drivers are resolved to hub via desempeno_repartidores cross-ref.
    sb
      .from('peer_comparisons')
      .select('*', { count: 'exact', head: true })
      .eq('entity_type', 'driver')
      .eq('scope_type', 'within_hub')
      .gte('week_start', sinceIso)
      .lte('week_start', currentWeek),
  ]);

  const snapTotal             = snapCountRes.count ?? 0;
  const peerTotal             = peerCountRes.count ?? 0;
  const mnaUploadList         = mnaUploadsRes.data ?? [];
  const faltantesUploadList   = faltantesUploadsRes.data ?? [];
  const assemblerTrendTotal   = assemblerTrendCountRes.count ?? 0;
  const driverTrendTotal      = driverTrendCountRes.count ?? 0;

  // ── Step 4: fetch ALL pages in parallel ─────────────────────────────────────
  //
  // MNA and faltantes upload_rows are fetched ONE UPLOAD AT A TIME (same strategy
  // as kpi-compute.ts). Rationale: range pagination over an IN(upload_ids) query
  // without ORDER BY is non-deterministic — PostgreSQL may return rows in
  // different order across requests, causing pages to overlap or skip rows.
  // Per-upload fetching avoids this: each query is a single index scan on
  // upload_rows(upload_id), O(rows for that upload), no sort, deterministic.
  // limit(10_000) is well above any realistic single-file row count.
  //
  // kpi_snapshots and peer_comparisons are fetched with explicit ORDER BY so
  // their range pagination is stable.
  const snapIdxs           = Array.from({ length: Math.ceil(snapTotal           / PAGE) }, (_, i) => i);
  const peerIdxs           = Array.from({ length: Math.ceil(peerTotal           / PAGE) }, (_, i) => i);
  const assemblerTrendIdxs = Array.from({ length: Math.ceil(assemblerTrendTotal / PAGE) }, (_, i) => i);
  const driverTrendIdxs    = Array.from({ length: Math.ceil(driverTrendTotal    / PAGE) }, (_, i) => i);

  const [snapPages, peerPages, mnaRawPages, faltantesRawPages, assemblerTrendPages, driverTrendPages] = await Promise.all([
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
            'kpi_id, week_start, entity_type, entity_key, scope_type, scope_key, value, peer_mean, z_score, rank, rank_total'
          )
          .eq('week_start', currentWeek)
          .order('entity_type', { ascending: true })
          .range(i * PAGE, (i + 1) * PAGE - 1)
      )
    ),
    // MNA rows: one query per upload to guarantee all rows are fetched.
    mnaUploadList.length > 0
      ? Promise.all(
          mnaUploadList.map((u) =>
            sb
              .from('upload_rows')
              .select('upload_id, data')
              .eq('upload_id', u.id)
              .eq('is_excluded', false)
              .limit(10_000)
          )
        )
      : Promise.resolve([]),
    // Faltantes rows: same per-upload strategy.
    faltantesUploadList.length > 0
      ? Promise.all(
          faltantesUploadList.map((u) =>
            sb
              .from('upload_rows')
              .select('upload_id, data')
              .eq('upload_id', u.id)
              .eq('is_excluded', false)
              .limit(10_000)
          )
        )
      : Promise.resolve([]),
    // Assembler WoW: multi-week operator peers (within_hub scope only).
    assemblerTrendIdxs.length > 0
      ? Promise.all(
          assemblerTrendIdxs.map((i) =>
            sb
              .from('peer_comparisons')
              .select(
                'kpi_id, week_start, entity_type, entity_key, scope_type, scope_key, value, peer_mean, z_score, rank, rank_total'
              )
              .eq('entity_type', 'operator')
              .eq('scope_type', 'within_hub')
              .gte('week_start', sinceIso)
              .lte('week_start', currentWeek)
              .order('week_start', { ascending: true })
              .range(i * PAGE, (i + 1) * PAGE - 1)
          )
        )
      : Promise.resolve([]),
    // Driver WoW: multi-week driver peers (within_hub scope only).
    driverTrendIdxs.length > 0
      ? Promise.all(
          driverTrendIdxs.map((i) =>
            sb
              .from('peer_comparisons')
              .select(
                'kpi_id, week_start, entity_type, entity_key, scope_type, scope_key, value, peer_mean, z_score, rank, rank_total'
              )
              .eq('entity_type', 'driver')
              .eq('scope_type', 'within_hub')
              .gte('week_start', sinceIso)
              .lte('week_start', currentWeek)
              .order('week_start', { ascending: true })
              .range(i * PAGE, (i + 1) * PAGE - 1)
          )
        )
      : Promise.resolve([]),
  ]);

  const allSnaps         = snapPages.flatMap((r) => r.data ?? []);
  const allPeers         = peerPages.flatMap((r) => r.data ?? []);
  const allAssemblerTrend = assemblerTrendPages.flatMap((r) => r.data ?? []);
  const allDriverTrend    = driverTrendPages.flatMap((r) => r.data ?? []);
  const allMnaRows       = mnaRawPages.flatMap((r) => r.data ?? []);
  const allFaltantesRows = faltantesRawPages.flatMap((r) => r.data ?? []);

  // ── Step 5: aggregate MNA products for tile flip ─────────────────────────────
  //
  // Formula: MNA($) / (MNA($) + Recibido × Source price) — monetary, same as
  // kpi_snapshots. Price cancels at individual SKU level so the ranking is
  // equivalent to volume-based, but we use monetary for consistency.
  // resolveHubId is imported from @/lib/hub-aliases — shared with kpi-compute.ts

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

  // 3-minute sliding window deduplication:
  // Multiple rows with the same (hub, assembler, SKU) within 180 s of each
  // other are part of the same faltante incident and count as 1 event.
  // Algorithm: collect raw events → group by (hub|op|producto) → sort by ts
  // → walk sorted list, starting a new session whenever the gap to the prior
  // event exceeds 180 s → count distinct sessions per (hub, producto).
  if (allFaltantesRows.length > 0) {
    const faltantesById = new Map<string, { id: string; hub_id: string | null }>();
    for (const u of faltantesUploadList) faltantesById.set(u.id, u);

    // ── pass 1: parse and normalise every row ──────────────────────────────
    type RawEvent = {
      hubId: string;
      opId: string;
      producto: string;
      tsMs: number;          // epoch ms — NaN for unparseable timestamps
      category: MnaCategory;
    };

    const rawEvents: RawEvent[] = [];

    for (const r of allFaltantesRows) {
      const u = faltantesById.get(r.upload_id);
      if (!u) continue;

      const rawHub =
        u.hub_id ||
        String((r.data as any)['Hub'] ?? '').trim() ||
        null;
      const hubId = resolveHubId(rawHub);
      if (!hubId) continue;

      const producto = String((r.data as any)['Producto']    ?? '').trim();
      const opId     = String((r.data as any)['Operator ID'] ?? '').trim();
      const fechaStr = String((r.data as any)['Fecha']       ?? '').trim();
      if (!producto) continue;

      const tsMs = fechaStr ? new Date(fechaStr).getTime() : NaN;

      const category: MnaCategory =
        skuCategoryFromMna.get(producto) ?? classifyMnaProduct(producto, '');

      rawEvents.push({ hubId, opId, producto, tsMs, category });
    }

    // ── pass 2: group by (hub|op|producto) ────────────────────────────────
    const groups = new Map<string, RawEvent[]>();
    for (const ev of rawEvents) {
      const gk = `${ev.hubId}|${ev.opId}|${ev.producto}`;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk)!.push(ev);
    }

    // ── pass 3: sliding-window session count, then aggregate ──────────────
    const WINDOW_MS = 180_000; // 3 minutes

    for (const events of groups.values()) {
      // Sort ascending by timestamp; rows with NaN ts go to the end.
      events.sort((a, b) => {
        if (isNaN(a.tsMs) && isNaN(b.tsMs)) return 0;
        if (isNaN(a.tsMs)) return 1;
        if (isNaN(b.tsMs)) return -1;
        return a.tsMs - b.tsMs;
      });

      let sessionCount = 0;
      let lastSessionTs = NaN;

      for (const ev of events) {
        if (isNaN(ev.tsMs)) {
          // Unparseable timestamp → treat as a new session (safe fallback)
          sessionCount += 1;
          lastSessionTs = NaN;
          continue;
        }
        if (isNaN(lastSessionTs) || ev.tsMs - lastSessionTs > WINDOW_MS) {
          // Gap exceeds window → new session
          sessionCount += 1;
          lastSessionTs = ev.tsMs;
        } else {
          // Still within the same session — update the anchor so the window
          // slides forward with each qualifying event (chain dedup).
          lastSessionTs = ev.tsMs;
        }
      }

      const { hubId, producto, category } = events[0];
      const aggKey = `${hubId}|${producto}`;
      const ex     = faltantesSkuAgg.get(aggKey);
      if (ex) {
        ex.count += sessionCount;
      } else {
        faltantesSkuAgg.set(aggKey, { hub_id: hubId, producto, count: sessionCount, category });
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
      assemblerTrend={allAssemblerTrend}
      driverTrend={allDriverTrend}
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
