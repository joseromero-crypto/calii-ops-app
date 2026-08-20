/**
 * Tenure ledger dry run — PLAN_MODO_ENTRENAMIENTO.md §9, slice 1.
 *
 * Read-only. Derives the tenure ledger for both roles from existing upload
 * history and prints it to console. No migration, no Supabase writes.
 * Jose eyeballs the output before slice 2 (the real migration + backfill)
 * happens — see the plan's §9 verification checklist and §10 test matrix.
 *
 * Run from the project root:
 *   npx tsx scripts/tenure-dry-run.ts
 */
import { createClient } from '@supabase/supabase-js';
import { deriveTenureLedger, tenureStatus, tenureLabel, weeksBetween, type Role, type TenureRow } from '../lib/tenure';

import { config } from 'dotenv';
config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const ROLES: Role[] = ['armador', 'repartidor'];

function findPrevSeenWeek(row: TenureRow, returnWeek: string): string | undefined {
  return [...row.seen_weeks].filter((w) => w < returnWeek).sort().pop();
}

function uploadsInWindow(uploadsPerWeek: Map<string, number>, weeksWithData: string[], fromIso: string, toIso: string): number {
  let count = 0;
  for (const w of weeksWithData) {
    if (w > fromIso && w < toIso) count += uploadsPerWeek.get(w) ?? 0;
  }
  return count;
}

async function main() {
  for (const role of ROLES) {
    console.log('\n' + '='.repeat(78));
    console.log(`ROLE: ${role}`);
    console.log('='.repeat(78));

    const result = await deriveTenureLedger(sb as any, role);
    const { rows, weeksWithData, uploadsPerWeek, dataHorizon, skippedNoId, collisions } = result;

    if (weeksWithData.length === 0) {
      console.log('No validated uploads found for this role\'s app. Nothing to derive.');
      continue;
    }

    const currentWeek = weeksWithData[weeksWithData.length - 1];
    console.log(`Data horizon (earliest week with data): ${dataHorizon}`);
    console.log(`Current week (latest week with data):   ${currentWeek}`);
    console.log(`Total distinct people seen:              ${rows.length}`);
    console.log(`Rows skipped for missing id:              ${skippedNoId}`);

    // ── 1. counts by confidence ──────────────────────────────────────────
    const highCount = rows.filter((r) => r.confidence === 'high').length;
    const lowCount = rows.filter((r) => r.confidence === 'low').length;
    const lowDataHorizon = rows.filter((r) => r.confidence_reason === 'data_horizon').length;
    const lowMissingPrior = rows.filter((r) => r.confidence_reason === 'missing_prior_week').length;
    console.log('\n--- 1. Counts by confidence ---');
    console.log(`  high: ${highCount}`);
    console.log(`  low:  ${lowCount}  (data_horizon: ${lowDataHorizon}, missing_prior_week: ${lowMissingPrior})`);

    // ── 2. everyone badged for the current week ──────────────────────────
    console.log('\n--- 2. Badged this week (' + currentWeek + ') ---');
    const badged = rows
      .map((row) => ({ row, status: tenureStatus(row, currentWeek) }))
      .filter((x) => x.status.kind !== 'veteran');

    if (badged.length === 0) {
      console.log('  (none)');
    } else {
      for (const { row, status } of badged) {
        const badge = tenureLabel(status).trim();
        console.log(
          `  ${(row.display_names[0] ?? row.person_key).padEnd(28)} id=${row.person_key.padEnd(12)} hub=${(row.hub_id_last ?? '—').padEnd(16)} badge=${badge.padEnd(6)} first_seen_week=${row.first_seen_week}`
        );
      }
    }
    console.log(`  Total badged: ${badged.length}`);

    // ── 3. RI hit detail — gap window + uploads inside it ────────────────
    const riHits = badged.filter((x) => x.status.kind === 'reentry');
    console.log('\n--- 3. Reingreso (RI) detail ---');
    if (riHits.length === 0) {
      console.log('  (none)');
    } else {
      for (const { row, status } of riHits) {
        // Find the specific reentry week that produced this status.
        const returnWeek = row.reentry_weeks.find((r) => {
          const w = weeksBetween(r, currentWeek);
          return w >= 0 && w < 2 && w + 1 === (status as { kind: 'reentry'; week: number }).week;
        });
        if (!returnWeek) continue;
        const prevWeek = findPrevSeenWeek(row, returnWeek);
        const uploadsInside = prevWeek ? uploadsInWindow(uploadsPerWeek, weeksWithData, prevWeek, returnWeek) : 0;
        console.log(
          `  ${(row.display_names[0] ?? row.person_key).padEnd(28)} id=${row.person_key}`
        );
        console.log(
          `    gap window: [${prevWeek ?? '?'} → ${returnWeek})  validated uploads inside window: ${uploadsInside}`
        );
      }
    }

    // ── 4. normalized-name collisions ────────────────────────────────────
    console.log('\n--- 4. Normalized-name collisions ---');
    if (collisions.length === 0) {
      console.log('  (none)');
    } else {
      for (const c of collisions) {
        console.log(`  "${c.normalized_name}" → ids: ${c.person_keys.join(', ')}`);
      }
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log('Dry run complete. No writes were made.');
  console.log('='.repeat(78));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
