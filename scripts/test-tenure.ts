/**
 * Unit tests for tenureStatus / resolvePersonTarget —
 * PLAN_MODO_ENTRENAMIENTO.md §9 slice 4, test matrix in §10.
 *
 * No test framework in this repo yet (no jest/vitest) — plain
 * node:assert/strict, run via tsx, same convention as every other
 * scripts/*.ts verification script here.
 *
 * Run from the project root:
 *   npx tsx scripts/test-tenure.ts
 */
import assert from 'node:assert/strict';
import {
  weeksBetween,
  tenureStatus,
  tenureLabel,
  computeReentryWeeks,
  RAMP_WEEKS,
  REENTRY_GAP_WEEKS,
  REENTRY_LABEL_WEEKS,
  type TenureRow,
  type TenureStatus,
} from '../lib/tenure';
import {
  resolvePersonTarget,
  resolveTarget,
  meetsTarget,
  type KpiTarget,
  type RampTarget,
} from '../app/(app)/historicos/_shared';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (e: any) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
}

// ── Fixture helpers ──────────────────────────────────────────────────────
// Friday anchor, arbitrary — only relative spacing matters for these tests.
const ANCHOR = '2026-01-02'; // confirmed Friday
function fri(n: number): string {
  const d = new Date(`${ANCHOR}T12:00:00`);
  d.setDate(d.getDate() + n * 7);
  return d.toISOString().slice(0, 10);
}

function makeRow(overrides: Partial<TenureRow>): TenureRow {
  return {
    person_key: '1',
    role: 'armador',
    first_seen_week: fri(0),
    last_seen_week: fri(0),
    seen_weeks: [fri(0)],
    display_names: ['Test Person'],
    hub_id_first: 'mh_contry',
    hub_id_last: 'mh_contry',
    city_last: 'Monterrey',
    confidence: 'high',
    confidence_reason: null,
    source: 'derived',
    reentry_weeks: [],
    ...overrides,
  };
}

const RAMP_ROWS: RampTarget[] = Array.from({ length: 10 }, (_, i) => ({
  kpi_id: 'tasa_armado',
  role: 'armador' as const,
  week_number: i + 1,
  target_value: [50, 60, 65, 70, 75, 80, 85, 90, 95, 100][i],
  stretch_value: [55, 65, 70, 75, 80, 85, 90, 95, 100, 100][i],
  comparator: 'gte' as const,
  unit: 'rate',
  active: true,
}));

const GLOBAL_VETERAN_TARGET: KpiTarget = {
  kpi_id: 'tasa_armado',
  scope_level: 'global',
  scope_key: null,
  target_value: 90,
  comparator: 'gte',
  unit: 'rate',
  active: true,
};
const HUB_OVERRIDE_TARGET: KpiTarget = {
  kpi_id: 'tasa_armado',
  scope_level: 'hub',
  scope_key: 'mh_contry',
  target_value: 120,
  comparator: 'gte',
  unit: 'rate',
  active: true,
};
const TARGETS = [GLOBAL_VETERAN_TARGET, HUB_OVERRIDE_TARGET];

console.log('\n=== tenureStatus ===');

test('no ledger row → veteran; resolves to hub/global target', () => {
  const status = tenureStatus(undefined, fri(5));
  assert.deepEqual(status, { kind: 'veteran' });
  const { target, stretch } = resolvePersonTarget('tasa_armado', 'mh_contry', status, 'armador', TARGETS, RAMP_ROWS);
  assert.equal(target?.target_value, 120); // hub override wins, no ramp involved
  assert.equal(stretch, null);
});

test("confidence='low' row → veteran, never a trainee", () => {
  const row = makeRow({ first_seen_week: fri(0), confidence: 'low', confidence_reason: 'data_horizon' });
  const status = tenureStatus(row, fri(0));
  assert.deepEqual(status, { kind: 'veteran' });
});

test('first_seen_week == displayed week → S1, target 50, stretch 55', () => {
  const row = makeRow({ first_seen_week: fri(10), seen_weeks: [fri(10)] });
  const status = tenureStatus(row, fri(10));
  assert.deepEqual(status, { kind: 'trainee', week: 1 });
  assert.equal(tenureLabel(status), ' (S1)');
  const { target, stretch } = resolvePersonTarget('tasa_armado', 'mh_contry', status, 'armador', TARGETS, RAMP_ROWS);
  assert.equal(target?.target_value, 50);
  assert.equal(stretch, 55);
});

test('first_seen_week 2 weeks before displayed week → S3, target 65, stretch 70', () => {
  const row = makeRow({ first_seen_week: fri(10), seen_weeks: [fri(10), fri(11), fri(12)] });
  const status = tenureStatus(row, fri(12));
  assert.deepEqual(status, { kind: 'trainee', week: 3 });
  const { target, stretch } = resolvePersonTarget('tasa_armado', 'mh_contry', status, 'armador', TARGETS, RAMP_ROWS);
  assert.equal(target?.target_value, 65);
  assert.equal(stretch, 70);
});

test('first_seen_week 9 weeks before → S10, target 100, stretch 100 ("100+" is a UI concern)', () => {
  const row = makeRow({ first_seen_week: fri(0), seen_weeks: [fri(0), fri(9)] });
  const status = tenureStatus(row, fri(9));
  assert.deepEqual(status, { kind: 'trainee', week: 10 });
  const { target, stretch } = resolvePersonTarget('tasa_armado', 'mh_contry', status, 'armador', TARGETS, RAMP_ROWS);
  assert.equal(target?.target_value, 100);
  assert.equal(stretch, 100);
});

test('first_seen_week 10 weeks before → veteran, no badge, veteran target', () => {
  const row = makeRow({ first_seen_week: fri(0), seen_weeks: [fri(0), fri(10)] });
  const status = tenureStatus(row, fri(10));
  assert.deepEqual(status, { kind: 'veteran' });
  assert.equal(tenureLabel(status), '');
  const { target, stretch } = resolvePersonTarget('tasa_armado', 'mh_contry', status, 'armador', TARGETS, RAMP_ROWS);
  assert.equal(target?.target_value, 120); // hub override — veteran target, not ramp
  assert.equal(stretch, null);
});

test('displayed week before first_seen_week → veteran, no badge (never S0 or negative)', () => {
  const row = makeRow({ first_seen_week: fri(10), seen_weeks: [fri(10)] });
  const status = tenureStatus(row, fri(5));
  assert.deepEqual(status, { kind: 'veteran' });
});

test('repartidor, first_seen_week 3 weeks before → S4; no ramp row → hub/global target unchanged', () => {
  const row = makeRow({ role: 'repartidor', first_seen_week: fri(0), seen_weeks: [fri(0), fri(3)] });
  const status = tenureStatus(row, fri(3));
  assert.deepEqual(status, { kind: 'trainee', week: 4 });
  const { target, stretch } = resolvePersonTarget('tasa_armado', 'mh_contry', status, 'repartidor', TARGETS, RAMP_ROWS);
  // No repartidor ramp rows exist — must fall through to hub/global, not throw or warn.
  assert.equal(target?.target_value, 120);
  assert.equal(stretch, null);
});

test('repartidor, first_seen_week 4 weeks before → veteran (4-week cap)', () => {
  const row = makeRow({ role: 'repartidor', first_seen_week: fri(0), seen_weeks: [fri(0), fri(4)] });
  const status = tenureStatus(row, fri(4));
  assert.deepEqual(status, { kind: 'veteran' });
  assert.equal(RAMP_WEEKS.repartidor, 4);
});

console.log('\n=== computeReentryWeeks (§5.2 guard) ===');

test('absent 10 calendar weeks, present this week → RI, veteran target', () => {
  const seenWeeks = [fri(0), fri(10)];
  const weeksWithData = new Set(Array.from({ length: 11 }, (_, i) => fri(i))); // every week has data
  const reentry = computeReentryWeeks(seenWeeks, weeksWithData);
  assert.deepEqual(reentry, [fri(10)]);
  const row = makeRow({ first_seen_week: fri(0), seen_weeks: seenWeeks, reentry_weeks: reentry });
  const status = tenureStatus(row, fri(10));
  assert.deepEqual(status, { kind: 'reentry', week: 1 });
  assert.equal(tenureLabel(status), ' (RI)');
  const { target, stretch } = resolvePersonTarget('tasa_armado', 'mh_contry', status, 'armador', TARGETS, RAMP_ROWS);
  assert.equal(target?.target_value, 120); // veteran target — RI never changes the target
  assert.equal(stretch, null);
});

test('absent 10 calendar weeks, 3 weeks after return → veteran (RI label expired)', () => {
  const seenWeeks = [fri(0), fri(10), fri(11), fri(12), fri(13)];
  const weeksWithData = new Set(Array.from({ length: 14 }, (_, i) => fri(i)));
  const reentry = computeReentryWeeks(seenWeeks, weeksWithData);
  const row = makeRow({ first_seen_week: fri(0), seen_weeks: seenWeeks, reentry_weeks: reentry });
  const status = tenureStatus(row, fri(13)); // 3 weeks after the return week (fri(10))
  assert.deepEqual(status, { kind: 'veteran' });
  assert.equal(REENTRY_LABEL_WEEKS, 2);
});

test('absent 10 calendar weeks, SOME uploads exist in window → RI (real absence)', () => {
  const seenWeeks = [fri(0), fri(10)];
  // Uploads exist at fri(5) inside the (fri(0), fri(10)) gap window.
  const weeksWithData = new Set([fri(0), fri(5), fri(10)]);
  const reentry = computeReentryWeeks(seenWeeks, weeksWithData);
  assert.deepEqual(reentry, [fri(10)]);
});

test('absent 10 calendar weeks, ZERO uploads in whole window → not RI (no evidence)', () => {
  const seenWeeks = [fri(0), fri(10)];
  // No uploads at all strictly between fri(0) and fri(10) — the app just
  // wasn't uploaded that whole stretch. Suppress the claim per §5.2.
  const weeksWithData = new Set([fri(0), fri(10)]);
  const reentry = computeReentryWeeks(seenWeeks, weeksWithData);
  assert.deepEqual(reentry, []);
  const row = makeRow({ first_seen_week: fri(0), seen_weeks: seenWeeks, reentry_weeks: reentry });
  const status = tenureStatus(row, fri(10));
  // Not reentry, but also long past the ramp → veteran either way.
  assert.deepEqual(status, { kind: 'veteran' });
});

test("person's very first appearance → never a return", () => {
  const seenWeeks = [fri(0)];
  const weeksWithData = new Set([fri(0)]);
  const reentry = computeReentryWeeks(seenWeeks, weeksWithData);
  assert.deepEqual(reentry, []);
});

test('trainee at S3 who left and returned 11 weeks later → RI badge, VETERAN target (calendar S14)', () => {
  // Present weeks 0,1,2 (through S3), gone, back at week 13 (11 calendar
  // weeks after their last appearance at week 2).
  const seenWeeks = [fri(0), fri(1), fri(2), fri(13)];
  const weeksWithData = new Set(Array.from({ length: 14 }, (_, i) => fri(i)));
  const reentry = computeReentryWeeks(seenWeeks, weeksWithData);
  assert.deepEqual(reentry, [fri(13)]);
  const row = makeRow({ first_seen_week: fri(0), seen_weeks: seenWeeks, reentry_weeks: reentry });
  const status = tenureStatus(row, fri(13));
  // weeksBetween(first_seen_week, fri(13)) + 1 = 14 → past the 10-week ramp
  // even though reentry precedence would otherwise show RI regardless.
  assert.deepEqual(status, { kind: 'reentry', week: 1 });
  const { target, stretch } = resolvePersonTarget('tasa_armado', 'mh_contry', status, 'armador', TARGETS, RAMP_ROWS);
  assert.equal(target?.target_value, 120); // veteran (hub override), not a ramp row
  assert.equal(stretch, null);
});

console.log('\n=== resolvePersonTarget precedence ===');

test('trainee at S3, hub override exists → ramp mínimo wins over hub override', () => {
  const row = makeRow({ first_seen_week: fri(10), seen_weeks: [fri(10), fri(11), fri(12)] });
  const status = tenureStatus(row, fri(12));
  assert.deepEqual(status, { kind: 'trainee', week: 3 });
  const { target } = resolvePersonTarget('tasa_armado', 'mh_contry', status, 'armador', TARGETS, RAMP_ROWS);
  assert.equal(target?.target_value, 65); // ramp mínimo, NOT the 120 hub override
});

test('veteran, hub override exists → hub override wins (unchanged behavior)', () => {
  const status: TenureStatus = { kind: 'veteran' };
  const { target } = resolvePersonTarget('tasa_armado', 'mh_contry', status, 'armador', TARGETS, RAMP_ROWS);
  assert.equal(target?.target_value, 120);
  // Sanity: plain resolveTarget agrees (this is the pre-existing, unchanged resolver).
  assert.equal(resolveTarget('tasa_armado', 'mh_contry', TARGETS)?.target_value, 120);
});

console.log('\n=== meetsTarget strict boundary ===');

test('value exactly equal to the mínimo → NOT met (strict boundary)', () => {
  const ramp = RAMP_ROWS[2]; // week 3, target_value 65, comparator gte
  const target: KpiTarget = {
    kpi_id: ramp.kpi_id, scope_level: 'global', scope_key: null,
    target_value: ramp.target_value, comparator: ramp.comparator, unit: ramp.unit, active: true,
  };
  assert.equal(meetsTarget(65, target), false);   // exactly on the line — does not count
  assert.equal(meetsTarget(65.01, target), true); // clears it
  assert.equal(meetsTarget(64.99, target), false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
