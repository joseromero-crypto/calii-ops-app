/**
 * Recompute snapshots from the command line, with timings. Session 17.
 *
 * Two jobs:
 *
 *  1. **Escape hatch.** `POST /api/recompute` now runs in a background function
 *     (15 min), but a local run has no ceiling at all and prints exactly where
 *     the time goes — useful when a week misbehaves and you want the answer in
 *     one pass rather than through the UI.
 *
 *  2. **Backfill.** `--all` recomputes every week that has validated uploads,
 *     oldest first. Needed after the `enrichWithHistory` pagination fix
 *     (session 17): that select was unranged, so PostgREST capped it at Max
 *     Rows = 1000 and every snapshot whose history fell outside that first
 *     page was written with prev_week_value / rolling_mean_4w / rolling_std_4w
 *     = null. Those columns feed the Por KPI heatmap colours. Order matters —
 *     week N reads the snapshots of weeks N−1…N−4, so a backfill that ran
 *     newest-first would enrich from rows it was about to replace.
 *
 * Run from the project root:
 *   npx tsx scripts/recompute-week.ts                # last completed week
 *   npx tsx scripts/recompute-week.ts 2026-09-04     # a specific Friday
 *   npx tsx scripts/recompute-week.ts --all          # backfill everything
 *   npx tsx scripts/recompute-week.ts --skip-tenure  # skip the tenure ledger
 *
 * Safe to re-run: a recompute is a deterministic rewrite from source data,
 * not an incremental diff.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env.local' });

import { computeSnapshotsForWeek } from '../lib/kpi-compute';
import { refreshTenureLedger } from '../lib/tenure';
import { lastCompletedWeekStart } from '../lib/types';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function secs(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Upload inventory for one week — rules out "wrong week_start" and files
 *  sitting in `pending`, which computeSnapshotsForWeek silently excludes. */
async function inventory(week: string) {
  const { data, error } = await sb
    .from('uploads')
    .select('app_id, status, row_count')
    .eq('week_start', week);
  if (error) throw error;

  const rows = data ?? [];
  const byApp = new Map<string, { n: number; rows: number; pending: number }>();
  for (const u of rows) {
    const a = byApp.get(u.app_id) ?? { n: 0, rows: 0, pending: 0 };
    a.n += 1;
    a.rows += u.row_count ?? 0;
    if (u.status !== 'validated') a.pending += 1;
    byApp.set(u.app_id, a);
  }

  console.log(`Uploads for ${week}: ${rows.length} (${rows.filter((u) => u.status === 'validated').length} validated)`);
  for (const [app, a] of [...byApp].sort()) {
    console.log(`  ${app.padEnd(24)} files=${String(a.n).padStart(2)}  rows=${String(a.rows).padStart(6)}` +
      (a.pending ? `  ⚠️  ${a.pending} NOT validated (excluded from compute)` : ''));
  }
  console.log('');

  return rows.filter((u) => u.status === 'validated').length;
}

async function runOneWeek(week: string, opts: { quiet?: boolean } = {}) {
  const t = Date.now();
  const result = await computeSnapshotsForWeek(week, sb as never);
  const ms = Date.now() - t;

  if (opts.quiet) {
    console.log(`  ${week}  ${secs(ms).padStart(7)}  snapshots=${String(result.snapshots_written).padStart(5)}` +
      `  peers=${String(result.peers_written).padStart(5)}  kpis=${result.kpis_processed}` +
      (result.warnings.length ? `  warnings=${result.warnings.length}` : ''));
  } else {
    console.log(`Phase 2 · computeSnapshotsForWeek: ${secs(ms)}\n`);
    console.log(`✅ snapshots=${result.snapshots_written}  peers=${result.peers_written}  kpis=${result.kpis_processed}`);
    if (result.warnings.length) {
      console.log(`\n⚠️  ${result.warnings.length} warnings:`);
      for (const w of result.warnings.slice(0, 40)) console.log(`   - ${w}`);
      if (result.warnings.length > 40) console.log(`   … +${result.warnings.length - 40} more`);
    }
  }
  return { ms, result };
}

async function main() {
  const args = process.argv.slice(2);
  const skipTenure = args.includes('--skip-tenure');
  const all = args.includes('--all');
  const weekArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

  // The tenure ledger is global, not per-week, and re-derives itself from every
  // validated upload ever recorded — so a backfill refreshes it once up front
  // rather than once per week.
  let tenureMs = 0;
  if (!skipTenure) {
    const t0 = Date.now();
    await refreshTenureLedger(sb as never);
    tenureMs = Date.now() - t0;
    console.log(`\nPhase 1 · refreshTenureLedger: ${secs(tenureMs)}\n`);
  } else {
    console.log('\nPhase 1 · refreshTenureLedger: SKIPPED (--skip-tenure)\n');
  }

  if (all) {
    const { data, error } = await sb
      .from('uploads')
      .select('week_start')
      .eq('status', 'validated')
      .limit(1000);
    if (error) throw error;
    const weeks = [...new Set((data ?? []).map((u) => u.week_start as string))].sort();

    console.log(`=== Backfill: ${weeks.length} weeks with validated uploads, oldest first ===\n`);
    const failures: { week: string; error: string }[] = [];
    const t0 = Date.now();
    for (const week of weeks) {
      try {
        await runOneWeek(week, { quiet: true });
      } catch (e: any) {
        failures.push({ week, error: e?.message ?? String(e) });
        console.error(`  ${week}  ❌ ${e?.message ?? e}`);
      }
    }
    console.log(`\nDone in ${secs(Date.now() - t0 + tenureMs)}.`);
    if (failures.length) {
      console.log(`\n❌ ${failures.length} weeks failed:`);
      for (const f of failures) console.log(`   ${f.week}: ${f.error}`);
      process.exit(1);
    }
    console.log('');
    return;
  }

  const week = weekArg ?? lastCompletedWeekStart(new Date()).toISOString().slice(0, 10);
  console.log(`=== Recompute ${week} ===\n`);

  const validated = await inventory(week);
  if (validated === 0) {
    console.log('❌ No validated uploads for this week — compute would return 0 immediately.');
    console.log('   Check the week picker on /upload, or re-upload the files flagged above.\n');
    return;
  }

  const { ms } = await runOneWeek(week);

  const total = tenureMs + ms;
  console.log(`\nTotal: ${secs(total)}  (Netlify's synchronous ceiling is 26.0s — the background function gets 15 min)`);
  console.log('');
}

main().catch((e) => {
  console.error('\n❌', e?.message ?? e);
  process.exit(1);
});
