/**
 * /historicos — server data loader.
 *
 * ══ Session 16 (2026-09-11): fetch per TAB, not everything, every time ══════
 *
 * Background: this page had been failing in production. Netlify Observability
 * showed the RSC request finishing at ~18s with a ~1KB body under a 200, and
 * the browser threw "Error: Connection closed." mid-stream — the host cutting
 * the connection after headers had already gone out. Session 15 attributed
 * that to request scheduling and rewrote the fan-out (bounded concurrency,
 * fewer MNA round trips). That deployed and changed the number by 0.5%:
 * 17975ms → 17879ms. Scheduling was the wrong lever, and the reason is that
 * neither version changed the amount of data being moved.
 *
 * What was actually wrong: the page fetched EVERY tab's data on EVERY request,
 * while the client renders exactly one tab at a time. Three of the four tabs
 * (Por KPI, Comparativa, Resumen) read only `snapshots` plus the small
 * registry tables — verified against their prop destructuring. Everything
 * expensive existed solely for the fourth:
 *
 *   peer_comparisons (current week)   → Por hub only
 *   operator/driver WoW trend rows    → Por hub only
 *   person_tenure / ramps / roster    → Por hub only (badges)
 *   raw MNA + faltantes upload_rows   → Por hub only, and only on tile flip
 *
 * So the default landing tab was paying for ~10x the data it renders. Three
 * changes, all volume reductions rather than scheduling changes:
 *
 *   1. TAB-SCOPED FETCHING (below). `?tab=` decides what is fetched. The three
 *      light tabs now issue the registry queries plus snapshot pages and
 *      nothing else. Tab switching became a server navigation in
 *      HistoricosClient so this can hold; hub switching inside Por hub stays
 *      pure client state, as before.
 *
 *   2. TREND WINDOW = LAST 8 UPLOAD WEEKS, not 51. The assembler/driver WoW
 *      charts render `allSectionWeeks.slice(-5)` (PorHubTab) — five weeks,
 *      always. Fetching a year of operator × KPI × week peer rows to draw five
 *      weeks was the single largest row count on the page. See
 *      trendWindowStart() for why the bound comes from validated upload weeks
 *      rather than a calendar offset.
 *
 *   3. MNA/FALTANTES MOVED OFF THE PAGE entirely, to
 *      app/api/historicos/mna-products/route.ts, fetched per selected hub in
 *      the background. Both consumers (tile flips, "Generar reporte") are
 *      user-triggered and single-hub, so pulling ~7 uploads × ~5,000 JSONB
 *      blobs inline, ahead of first paint, bought nothing.
 *
 * The concurrency limiter from session 15 is kept: it is harmless, and with
 * far fewer queries it still bounds the burst. It is not what fixed this.
 */
import { createServerClient } from '@/lib/supabase-server';
import { lastCompletedWeekStart } from '@/lib/types';
import type { KpiTarget, RampTarget } from './_shared';
import { HistoricosClient } from './HistoricosClient';
import { hydrateTenureRow, type PersonTenureDbRow, type Role as TenureRole } from '@/lib/tenure';

export const dynamic = 'force-dynamic';

type Tab = 'kpi' | 'hub' | 'cmp' | 'res';

interface PageProps {
  searchParams: { tab?: string; kpi?: string; hub?: string; city?: string };
}

const PAGE = 1000;

/**
 * How many weeks of operator/driver peer rows the WoW charts need.
 *
 * PorHubTab draws `allSectionWeeks.slice(-5)`. 8 is that 5 plus three weeks of
 * slack, so a hub whose peer rows exist for a week its roster upload was later
 * re-statused still gets a full five-point x-axis.
 */
const TREND_WEEKS = 8;

/**
 * Lower bound for the WoW trend fetch, derived from weeks that actually have a
 * validated roster upload rather than from a calendar offset.
 *
 * A fixed "last N calendar weeks" bound would silently shorten the chart for
 * any hub that skipped uploads — it would return fewer than five weeks of data
 * where the old 51-week fetch found five further back. Anchoring to real
 * upload weeks keeps the rendered window identical to before.
 */
function trendWindowStart(uploadWeeks: string[], fallback: string): string {
  const distinct = [...new Set(uploadWeeks)].sort();
  if (distinct.length === 0) return fallback;
  return distinct[Math.max(0, distinct.length - TREND_WEEKS)];
}

/**
 * Bounded-concurrency gate for this page's Supabase reads (session 15).
 * Caps how many requests are in flight at once — same concurrency=8 proven in
 * `lib/analysis/shared.ts`'s `fetchRowsForUploads`.
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

const ROSTER_APP_BY_ROLE: Record<TenureRole, string> = {
  armador: 'desempeno_operadores',
  repartidor: 'desempeno_repartidores',
};

export default async function HistoricosPage({ searchParams }: PageProps) {
  const sb = createServerClient();
  const limit = createLimiter(8);

  const tab: Tab = (['kpi', 'hub', 'cmp', 'res'] as const).includes(searchParams.tab as Tab)
    ? (searchParams.tab as Tab)
    : 'kpi';
  // Everything below this flag is Por-hub-only data. See the file header.
  const needsHubData = tab === 'hub';

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

  // ── Step 2: registry tables + counts ────────────────────────────────────────
  //
  // Always fetched: the four small registry tables and the snapshot count.
  // `snapshots` is the one heavy dataset every tab genuinely reads.
  const [kpisRes, hubsRes, rolesRes, targetsRes, snapCountRes] = await Promise.all([
    limit(() => sb.from('kpis').select('*').eq('active', true).order('display_order')),
    limit(() => sb.from('hubs').select('id, display_name, city').eq('active', true).order('id')),
    limit(() => sb.from('hub_roles').select('id, name_es')),
    limit(() => sb.from('kpi_targets')
      .select('kpi_id, scope_level, scope_key, target_value, comparator, unit, active')
      .eq('active', true)),
    limit(() => sb
      .from('kpi_snapshots')
      .select('*', { count: 'exact', head: true })
      .gte('week_start', sinceIso)
      .lte('week_start', currentWeek)
      .in('scope_level', ['hub', 'city', 'global'])),
  ]);

  // ── Step 2b: Por hub only — peers, tenure ledger inputs, roster weeks ───────
  const hubBatch = needsHubData
    ? await Promise.all([
        limit(() => sb.from('peer_comparisons')
          .select('*', { count: 'exact', head: true })
          .eq('week_start', currentWeek)),
        // Modo Entrenamiento (session 14) — tenure ledger + ramp targets. Both
        // tiny (hundreds / tens of rows), no pagination needed.
        limit(() => sb.from('person_tenure').select('*')),
        limit(() => sb.from('kpi_ramp_targets')
          .select('kpi_id, role, week_number, target_value, stretch_value, comparator, unit, active')
          .eq('active', true)),
        // Validated-upload weeks for the two roster apps. Two jobs: recomputing
        // each tenure row's reentry_weeks (not a person_tenure column, see
        // lib/tenure.ts) and bounding the WoW trend window above.
        limit(() => sb.from('uploads').select('app_id, week_start')
          .eq('status', 'validated')
          .in('app_id', ['desempeno_operadores', 'desempeno_repartidores'])),
      ])
    : null;

  const snapTotal   = snapCountRes.count ?? 0;
  const peerTotal   = hubBatch ? (hubBatch[0].count ?? 0) : 0;
  const tenureRes   = hubBatch ? hubBatch[1] : null;
  const rampsRes    = hubBatch ? hubBatch[2] : null;
  const rosterWeeks = hubBatch ? (hubBatch[3].data ?? []) : [];

  const weeksWithDataByRole: Record<TenureRole, Set<string>> = {
    armador: new Set(rosterWeeks.filter((u) => u.app_id === ROSTER_APP_BY_ROLE.armador).map((u) => u.week_start)),
    repartidor: new Set(rosterWeeks.filter((u) => u.app_id === ROSTER_APP_BY_ROLE.repartidor).map((u) => u.week_start)),
  };

  // ── Step 2c: Por hub only — trend counts, over the narrowed window ──────────
  const assemblerSince = trendWindowStart([...weeksWithDataByRole.armador], sinceIso);
  const driverSince    = trendWindowStart([...weeksWithDataByRole.repartidor], sinceIso);

  const trendCounts = needsHubData
    ? await Promise.all([
        // One row per assembler × KPI × week, within_hub scope only.
        limit(() => sb.from('peer_comparisons')
          .select('*', { count: 'exact', head: true })
          .eq('entity_type', 'operator').eq('scope_type', 'within_hub')
          .gte('week_start', assemblerSince).lte('week_start', currentWeek)),
        // Drivers are resolved to hub via the desempeno_repartidores cross-ref.
        limit(() => sb.from('peer_comparisons')
          .select('*', { count: 'exact', head: true })
          .eq('entity_type', 'driver').eq('scope_type', 'within_hub')
          .gte('week_start', driverSince).lte('week_start', currentWeek)),
      ])
    : null;

  const assemblerTrendTotal = trendCounts ? (trendCounts[0].count ?? 0) : 0;
  const driverTrendTotal    = trendCounts ? (trendCounts[1].count ?? 0) : 0;

  // ── Step 3: fetch pages in parallel ─────────────────────────────────────────
  //
  // kpi_snapshots and peer_comparisons are fetched with explicit ORDER BY so
  // their range pagination is stable — without one, PostgreSQL may return rows
  // in a different order across requests and pages can overlap or skip rows.
  const idxs = (total: number) => Array.from({ length: Math.ceil(total / PAGE) }, (_, i) => i);

  const PEER_COLS =
    'kpi_id, week_start, entity_type, entity_key, scope_type, scope_key, value, peer_mean, z_score, rank, rank_total';

  const [snapPages, peerPages, assemblerTrendPages, driverTrendPages] = await Promise.all([
    Promise.all(
      idxs(snapTotal).map((i) =>
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
      idxs(peerTotal).map((i) =>
        limit(() => sb
          .from('peer_comparisons')
          .select(PEER_COLS)
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
    Promise.all(
      idxs(assemblerTrendTotal).map((i) =>
        limit(() => sb
          .from('peer_comparisons')
          .select(PEER_COLS)
          .eq('entity_type', 'operator')
          .eq('scope_type', 'within_hub')
          .gte('week_start', assemblerSince)
          .lte('week_start', currentWeek)
          .order('week_start', { ascending: true })
          .range(i * PAGE, (i + 1) * PAGE - 1))
      )
    ),
    Promise.all(
      idxs(driverTrendTotal).map((i) =>
        limit(() => sb
          .from('peer_comparisons')
          .select(PEER_COLS)
          .eq('entity_type', 'driver')
          .eq('scope_type', 'within_hub')
          .gte('week_start', driverSince)
          .lte('week_start', currentWeek)
          .order('week_start', { ascending: true })
          .range(i * PAGE, (i + 1) * PAGE - 1))
      )
    ),
  ]);

  const allSnaps          = snapPages.flatMap((r) => r.data ?? []);
  const allPeers          = peerPages.flatMap((r) => r.data ?? []);
  const allAssemblerTrend = assemblerTrendPages.flatMap((r) => r.data ?? []);
  const allDriverTrend    = driverTrendPages.flatMap((r) => r.data ?? []);

  // ── Step 4: hydrate the tenure ledger (Modo Entrenamiento, session 14) ──────
  const tenureRows = ((tenureRes?.data ?? []) as PersonTenureDbRow[]).map((row) =>
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
      roles={rolesRes.data ?? []}
      targets={(targetsRes.data ?? []) as KpiTarget[]}
      tenureRows={tenureRows}
      ramps={(rampsRes?.data ?? []) as RampTarget[]}
      currentWeek={currentWeek}
      tab={tab}
      selectedKpi={searchParams.kpi}
      selectedHub={searchParams.hub}
      selectedCity={searchParams.city}
    />
  );
}
