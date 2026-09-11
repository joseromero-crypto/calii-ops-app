/**
 * GET /api/historicos/mna-products?hub=<hub_id>[&week=<YYYY-MM-DD>]
 *
 * Tile-flip + report data for ONE hub: the MNA product ranking and the
 * faltantes SKU ranking, aggregated from raw `upload_rows`.
 *
 * ── Why this is a route and not part of the page (session 16, 2026-09-11) ────
 * This aggregation used to run inside `app/(app)/historicos/page.tsx` on every
 * single request, for EVERY hub, blocking the RSC stream. With ~5,000 rows per
 * MNA upload and one upload per hub, that is ~35,000 JSONB blobs pulled over
 * HTTP and parsed before the page could render — and it was pure waste, because
 * both consumers of this data are user-triggered and hub-scoped:
 *
 *   1. the KPI tile flips in PorHubTab (clic en tile para ver ranking), and
 *   2. the "Generar reporte" button.
 *
 * Neither is on screen at first paint, and both only ever look at the currently
 * selected hub. So the page no longer fetches any of it; PorHubTab requests
 * just the selected hub's slice in the background and caches it per hub.
 *
 * Net effect vs. the old inline version: ~1 upload's worth of rows instead of
 * ~7, off the critical path entirely. See HANDOFF.md §26.
 *
 * ── Why `hub_id is null` uploads are included ────────────────────────────────
 * An MNA/faltantes upload can be city-level (one file covering several hubs,
 * `uploads.hub_id` null) — those rows carry their own 'Hub'/'geofence' column
 * and are resolved per row via resolveHubId(). Filtering the upload list on
 * `hub_id = :hub` alone would silently drop every hub fed by a city-level file,
 * so the query is `hub_id.eq.<hub> OR hub_id.is.null` and the per-row hub
 * resolution below does the final filtering. Rows resolving to a different hub
 * are discarded, so the response is exactly the selected hub's slice.
 *
 * Aggregation logic is byte-for-byte the logic that used to live in Steps 5–6
 * of page.tsx — same monetary MNA formula, same 3-minute sliding-window
 * faltantes dedup — moved, not rewritten.
 */
import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase-server';
import { classifyMnaProduct } from '@/lib/sku-classifier';
import type { MnaCategory } from '@/lib/sku-classifier';
import { resolveHubId } from '@/lib/hub-aliases';
import { lastCompletedWeekStart } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MNA_PAGE = 1000;

/** Bounded-concurrency gate — same pattern/limit as lib/analysis/shared.ts. */
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

type UploadRef = { id: string; hub_id: string | null };
type RawRow = { upload_id: string; data: Record<string, unknown> };

/**
 * Fetch every non-excluded row for the given uploads.
 *
 * Paged per upload: this project's PostgREST Max Rows is 1000 and silently
 * caps `.limit()` too, so a ~5,000-row MNA upload needs real pagination
 * (BUILD.md Phase 2). Counts first (all uploads in parallel), then every
 * page of every upload in one flat Promise.all — 2 round trips, not N
 * sequential ones. Safe because each range() is an independent index scan
 * on upload_rows(upload_id), not a cursor over a previous page's result.
 */
async function fetchUploadRows(
  sb: ReturnType<typeof createServerClient>,
  uploads: UploadRef[],
  limit: <T>(fn: () => PromiseLike<T>) => Promise<T>,
): Promise<RawRow[]> {
  if (uploads.length === 0) return [];

  const counts = await Promise.all(
    uploads.map((u) =>
      limit(() => sb.from('upload_rows').select('*', { count: 'exact', head: true })
        .eq('upload_id', u.id).eq('is_excluded', false))
    )
  );

  const pageRequests: PromiseLike<{ data: RawRow[] | null }>[] = [];
  uploads.forEach((u, idx) => {
    const total = counts[idx].count ?? 0;
    const pages = Math.max(1, Math.ceil(total / MNA_PAGE));
    for (let p = 0; p < pages; p++) {
      const from = p * MNA_PAGE;
      pageRequests.push(
        limit(() => sb.from('upload_rows').select('upload_id, data')
          .eq('upload_id', u.id).eq('is_excluded', false)
          .range(from, from + MNA_PAGE - 1)) as PromiseLike<{ data: RawRow[] | null }>
      );
    }
  });

  const pages = await Promise.all(pageRequests);
  return pages.flatMap((r) => r.data ?? []);
}

export async function GET(req: Request) {
  const url   = new URL(req.url);
  const hubId = url.searchParams.get('hub');
  if (!hubId) {
    return NextResponse.json({ error: 'hub query param is required' }, { status: 400 });
  }

  const sb = createServerClient();
  const limit = createLimiter(8);

  // ── Resolve week (same fallback chain as historicos/page.tsx) ──────────────
  let currentWeek = url.searchParams.get('week') ?? undefined;
  if (!currentWeek) {
    const { data: cw } = await sb.from('current_week').select('week_start').single();
    currentWeek = cw?.week_start as string | undefined;
  }
  if (!currentWeek) {
    const { data: latestSnap } = await sb
      .from('kpi_snapshots').select('week_start')
      .order('week_start', { ascending: false }).limit(1).single();
    currentWeek =
      (latestSnap?.week_start as string | undefined) ??
      lastCompletedWeekStart(new Date()).toISOString().slice(0, 10);
  }

  // ── Upload lists: this hub's own uploads plus any city-level ones ──────────
  const [mnaUploadsRes, faltantesUploadsRes] = await Promise.all([
    limit(() => sb.from('uploads').select('id, hub_id')
      .eq('week_start', currentWeek).eq('status', 'validated').eq('app_id', 'mna')
      .or(`hub_id.eq.${hubId},hub_id.is.null`)),
    limit(() => sb.from('uploads').select('id, hub_id')
      .eq('week_start', currentWeek).eq('status', 'validated').eq('app_id', 'faltantes_armador')
      .or(`hub_id.eq.${hubId},hub_id.is.null`)),
  ]);

  const mnaUploadList       = (mnaUploadsRes.data ?? []) as UploadRef[];
  const faltantesUploadList = (faltantesUploadsRes.data ?? []) as UploadRef[];

  const [allMnaRows, allFaltantesRows] = await Promise.all([
    fetchUploadRows(sb, mnaUploadList, limit),
    fetchUploadRows(sb, faltantesUploadList, limit),
  ]);

  // ── MNA products ───────────────────────────────────────────────────────────
  //
  // Formula: MNA($) / (MNA($) + Recibido × Source price) — monetary, same as
  // kpi_snapshots. Price cancels at individual SKU level so the ranking is
  // equivalent to volume-based, but we use monetary for consistency.
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
    const mnaById = new Map<string, UploadRef>();
    for (const u of mnaUploadList) mnaById.set(u.id, u);

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
      const rowHub = resolveHubId(rawHub);
      // City-level uploads carry other hubs' rows too — keep only this hub's.
      if (!rowHub || rowHub !== hubId) continue;

      const producto  = String((r.data as any)['Producto']  ?? '').trim();
      const proveedor = String((r.data as any)['Proveedor'] ?? '').trim();
      if (!producto) continue;

      const mnaAmount = Number((r.data as any)['MNA ($)'])      || 0;
      const recibido  = Number((r.data as any)['Recibido'])     || 0;
      const srcPrice  = Number((r.data as any)['Source price']) || 0;
      const revenue   = recibido * srcPrice;

      const key = `${rowHub}|${producto}`;
      const ex  = mnaAgg.get(key);
      if (ex) {
        ex.pctNum += mnaAmount;
        ex.pctDen += revenue;
        ex.amount += mnaAmount;
      } else {
        // Category is set on first encounter — consistent across rows for the
        // same producto since supplier doesn't vary within a product.
        mnaAgg.set(key, {
          hub_id: rowHub,
          producto,
          pctNum: mnaAmount,
          pctDen: revenue,
          amount: mnaAmount,
          category: classifyMnaProduct(producto, proveedor),
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

  // ── Faltantes SKUs ─────────────────────────────────────────────────────────
  //
  // Category is resolved by cross-referencing the product name against MNA rows
  // (which carry supplier data for accurate classification). Products not found
  // in MNA fall back to keyword-only classification via classifyMnaProduct.
  const skuCategoryFromMna = new Map<string, MnaCategory>();
  for (const r of allMnaRows) {
    const producto  = String((r.data as any)['Producto']  ?? '').trim();
    const proveedor = String((r.data as any)['Proveedor'] ?? '').trim();
    if (producto && !skuCategoryFromMna.has(producto)) {
      skuCategoryFromMna.set(producto, classifyMnaProduct(producto, proveedor));
    }
  }

  const faltantesSkuAgg = new Map<string, { hub_id: string; producto: string; count: number; category: MnaCategory }>();

  // 3-minute sliding window deduplication:
  // Multiple rows with the same (hub, assembler, SKU) within 180 s of each
  // other are part of the same faltante incident and count as 1 event.
  if (allFaltantesRows.length > 0) {
    const faltantesById = new Map<string, UploadRef>();
    for (const u of faltantesUploadList) faltantesById.set(u.id, u);

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

      const rawHub = u.hub_id || String((r.data as any)['Hub'] ?? '').trim() || null;
      const rowHub = resolveHubId(rawHub);
      if (!rowHub || rowHub !== hubId) continue;

      const producto = String((r.data as any)['Producto']    ?? '').trim();
      const opId     = String((r.data as any)['Operator ID'] ?? '').trim();
      const fechaStr = String((r.data as any)['Fecha']       ?? '').trim();
      if (!producto) continue;

      rawEvents.push({
        hubId: rowHub,
        opId,
        producto,
        tsMs: fechaStr ? new Date(fechaStr).getTime() : NaN,
        category: skuCategoryFromMna.get(producto) ?? classifyMnaProduct(producto, ''),
      });
    }

    const groups = new Map<string, RawEvent[]>();
    for (const ev of rawEvents) {
      const gk = `${ev.hubId}|${ev.opId}|${ev.producto}`;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk)!.push(ev);
    }

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
          sessionCount += 1;
          lastSessionTs = ev.tsMs;
        } else {
          // Still within the same session — slide the anchor forward.
          lastSessionTs = ev.tsMs;
        }
      }

      const { hubId: gHub, producto, category } = events[0];
      const aggKey = `${gHub}|${producto}`;
      const ex     = faltantesSkuAgg.get(aggKey);
      if (ex) ex.count += sessionCount;
      else faltantesSkuAgg.set(aggKey, { hub_id: gHub, producto, count: sessionCount, category });
    }
  }

  return NextResponse.json({
    hub: hubId,
    currentWeek,
    mnaProducts,
    faltantesSkuProducts: Array.from(faltantesSkuAgg.values()),
  });
}
