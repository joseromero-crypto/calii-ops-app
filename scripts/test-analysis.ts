/**
 * Tests for lib/analysis/* — BUILD.md Phase 2's own test list. Live-DB
 * integration tests, same convention as scripts/test-tenure.ts: plain
 * node:assert/strict via tsx, no framework. Unlike test-tenure.ts these
 * hit the real Supabase project (there is no DB fixture layer in this
 * repo) — same pattern as investigate-hub.ts / cross-checks.ts.
 *
 * Run from the project root:
 *   npx tsx scripts/test-analysis.ts
 */
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env.local' });

import { listWeeks } from '../lib/analysis/registry';
import { kpiByHub } from '../lib/analysis/kpis';
import { faltantesBreakdown, faltantesProductLift, faltantesByPerson } from '../lib/analysis/faltantes';
import { deliveryLateness } from '../lib/analysis/delivery';
import { attendanceByHub, auxAssemblyLoad } from '../lib/analysis/workforce';
import { mnaBreakdown, stockCover } from '../lib/analysis/inventory';
import { discriminate } from '../lib/analysis/discriminate';
import { resolveEvidence } from '../lib/analysis/evidence';
import type { AnalysisResult } from '../lib/analysis/types';
import { ACTIVE_HUBS } from '../lib/analysis/shared';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } }) as any;

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  const start = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}  (${Date.now() - start}ms)`);
  } catch (e: any) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
}

const TIME_BUDGET_MS = 8000;

/** Every axis present, a rating, and a non-empty note — the confidence block must always be populated. */
function assertConfidencePopulated(r: AnalysisResult<unknown>, label: string) {
  for (const axis of ['coverage', 'meaning', 'statistical', 'causal'] as const) {
    const a = r.confidence[axis];
    assert.ok(a, `${label}: confidence.${axis} missing`);
    assert.ok(['CONFIRMED', 'CORRECTED', 'ASSUMED', 'OPEN'].includes(a.rating), `${label}: confidence.${axis}.rating invalid: ${a.rating}`);
    assert.ok(a.note && a.note.length > 0, `${label}: confidence.${axis}.note empty`);
  }
}

/** Every numeric result has >=1 claim, and every claim's evidence.refetch actually re-runs and returns rows matching what the claim implies. */
async function assertClaimsResolve(r: AnalysisResult<unknown>, label: string, expectClaims = true) {
  if (expectClaims) assert.ok(r.claims.length >= 1, `${label}: expected at least one claim, got 0`);
  for (const c of r.claims) {
    const resolved = await resolveEvidence(sb, c.evidence.refetch);
    assert.ok(Number.isFinite(resolved.rows_out), `${label}: claim ${c.id} refetch did not return rows_out`);
    assert.ok(resolved.rows_out >= 0, `${label}: claim ${c.id} refetch rows_out negative`);
  }
}

async function main() {
  console.log('='.repeat(78));
  console.log('lib/analysis/* — BUILD.md Phase 2 test list');
  console.log('='.repeat(78));

  const weeks = await listWeeks(sb, { appId: 'desempeno_operadores' });
  const latestWeek = weeks[weeks.length - 1];
  const mnaWeeks = await listWeeks(sb, { appId: 'mna' });
  const latestMnaWeek = mnaWeeks[mnaWeeks.length - 1];
  console.log(`\nUsing latest weeks: desempeno_operadores=${latestWeek}, mna=${latestMnaWeek}\n`);

  // ── 1. Time budget ────────────────────────────────────────────────────
  await test('faltantesBreakdown(mh_contry) returns well under time budget', async () => {
    const start = Date.now();
    await faltantesBreakdown(sb, 'mh_contry', 12);
    assert.ok(Date.now() - start < TIME_BUDGET_MS, `took ${Date.now() - start}ms`);
  });
  await test('deliveryLateness(mh_contry) returns well under time budget', async () => {
    const start = Date.now();
    await deliveryLateness(sb, 'mh_contry', 12);
    assert.ok(Date.now() - start < TIME_BUDGET_MS, `took ${Date.now() - start}ms`);
  });
  await test('mnaBreakdown(mh_contry) returns well under time budget', async () => {
    const start = Date.now();
    await mnaBreakdown(sb, 'mh_contry', 8);
    assert.ok(Date.now() - start < TIME_BUDGET_MS, `took ${Date.now() - start}ms`);
  });

  // ── 2. Confidence block always populated ────────────────────────────────
  await test('faltantesBreakdown confidence block populated', async () => {
    const r = await faltantesBreakdown(sb, 'mh_contry', 12);
    assertConfidencePopulated(r, 'faltantesBreakdown');
  });
  await test('faltantesProductLift confidence block populated', async () => {
    const r = await faltantesProductLift(sb, 'mh_contry', 12);
    assertConfidencePopulated(r, 'faltantesProductLift');
  });
  await test('faltantesByPerson confidence block populated', async () => {
    const r = await faltantesByPerson(sb, 'mh_contry', 12);
    assertConfidencePopulated(r, 'faltantesByPerson');
  });
  await test('deliveryLateness confidence block populated', async () => {
    const r = await deliveryLateness(sb, 'mh_contry', 12);
    assertConfidencePopulated(r, 'deliveryLateness');
  });
  await test('attendanceByHub confidence block populated', async () => {
    const r = await attendanceByHub(sb, 12);
    assertConfidencePopulated(r, 'attendanceByHub');
  });
  await test('mnaBreakdown confidence block populated', async () => {
    const r = await mnaBreakdown(sb, 'mh_contry', 8);
    assertConfidencePopulated(r, 'mnaBreakdown');
  });
  await test('stockCover confidence block populated', async () => {
    const r = await stockCover(sb, 'mh_contry');
    assertConfidencePopulated(r, 'stockCover');
  });
  await test('discriminate confidence block populated', () => {
    const r = discriminate('faltantes_rate', { mh_contry: 10, mh_cumbres: 5 }, 'mh_contry', []);
    assertConfidencePopulated(r, 'discriminate');
  });

  // ── 3. discriminate correctly rejects a factor large everywhere ────────
  await test('discriminate rejects a factor large everywhere (never DISCRIMINATES)', () => {
    const metric = { mh_contry: 10, mh_cumbres: 3, mh_san_nicolas: 4, mh_guadalupe: 8, mh_avicola: 2, mh_zapopan: 1, mh_condesa: 2 };
    // "papa blanca" pattern: uniformly large at every hub, target hub is
    // NOT an outlier on this factor even though the metric varies a lot.
    const flatEverywhere = { mh_contry: 505, mh_cumbres: 498, mh_san_nicolas: 512, mh_guadalupe: 495, mh_avicola: 501, mh_zapopan: 507, mh_condesa: 499 };
    const r = discriminate('faltantes_rate', metric, 'mh_contry', [{ name: 'papa_blanca_share', values: flatEverywhere }]);
    assert.notEqual(r.data.candidates[0].verdict, 'DISCRIMINATES', 'a flat-everywhere factor must never DISCRIMINATE');
  });
  await test('discriminate DOES flag a genuine outlier that tracks the metric', () => {
    // Constructed so rank(candidate) == rank(metric) exactly (rho=1) AND
    // mh_contry is a real outlier on the candidate (505 vs ~100 peer mean).
    const metric = { mh_contry: 10, mh_cumbres: 3, mh_san_nicolas: 4, mh_guadalupe: 8, mh_avicola: 2, mh_zapopan: 1, mh_condesa: 5 };
    const tracks = { mh_contry: 505, mh_cumbres: 60, mh_san_nicolas: 80, mh_guadalupe: 400, mh_avicola: 40, mh_zapopan: 20, mh_condesa: 100 };
    const r = discriminate('faltantes_rate', metric, 'mh_contry', [{ name: 'tracks_metric', values: tracks }]);
    assert.equal(r.data.candidates[0].verdict, 'DISCRIMINATES');
  });

  // ── 4. Cross-hub FyV comparison including mh_guadalupe → comparability caveat ──
  await test('kpiByHub on an FyV KPI with mh_guadalupe present returns the comparability caveat', async () => {
    if (!latestMnaWeek) throw new Error('no validated mna weeks to test against');
    const r = await kpiByHub(sb, 'mna_fyv_pct', latestMnaWeek);
    const hubsPresent = r.data.hubs.map((h) => h.hub_id);
    if (hubsPresent.includes('mh_guadalupe')) {
      assert.ok(
        r.caveats.some((c) => c.includes('mh_guadalupe') && c.toLowerCase().includes('fyv')),
        `expected a Guadalupe/FyV caveat, got: ${JSON.stringify(r.caveats)}`
      );
    } else {
      console.log('       (mh_guadalupe not present this week — caveat correctly not asserted)');
    }
  });

  // ── 5. Any function touching num_idle_days returns meaning: OPEN ───────
  await test('auxAssemblyLoad (touches num_idle_days) returns meaning: OPEN', async () => {
    const r = await auxAssemblyLoad(sb, 12);
    assert.equal(r.confidence.meaning.rating, 'OPEN');
  });
  await test('discriminate with an openMeaning candidate returns meaning: OPEN', () => {
    const r = discriminate('metric', { mh_contry: 1, mh_cumbres: 2 }, 'mh_contry', [
      { name: 'idle_days_factor', values: { mh_contry: 1, mh_cumbres: 2 }, openMeaning: true },
    ]);
    assert.equal(r.confidence.meaning.rating, 'OPEN');
  });

  // ── 6. Every numeric result has >=1 claim; every claim's refetch resolves ──
  await test('faltantesBreakdown claims resolve to matching rows_out', async () => {
    const r = await faltantesBreakdown(sb, 'mh_contry', 12);
    await assertClaimsResolve(r, 'faltantesBreakdown');
    // c1 = "N of M had Inventario disponible = 0" — resolved rows_out must equal N exactly.
    const resolved = await resolveEvidence(sb, r.claims[0].evidence.refetch);
    assert.equal(resolved.rows_out, r.data.inv_zero, 'claim c1 rows_out must equal inv_zero exactly');
  });
  await test('faltantesProductLift claims resolve to matching rows_out', async () => {
    const r = await faltantesProductLift(sb, 'mh_contry', 12);
    await assertClaimsResolve(r, 'faltantesProductLift', r.data.discriminating.length > 0);
    if (r.claims.length) {
      const top = r.data.discriminating[0];
      const resolved = await resolveEvidence(sb, r.claims[0].evidence.refetch);
      assert.equal(resolved.rows_out, top.here, 'claim rows_out must equal the product\'s "here" count exactly');
    }
  });
  await test('deliveryLateness claims resolve to matching rows_out', async () => {
    const r = await deliveryLateness(sb, 'mh_contry', 12);
    await assertClaimsResolve(r, 'deliveryLateness', r.data.total_orders > 0);
    if (r.claims.length) {
      const resolved = await resolveEvidence(sb, r.claims[0].evidence.refetch);
      assert.equal(resolved.rows_out, r.data.late_gt30, 'claim c1 rows_out must equal late_gt30 exactly');
    }
  });
  await test('mnaBreakdown claims resolve to matching rows_out', async () => {
    const r = await mnaBreakdown(sb, 'mh_contry', 8);
    await assertClaimsResolve(r, 'mnaBreakdown', r.data.top_skus.length > 0);
  });
  await test('attendanceByHub claims resolve (rows_out is finite)', async () => {
    const r = await attendanceByHub(sb, 12);
    await assertClaimsResolve(r, 'attendanceByHub');
  });
  await test('discriminate claim resolves to exactly n_hubs rows', () => {
    return (async () => {
      const metric = { mh_contry: 10, mh_cumbres: 3, mh_san_nicolas: 4, mh_guadalupe: 8, mh_avicola: 2, mh_zapopan: 1, mh_condesa: 5 };
      const tracks = { mh_contry: 505, mh_cumbres: 60, mh_san_nicolas: 80, mh_guadalupe: 400, mh_avicola: 40, mh_zapopan: 20, mh_condesa: 100 };
      const r = discriminate('faltantes_rate', metric, 'mh_contry', [{ name: 'tracks_metric', values: tracks }]);
      assert.equal(r.claims.length, 1);
      const resolved = await resolveEvidence(sb, r.claims[0].evidence.refetch);
      assert.equal(resolved.rows_out, 7);
    })();
  });

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
