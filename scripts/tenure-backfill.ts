/**
 * Tenure ledger backfill — PLAN_MODO_ENTRENAMIENTO.md §9, slice 2.
 *
 * Writes the derived ledger into person_tenure for both roles via
 * refreshTenureLedger(). Safe to re-run — it's a full rebuild, not an
 * incremental diff, and it never touches source='manual' rows.
 *
 * Run from the project root:
 *   npx tsx scripts/tenure-backfill.ts
 */
import { createClient } from '@supabase/supabase-js';
import { refreshTenureLedger } from '../lib/tenure';

import { config } from 'dotenv';
config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

async function main() {
  const results = await refreshTenureLedger(sb as any);
  for (const r of results) {
    console.log(`\n${r.role}: considered=${r.rows_considered} upserted=${r.rows_upserted} manual_skipped=${r.manual_rows_skipped} collisions=${r.collisions.length}`);
  }

  const { data: grouped, error } = await sb
    .from('person_tenure')
    .select('role, confidence');
  if (error) throw error;

  const counts = new Map<string, number>();
  for (const row of grouped ?? []) {
    const key = `${row.role}|${row.confidence}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  console.log('\nselect role, confidence, count(*) from person_tenure group by 1,2;');
  console.log('-'.repeat(40));
  for (const [key, n] of [...counts.entries()].sort()) {
    const [role, confidence] = key.split('|');
    console.log(`  ${role.padEnd(12)} ${confidence.padEnd(6)} ${n}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
