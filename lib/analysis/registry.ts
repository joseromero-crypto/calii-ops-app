/**
 * BUILD.md Phase 2 — registry reads. ARCHITECTURE.md §4: "Registry — trivial."
 * Plain data, not the full { data, confidence, caveats, provenance, claims }
 * envelope — there's no derived number here to attach confidence or a claim to.
 */
import type { SB } from './shared';
import { fetchAllPages } from './shared';
import type { Hub, Kpi } from '../types';

export async function listHubs(sb: SB): Promise<Hub[]> {
  const { data, error } = await sb.from('hubs').select('*').order('id');
  if (error) throw error;
  return (data ?? []) as Hub[];
}

export async function listKpis(sb: SB, opts?: { activeOnly?: boolean }): Promise<Kpi[]> {
  let q = sb.from('kpis').select('*');
  if (opts?.activeOnly !== false) q = q.eq('active', true);
  const { data, error } = await q.order('display_order');
  if (error) throw error;
  return (data ?? []) as Kpi[];
}

/**
 * Distinct week_start values with at least one validated upload, ascending.
 * Paginated (fetchAllPages) — `uploads` will eventually exceed this
 * project's 1000-row PostgREST cap (647 rows today, growing ~15-20/week);
 * a single `.limit()` here is a time bomb, not a safe shortcut (see
 * shared.ts's fetchRowsForUploads for how that cap was discovered).
 */
export async function listWeeks(sb: SB, opts?: { appId?: string }): Promise<string[]> {
  const rows = await fetchAllPages<{ week_start: string }>((from, to) => {
    let q = sb.from('uploads').select('week_start').eq('status', 'validated');
    if (opts?.appId) q = q.eq('app_id', opts.appId);
    return q.range(from, to);
  });
  return [...new Set(rows.map((r) => r.week_start))].sort();
}
