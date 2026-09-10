/**
 * Recompute kpi_snapshots for every week that has validated `mna` uploads —
 * one-off follow-up to the pagination bug fixed in lib/kpi-compute.ts
 * (BUILD.md Phase 2, 2026-09-09): every mna_pct / mna_graneles_pct /
 * mna_carnes_pct / mna_fyv_pct snapshot ever written was computed from a
 * ~1000-row-truncated read of ~5,000-row mna uploads. The fix is code-only
 * going forward; existing snapshot rows need this recompute to correct.
 *
 * Uses the app's own computeSnapshotsForWeek() directly — the same function
 * POST /api/recompute calls, just without the HTTP/auth layer (which needs
 * a browser session, not the service-role key). Safe to re-run: a recompute
 * is a deterministic rewrite from source data, not an incremental diff.
 *
 * Run from the project root:
 *   npx tsx scripts/recompute-mna-weeks.ts
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env.local' });

// computeSnapshotsForWeek calls createAdminSupabase() internally, which
// reads these same env vars — config() above must run before the import.
import { computeSnapshotsForWeek } from '../lib/kpi-compute';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function main() {
  const { data: uploads, error } = await sb.from('uploads').select('week_start')
    .eq('app_id', 'mna').eq('status', 'validated').limit(1000);
  if (error) throw error;
  const weeks = [...new Set((uploads ?? []).map((u) => u.week_start as string))].sort();

  console.log(`Recomputing ${weeks.length} weeks with validated mna data...\n`);

  const failures: { week: string; error: string }[] = [];
  for (const week of weeks) {
    try {
      const result = await computeSnapshotsForWeek(week);
      console.log(`  ${week}  snapshots=${result.snapshots_written}  peers=${result.peers_written}  kpis=${result.kpis_processed}` +
        (result.warnings.length ? `  warnings=${result.warnings.length}` : ''));
    } catch (e: any) {
      failures.push({ week, error: e?.message ?? String(e) });
      console.error(`  ${week}  ❌ ${e?.message ?? e}`);
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log(`weeks processed: ${weeks.length - failures.length}/${weeks.length}`);
  if (failures.length) {
    console.log(`❌ ${failures.length} failed:`);
    for (const f of failures) console.log(`   ${f.week}: ${f.error}`);
    process.exitCode = 1;
  }
  console.log('='.repeat(78));
}

main().catch((e) => { console.error(e); process.exit(1); });
