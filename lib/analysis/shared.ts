/**
 * BUILD.md Phase 2 — internal helpers shared across lib/analysis/*.
 * Not part of the public tool catalogue (ARCHITECTURE.md §4) — just the
 * bounded-query and comparability-caveat plumbing every module needs.
 */
// TYPE-ONLY on purpose: supabase-server statically imports `next/headers`,
// which does not exist outside the Next runtime. lib/tenure.ts documents the
// same constraint for tsx scripts; since session 16 it also matters for
// netlify/functions/chat-background.mts, which bundles this module. Every
// function here already takes its SB client as a parameter, so nothing needs
// the value import.
import type { createAdminSupabase } from '../supabase-server';
import { resolveHubId } from '../hub-aliases';
import { normalizeName } from '../normalize';

export type SB = ReturnType<typeof createAdminSupabase>;

const PAGE = 1000;

/** All 7 active hubs, canonical order. Mirrors `hubs` table (mh_san_pedro is deactivated — not seeded there, see OPS_CONTEXT.md §5c). */
export const ACTIVE_HUBS = [
  'mh_contry', 'mh_cumbres', 'mh_san_nicolas', 'mh_guadalupe',
  'mh_avicola', 'mh_zapopan', 'mh_condesa',
] as const;

/** This project's PostgREST "Max Rows" setting — see fetchRowsForUploads below for how this was discovered. Exported so registry.ts's listWeeks can paginate the same way. */
export const PAGE_ROWS = 1000;

/**
 * Generic paginated fetch: loops `.range()` until an under-full page comes
 * back. `uploads` (647 rows today, ~15-20/week) is well under PAGE_ROWS now
 * but will not stay that way — an unranged/single-range query here is a
 * time bomb, not a safe shortcut, given the Max Rows finding above.
 */
export async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await build(from, from + PAGE_ROWS - 1);
    if (error) throw error;
    const page = data ?? [];
    out.push(...page);
    if (page.length < PAGE_ROWS) break;
  }
  return out;
}

/**
 * Validated uploads for one app, most-recent-first, optionally windowed to
 * the last N distinct weeks.
 */
export async function validatedUploads(
  sb: SB,
  appId: string,
  opts?: { hubId?: string; weeksBack?: number }
): Promise<{ id: string; week_start: string; hub_id: string | null; city: string | null }[]> {
  const rows = await fetchAllPages<{ id: string; week_start: string; hub_id: string | null; city: string | null }>((from, to) => {
    let q = sb.from('uploads').select('id, week_start, hub_id, city')
      .eq('app_id', appId).eq('status', 'validated');
    if (opts?.hubId) q = q.eq('hub_id', opts.hubId);
    return q.order('week_start', { ascending: false }).range(from, to);
  });
  if (!opts?.weeksBack) return rows;
  const weeks = [...new Set(rows.map((r) => r.week_start))].sort().slice(-opts.weeksBack);
  const weekSet = new Set(weeks);
  return rows.filter((r) => weekSet.has(r.week_start));
}

/**
 * Fetch every upload_row for a set of upload_ids, ONE upload_id PER QUERY
 * (never a multi-upload `IN` with `ORDER BY` — HANDOFF §12 / kpi-compute.ts:
 * that either forces a full sort, hitting the statement timeout, or silently
 * caps at PostgREST's 1000-row default). A single-value index scan per
 * upload_id has neither problem.
 *
 * ⚠️ This project's PostgREST "Max Rows" is set to 1000 and — unlike the
 * HANDOFF §12 footgun's "unranged responses cap at 1000" framing — it
 * overrides `.limit()`/`.range()` too: `.limit(10_000)` silently returns
 * only 1000 rows, no error. Verified against a real `mna` upload (5,007
 * true rows via exact count) — `.limit(10_000)` returned exactly 1000, and
 * summing MNA($)/Recibido×price over that truncated set vs the full,
 * properly-paginated set gave mna_pct 2.61% vs 2.92% — a real, silent
 * distortion, and any per-SKU top-N ranking over the missing ~4,000 rows
 * would be simply wrong (some SKUs invisible to it). `lib/kpi-compute.ts`
 * uses the identical single-`.limit(10_000)`-per-upload pattern for every
 * app including `mna` — this is very likely a live bug in the shipped MNA
 * KPIs too, flagged separately to José; out of scope to fix here.
 *
 * Fix: page through every upload_id's rows with `.range()` until a page
 * returns fewer than PAGE rows, same as `fetchAll()` in every scripts/*.ts
 * investigation script.
 *
 * Queries across DIFFERENT upload_ids run with bounded concurrency, not
 * one-at-a-time — HANDOFF's sequential-only rule is about WRITES
 * (`Promise.all` across upsert batches caused lock contention). These are
 * independent reads with no lock to contend over; some Phase 2 functions
 * span 12 weeks × up to 4 uploads/week × 2 roles, and strictly sequential
 * fetching pushed those past the 8s budget (attendanceByHub measured ~20s
 * serial vs ~2s at concurrency 8).
 */
const READ_CONCURRENCY = 8;

export async function fetchRowsForUploads(
  sb: SB,
  uploadIds: string[],
  opts?: { excludeExcluded?: boolean }
): Promise<{ upload_id: string; data: Record<string, unknown> }[]> {
  async function fetchOneUpload(id: string): Promise<{ upload_id: string; data: Record<string, unknown> }[]> {
    const rows: { upload_id: string; data: Record<string, unknown> }[] = [];
    for (let from = 0; ; from += PAGE_ROWS) {
      let q = sb.from('upload_rows').select('upload_id, data').eq('upload_id', id);
      if (opts?.excludeExcluded !== false) q = q.eq('is_excluded', false);
      const { data, error } = await q.range(from, from + PAGE_ROWS - 1);
      if (error) throw error;
      const page = (data ?? []) as { upload_id: string; data: Record<string, unknown> }[];
      rows.push(...page);
      if (page.length < PAGE_ROWS) break;
    }
    return rows;
  }

  const out: { upload_id: string; data: Record<string, unknown> }[] = [];
  for (let i = 0; i < uploadIds.length; i += READ_CONCURRENCY) {
    const batch = uploadIds.slice(i, i + READ_CONCURRENCY);
    const results = await Promise.all(batch.map(fetchOneUpload));
    for (const r of results) out.push(...r);
  }
  return out;
}

export const toNum = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : NaN; }
  return NaN;
};

export const pctStr = (a: number, b: number): string => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');

/** Role accounts (auxiliares, coordinadores) — OPS_CONTEXT.md §2. */
export const ROLE_ACCOUNT_PATTERN = /auxiliar|\baux\b|coordinad|\bl[ií]der\b|turno|inventari|calidad|recib|recepci/i;

export { resolveHubId, normalizeName };

/**
 * `desempeno_operadores.assembler` / `faltantes_armador.Armador` carry
 * `Nombre Completo ("Apodo")`; other files carry a plain name. Strips the
 * nickname before normalising so cross-file person joins actually match
 * (the fix from BUILD.md Phase 0.1 — see lib/normalize.ts).
 */
export const normPerson = (raw: unknown): string => normalizeName(String(raw ?? ''));

/** Spearman rank correlation — small n (7 hubs), so ranks not raw values. */
export function spearman(pairs: [number, number][]): number {
  const n = pairs.length;
  if (n < 4) return NaN;
  const rank = (vals: number[]) => {
    const idx = vals.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n).fill(0);
    idx.forEach(([, i], k) => { r[i] = k + 1; });
    return r;
  };
  const ra = rank(pairs.map((p) => p[0]));
  const rb = rank(pairs.map((p) => p[1]));
  const d2 = ra.reduce((s, v, i) => s + (v - rb[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

// ── Comparability caveats — ASSISTANT_DESIGN.md §4b layer 2 ────────────────
// Attached automatically by any function comparing hubs on these axes, per
// BUILD.md Phase 2: "Attach the comparability warnings automatically."

/** OPS_CONTEXT.md §3 — Guadalupe has no stock rooms, herbs at 1°C not 2°C, product held outside the MH. Never silently rank it on FyV. */
export const GUADALUPE_FYV_CAVEAT =
  'mh_guadalupe is structurally different on FyV (OPS_CONTEXT.md §3): no stock rooms, ' +
  'herbs at 1°C not 2°C, some product held outside the MH. Do not rank it against the ' +
  'other 6 hubs on FyV merma/faltantes/stockouts without flagging this.';

/** OPS_CONTEXT.md §2 — Zapopan/Condesa carry a 3rd auxiliar and a different (weekly-bulk) supply cadence. */
export const ZAPOPAN_CONDESA_INVENTORY_CAVEAT =
  'mh_zapopan and mh_condesa carry a 3rd auxiliar (vs 2 elsewhere) and receive mainly ' +
  'direct-from-supplier plus one weekly bulk MTY order (OPS_CONTEXT.md §2) — more capacity ' +
  'but a different replenishment rhythm. Not a like-for-like comparison on inventory-quality KPIs.';

export function comparabilityCaveats(hubs: readonly string[], axis: 'fyv' | 'inventory' | 'none'): string[] {
  const caveats: string[] = [];
  if (axis === 'fyv' && hubs.includes('mh_guadalupe')) caveats.push(GUADALUPE_FYV_CAVEAT);
  if (axis === 'inventory' && (hubs.includes('mh_zapopan') || hubs.includes('mh_condesa'))) {
    caveats.push(ZAPOPAN_CONDESA_INVENTORY_CAVEAT);
  }
  return caveats;
}
