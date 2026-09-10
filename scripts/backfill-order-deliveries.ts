/**
 * order_deliveries backfill — BUILD.md Phase 1.
 *
 * Runs flattenOrderDeliveries() over every validated desempeno_repartidores
 * upload in history. Safe to re-run — the ETL deletes-then-inserts per
 * upload_id, so this is idempotent, not a diff.
 *
 * Run from the project root (after 20260909000001_order_deliveries.sql has
 * been applied in the Supabase SQL editor):
 *   npx tsx scripts/backfill-order-deliveries.ts
 */
import { createClient } from '@supabase/supabase-js';
import { flattenOrderDeliveries } from '../lib/etl/order-deliveries';

import { config } from 'dotenv';
config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function main() {
  const { data: uploads, error } = await sb
    .from('uploads')
    .select('id, week_start')
    .eq('app_id', 'desempeno_repartidores')
    .eq('status', 'validated')
    .order('week_start', { ascending: true });
  if (error) throw error;
  if (!uploads?.length) {
    console.log('No validated desempeno_repartidores uploads found.');
    return;
  }

  console.log(`Backfilling ${uploads.length} desempeno_repartidores uploads...\n`);

  let totalRowsWritten = 0;
  let totalOrdersSeen = 0;
  let totalSkippedNoHub = 0;
  let totalSkippedBadEntry = 0;
  const failures: { upload_id: string; week_start: string; error: string }[] = [];

  for (const u of uploads) {
    try {
      const r = await flattenOrderDeliveries(sb as any, u.id);
      totalRowsWritten += r.rows_written;
      totalOrdersSeen += r.orders_seen;
      totalSkippedNoHub += r.skipped_no_hub;
      totalSkippedBadEntry += r.skipped_bad_entry;
      console.log(
        `  ${u.week_start}  upload=${u.id}  driver_weeks=${r.driver_week_rows}  orders_seen=${r.orders_seen}  ` +
        `written=${r.rows_written}  skipped_no_hub=${r.skipped_no_hub}  skipped_bad_entry=${r.skipped_bad_entry}`
      );
    } catch (e: any) {
      failures.push({ upload_id: u.id, week_start: u.week_start, error: e?.message ?? String(e) });
      console.error(`  ${u.week_start}  upload=${u.id}  ❌ ${e?.message ?? e}`);
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log(`uploads processed:   ${uploads.length - failures.length}/${uploads.length}`);
  console.log(`orders_data entries seen: ${totalOrdersSeen}`);
  console.log(`order_deliveries rows written: ${totalRowsWritten}`);
  console.log(`skipped (unresolved hub): ${totalSkippedNoHub}`);
  console.log(`skipped (malformed entry): ${totalSkippedBadEntry}`);
  if (failures.length) {
    console.log(`\n❌ ${failures.length} upload(s) failed:`);
    for (const f of failures) console.log(`   ${f.week_start} ${f.upload_id}: ${f.error}`);
    process.exitCode = 1;
  }
  console.log('='.repeat(78));
}

main().catch((e) => { console.error(e); process.exit(1); });
