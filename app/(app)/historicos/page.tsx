import { createServerClient } from '@/lib/supabase-server';
import { lastCompletedWeekStart } from '@/lib/types';
import { classifyMnaProduct } from '@/lib/sku-classifier';
import type { MnaCategory } from '@/lib/sku-classifier';
import type { FaltantesSku, KpiTarget, RampTarget } from './_shared';
import { HistoricosClient } from './HistoricosClient';
import { resolveHubId } from '@/lib/hub-aliases';
import { hydrateTenureRow, type PersonTenureDbRow, type Role as TenureRole } from '@/lib/tenure';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: { tab?: string; kpi?: string; hub?: string; city?: string };
}

const PAGE = 1000;

/**
 * Bounded-concurrency gate for Supabase reads on this page (session 15,
 * 2026-09-10, see HANDOFF.md §12 addendum). /historicos broke in production
 * — Netlify observability showed the RSC request completing in ~18s with a
 * ~1KB body under a 200 status, and the browser threw "Error: Connection
 * closed." mid-stream: the signature of the host cutting the connection
 * before the server finished, after headers/streaming had already started
 * (so it can't downgrade to a clean error status). This page fans out to
 * 60+ independent Supabase queries (13 in the initial counts/registry
 * batch, dozens more paging through snapshots/peers/mna/faltantes) — each
 * one is cheap on its own, but 60+ round trips add up fast, and a bare
 * `Promise.all` lets peak concurrency spike unbounded. A single shared
 * limiter across the whole page caps how many requests are in flight at
 * once (same concurrency=8 already proven for this project's Supabase in
 * `lib/analysis/shared.ts`'s `fetchRowsForUploads`), and the MNA branch
 * below was changed from 5 sequential per-upload round trips to 2. Net
 * effect is fewer round trips and a bounded burst — real, structural
 * latency reduction — though the exact number this buys back on Netlify's
 * infrastructure specifically wasn't independently measurable from this
 * session's dev environment (its own network path to Supabase had ~3s of
 * fixed per-connection overhead, confirmed via a bare curl to the Supabase
 * REST endpoint — that's this environment's problem, not the app's, but it
 * means local timing numbers from this session aren't a reliable proxy for
 * Netlify's actual latency budget). Verify against Netlify Observability
 * after deploying, not against local timing.
 */
function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  function runNext() {
    if (queue.length === 0 || active >= concurrency) return;
    active++;
    const task = queue.shift()!;
    task();
  }
  return function limit<T>(fn: () => PromiseLike<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve(fn()).then(
          (v) => { active--; runNext(); resolve(v); },
          (e) => { active--; runNext(); reject(e); }
        );
      });
      runNext();
    });
  };
}

export default async function HistoricosPage({ searchParams }: PageProps) {
  const sb = createServerClient();
  const limit = createLimiter(8);

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
    targetsRes,
    tenureRes,
    rampsRes,
    rosterWeeksRes,
  ] = await Promise.all([
    limit(() => sb
      .from('kpi_snapshots')
      .select('*', { count: 'exact', head: true })
      .gte('week_start', sinceIso)
      .lte('week_start', currentWeek)
      .in('scope_level', ['hub', 'city', 'global'])),
    limit(() => sb
      .from('peer_comparisons')
      .select('*', { count: 'exact', head: true })
      .eq('week_start', currentWeek)),
    limit(() => sb
      .from('uploads')
      .select('id, hub_id')
      .eq('week_start', currentWeek)
      .eq('status', 'validated')
      .eq('app_id', 'mna')),
    limit(() => sb
      .from('uploads')
      .select('id, hub_id')
      .eq('week_start', currentWeek)
      .eq('status', 'validated')
      .eq('app_id', 'faltantes_armador')),
    limit(() => sb.from('kpis').select('*').eq('active', true).order('display_order')),
    limit(() => sb.from('hubs').select('id, display_name, city').eq('active', true).order('id')),
    limit(() => sb.from('hub_roles').select('id, name_es')),
    // Multi-week operator peer data for the assembler WoW charts in Por Hub tab.
    // Scoped to within_hub only — one row per assembler × KPI × week.
    limit(() => sb
      .from('peer_comparisons')
      .select('*', { count: 'exact', head: true })
      .eq('entity_type', 'operator')
      .eq('scope_type', 'within_hub')
      .gte('week_start', sinceIso)
      .lte('week_start', currentWeek)),
    // Multi-week driver peer data for the driver WoW charts in Por Hub tab.
    // Scoped to within_hub — drivers are resolved to hub via desempeno_repartidores cross-ref.
    limit(() => sb
      .from('peer_comparisons')
      .select('*', { count: 'exact', head: true })
      .eq('entity_type', 'driver')
      .eq('scope_type', 'within_hub')
      .gte('week_start', sinceIso)
      .lte('week_start', currentWeek)),
    // Configurable KPI targets — tiny table, no pagination needed.
    limit(() => sb.from('kpi_targets').select('kpi_id, scope_level, scope_key, target_value, comparator, unit, active').eq('active', true)),
    // Modo Entrenamiento (session 14) — tenure ledger + ramp targets. Both
    // tiny (hundreds / tens of rows), no pagination needed.
    limit(() => sb.from('person_tenure').select('*')),
    limit(() => sb.from('kpi_ramp_targets').select('kpi_id, role, week_number, target_value, stretch_value, comparator, unit, active').eq('active', true)),
    // Validated-upload weeks for the two roster apps — needed to recompute
    // each tenure row's reentry_weeks (not a person_tenure column, see
    // lib/tenure.ts's hydrateTenureRow doc comment).
    limit(() => sb.from('uploads').select('app_id, week_start').eq('status', 'validated').in('app_id', ['desempeno_operadores', 'desempeno_repartidores'])),
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
        limit(() => sb
          .from('kpi_snapshots')
          .select(
            'kpi_id, week_start, scope_level, scope_key, value, numerator, denominator, prev_week_value, rolling_mean_4w'
          )
          .gte('week_start', sinceIso)
          .lte('week_start', currentWeek)
          .in('scope_level', ['hub', 'city', 'global'])
          .order('week_start', { ascending: true })
          .range(i * PAGE, (i + 1) * PAGE - 1))
      )
    ),
    Promise.all(
      peerIdxs.map((i) =>
        limit(() => sb
          .from('peer_comparisons')
          .select(
            'kpi_id, week_start, entity_type, entity_key, scope_type, scope_key, value, peer_mean, z_score, rank, rank_total'
          )
          .eq('week_start', currentWeek)
          // Four-column sort guarantees a stable total order across pages.
          // With only entity_type, rows within each type are in heap order which
          // can shift between requests (VACUUM, concurrent writes), causing
          // OFFSET pagination to skip or duplicate rows.
          .order('entity_type',  { ascending: true })
          .order('kpi_id',       { ascending: true })
          .order('scope_type',   { ascending: true })
          .order('scope_key',    { ascending: true, nullsFirst: false })
          .order('entity_key',   { ascending: true })
          .range(i * PAGE, (i + 1) * PAGE - 1))
      )
    ),
    // MNA rows: PAGED within each upload to guarantee all rows are fetched.
    // ⚠️ CORRECTED (BUILD.md Phase 2, 2026-09-09): this project's PostgREST
    // Max Rows is 1000 and silently caps `.limit()` too — a real mna upload
    // has ~5,000 true rows, so `.limit(10_000)` here was silently returning
    // only the first 1000 (verified). mna is the only app whose uploads
    // exceed 1000 rows; every other per-upload fetch on this page (faltantes
    // below) was checked and stays safely under the cap.
    //
    // ⚠️ PERFORMANCE FIX (session 15, 2026-09-10): the first version of this
    // correctness fix paged each upload SEQUENTIALLY (a `for` loop awaiting
    // one range() at a time — 5 round trips for a ~4,800-row upload). That
    // measured at a clean, uncontended 23.2s of real SSR time in a production
    // build against real prod data — well past any serverless function
    // timeout — and broke /historicos on Netlify entirely (client saw
    // "Error: Connection closed." mid-RSC-stream, the signature of the host
    // killing the connection mid-response). Fixed by getting each upload's
    // row COUNT first (cheap head query, all uploads in parallel, ~1 round
    // trip) then firing every page's range() query for every upload in one
    // flat Promise.all (~1 more round trip, all pages in parallel) — 2 round
    // trips total instead of 5 sequential ones. Safe because each range()
    // query is an independent single-index-scan on upload_id (see comment
    // above), not a cursor depending on a previous page's result.
    mnaUploadList.length > 0
      ? (async () => {
          const MNA_PAGE = 1000;
          const counts = await Promise.all(
            mnaUploadList.map((u) =>
              limit(() => sb.from('upload_rows').select('*', { count: 'exact', head: true })
                .eq('upload_id', u.id).eq('is_excluded', false))
            )
          );
          const pageRequests: PromiseLike<{ data: { upload_id: string; data: Record<string, unknown> }[] | null; error: unknown }>[] = [];
          mnaUploadList.forEach((u, idx) => {
            const total = counts[idx].count ?? 0;
            const pages = Math.max(1, Math.ceil(total / MNA_PAGE));
            for (let p = 0; p < pages; p++) {
              const from = p * MNA_PAGE;
              pageRequests.push(
                limit(() => sb.from('upload_rows').select('upload_id, data')
                  .eq('upload_id', u.id).eq('is_excluded', false)
                  .range(from, from + MNA_PAGE - 1))
              );
            }
          });
          return Promise.all(pageRequests);
        })()
      : Promise.resolve([]),
    // Faltantes rows: same per-upload strategy.
    (faltantesUploadList.length > 0
      ? Promise.all(
          faltantesUploadList.map((u) =>
            limit(() => sb
              .from('upload_rows')
              .select('upload_id, data')
              .eq('upload_id', u.id)
              .eq('is_excluded', false)
              .limit(10_000))
          )
        )
      : Promise.resolve([])
    ),
    // Assembler WoW: multi-week operator peers (within_hub scope only).
    (assemblerTrendIdxs.length > 0
      ? Promise.all(
          assemblerTrendIdxs.map((i) =>
            limit(() => sb
              .from('peer_comparisons')
              .select(
                'kpi_id, week_start, entity_type, entity_key, scope_type, scope_key, value, peer_mean, z_score, rank, rank_total'
              )
              .eq('entity_type', 'operator')
              .eq('scope_type', 'within_hub')
              .gte('week_start', sinceIso)
              .lte('week_start', currentWeek)
              .order('week_start', { ascending: true })
              .range(i * PAGE, (i + 1) * PAGE - 1))
          )
        )
      : Promise.resolve([])
    ),
    // Driver WoW: multi-week driver peers (within_hub scope only).
    (driverTrendIdxs.length > 0
      ? Promise.all(
          driverTrendIdxs.map((i) =>
            limit(() => sb
              .from('peer_comparisons')
              .select(
                'kpi_id, week_start, entity_type, entity_key, scope_type, scope_key, value, peer_mean, z_score, rank, rank_total'
              )
              .eq('entity_type', 'driver')
              .eq('scope_type', 'within_hub')
              .gte('week_start', sinceIso)
              .lte('week_start', currentWeek)
              .order('week_start', { ascending: true })
              .range(i * PAGE, (i + 1) * PAGE - 1))
          )
        )
      : Promise.resolve([])
    ),
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

  // ── Step 7: hydrate the tenure ledger (Modo Entrenamiento, session 14) ──────
  //
  // weeksWithData is per-app (armador -> desempeno_operadores, repartidor ->
  // desempeno_repartidores) — required to recompute each row's reentry_weeks,
  // which is not a person_tenure column (see lib/tenure.ts).
  const ROSTER_APP_BY_ROLE: Record<TenureRole, string> = {
    armador: 'desempeno_operadores',
    repartidor: 'desempeno_repartidores',
  };
  const rosterWeeks = rosterWeeksRes.data ?? [];
  const weeksWithDataByRole: Record<TenureRole, Set<string>> = {
    armador: new Set(rosterWeeks.filter((u) => u.app_id === ROSTER_APP_BY_ROLE.armador).map((u) => u.week_start)),
    repartidor: new Set(rosterWeeks.filter((u) => u.app_id === ROSTER_APP_BY_ROLE.repartidor).map((u) => u.week_start)),
  };
  const tenureRows = ((tenureRes.data ?? []) as PersonTenureDbRow[]).map((row) =>
    hydrateTenureRow(row, weeksWithDataByRole[row.role])
  );

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
      targets={(targetsRes.data ?? []) as KpiTarget[]}
      tenureRows={tenureRows}
      ramps={(rampsRes.data ?? []) as RampTarget[]}
      currentWeek={currentWeek}
      tab={(searchParams.tab as 'kpi' | 'hub' | 'cmp' | 'res' | undefined) ?? 'kpi'}
      selectedKpi={searchParams.kpi}
      selectedHub={searchParams.hub}
      selectedCity={searchParams.city}
    />
  );
}
