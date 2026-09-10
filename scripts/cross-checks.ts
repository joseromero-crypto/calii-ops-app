/**
 * CROSS-FILE RECONCILIATION TESTS — READ ONLY
 *
 * Three claims made during the operations-context sessions, each involving two
 * different weekly files describing the same underlying events. All three are
 * currently 🔶 ASSUMED. This settles them.
 *
 *   TEST A — 3PL volume
 *     Claim: pedidos_entregados (Retool, all orders) − Σ driver num_orders ≈ Uber Direct.
 *     Falsified if the gap is frequently NEGATIVE (drivers can't deliver more
 *     orders than the hub received) or wildly unstable week to week.
 *
 *   TEST B — complaint linking (OPS_CONTEXT.md §5.4)
 *     Claim: the same customer complaint is written to BOTH the armador's row
 *     and the driver's row. If so, hub-week TOTALS should match closely.
 *     This decides whether the bipartite armador/driver attribution works at all.
 *
 *   TEST C — failed-delivery reconciliation (OPS_CONTEXT.md §5.3)
 *     Claim: desempeno_repartidores.num_undelivered_orders and
 *     discrepancia."Por devolver" describe the same events from two files.
 *
 * Compare TOTALS per hub-week, never per-person means — a driver handles more
 * orders per week than an armador assembles, so means differ even when the
 * underlying sets are identical.
 *
 * Run from the project root:
 *   npx tsx scripts/cross-checks.ts
 *
 * Nothing is written to Supabase. Safe to re-run.
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
import { config } from 'dotenv';
import { resolveHubId } from '../lib/hub-aliases';

config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const PAGE = 1000;

async function fetchAll<T = any>(table: string, select: string, build?: (q: any) => any, cap = 300000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    let q = sb.from(table).select(select).range(from, from + PAGE - 1);
    if (build) q = build(q);
    const { data, error } = await q;
    if (error) { console.error(`  ! ${table}: ${error.message}`); break; }
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < PAGE) break;
  }
  return out;
}

const toNum = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : NaN; }
  return NaN;
};
const add = (m: Map<string, number>, k: string, v: number) => {
  if (Number.isFinite(v)) m.set(k, (m.get(k) ?? 0) + v);
};
const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');

/** Summary stats over a set of per-hub-week deltas. */
function summarise(rows: { key: string; a: number; b: number }[]) {
  const withBoth = rows.filter((r) => Number.isFinite(r.a) && Number.isFinite(r.b));
  const diffs = withBoth.map((r) => r.a - r.b);
  const rels = withBoth.filter((r) => r.a > 0).map((r) => (r.a - r.b) / r.a);
  const neg = diffs.filter((d) => d < -0.5).length;
  const mean = diffs.reduce((s, d) => s + d, 0) / (diffs.length || 1);
  const absRel = rels.map(Math.abs).sort((x, y) => x - y);
  const median = absRel.length ? absRel[Math.floor(absRel.length / 2)] : NaN;
  const within5 = rels.filter((r) => Math.abs(r) <= 0.05).length;
  return { n: withBoth.length, neg, mean, median, within5 };
}

async function main() {
  const L: string[] = [];
  const say = (s = '') => { L.push(s); console.log(s); };

  const uploads = (await fetchAll<any>('uploads', 'id, app_id, week_start, status'))
    .filter((u) => u.status === 'validated');
  const weekById = new Map(uploads.map((u: any) => [u.id, u.week_start]));
  const ids = (app: string) => uploads.filter((u: any) => u.app_id === app).map((u: any) => u.id);

  say('='.repeat(78));
  say('CROSS-FILE RECONCILIATION TESTS');
  say('='.repeat(78));

  // ---- load the three person-level files, aggregated to hub-week -----------
  const drvRows = await fetchAll<any>('upload_rows', 'upload_id, data', (q) => q.in('upload_id', ids('desempeno_repartidores')).eq('is_excluded', false));
  const opRows  = await fetchAll<any>('upload_rows', 'upload_id, data', (q) => q.in('upload_id', ids('desempeno_operadores')).eq('is_excluded', false));
  const disRows = await fetchAll<any>('upload_rows', 'upload_id, data', (q) => q.in('upload_id', ids('discrepancia')));

  const drvOrders = new Map<string, number>();      // Σ num_orders
  const drvUndel  = new Map<string, number>();      // Σ num_undelivered_orders
  const drvComplaint: Record<string, Map<string, number>> = {};
  const opComplaint: Record<string, Map<string, number>> = {};
  const SHARED = ['num_orders_with_missing_items', 'num_orders_with_partial_missing',
                  'num_orders_with_full_missing', 'num_orders_with_bad_quality'];
  for (const c of SHARED) { drvComplaint[c] = new Map(); opComplaint[c] = new Map(); }

  for (const r of drvRows) {
    const d = r.data ?? {};
    const hub = resolveHubId(String(d['hub'] ?? '').trim());
    const wk = weekById.get(r.upload_id);
    if (!hub || !wk) continue;
    const k = `${hub}|${wk}`;
    add(drvOrders, k, toNum(d['num_orders']));
    add(drvUndel, k, toNum(d['num_undelivered_orders']));
    for (const c of SHARED) add(drvComplaint[c], k, toNum(d[c]));
  }

  for (const r of opRows) {
    const d = r.data ?? {};
    const hub = resolveHubId(String(d['geofence'] ?? '').trim());
    const wk = weekById.get(r.upload_id);
    if (!hub || !wk) continue;
    const k = `${hub}|${wk}`;
    for (const c of SHARED) add(opComplaint[c], k, toNum(d[c]));
  }

  const disPorDevolver = new Map<string, number>();
  for (const r of disRows) {
    const d = r.data ?? {};
    const hub = resolveHubId(String(d['Hub'] ?? '').trim());
    const wk = weekById.get(r.upload_id);
    if (!hub || !wk) continue;
    add(disPorDevolver, `${hub}|${wk}`, toNum(d['Por devolver']));
  }

  // ---- TEST A -------------------------------------------------------------
  say('');
  say('─'.repeat(78));
  say('TEST A — 3PL volume  =  pedidos_entregados − Σ driver num_orders');
  say('─'.repeat(78));
  say('Reading pedidos_entregados from kpi_snapshots (hub scope) so we use the');
  say('SHIPPED definition, not a re-derivation.');
  say('⚠ resumen_operativo starts 2026-05-01, so only ~15 weeks are testable.\n');

  const snaps = await fetchAll<any>('kpi_snapshots', 'kpi_id, week_start, scope_level, scope_key, value',
    (q) => q.eq('kpi_id', 'pedidos_entregados').eq('scope_level', 'hub'));
  const entregados = new Map<string, number>();
  for (const s of snaps) if (s.scope_key) entregados.set(`${s.scope_key}|${s.week_start}`, toNum(s.value));

  const rowsA: { key: string; a: number; b: number }[] = [];
  for (const [k, v] of entregados) {
    const drv = drvOrders.get(k);
    if (drv === undefined) continue;
    rowsA.push({ key: k, a: v, b: drv });
  }
  rowsA.sort((x, y) => x.key.localeCompare(y.key));

  if (!rowsA.length) {
    say('  no overlapping hub-weeks — cannot test');
  } else {
    const s = summarise(rowsA);
    say(`  ${'hub | week'.padEnd(28)} ${'entregados'.padStart(11)} ${'Σ drivers'.padStart(10)} ${'gap'.padStart(8)} ${'gap %'.padStart(7)}`);
    for (const r of rowsA.slice(-28)) {
      const gap = r.a - r.b;
      const pct = r.a > 0 ? (gap / r.a) * 100 : NaN;
      const flag = gap < -0.5 ? '  ⚠ NEGATIVE' : '';
      say(`  ${r.key.replace('|', ' | ').padEnd(28)} ${fmt(r.a, 0).padStart(11)} ${fmt(r.b, 0).padStart(10)} ${fmt(gap, 0).padStart(8)} ${fmt(pct).padStart(6)}%${flag}`);
    }
    say('');
    say(`  hub-weeks compared:      ${s.n}`);
    say(`  NEGATIVE gaps:           ${s.neg}  ${s.neg > s.n * 0.1 ? '← ⚠ HYPOTHESIS FALSIFIED: drivers cannot deliver more than the hub received' : '← consistent with the hypothesis'}`);
    say(`  mean gap (orders):       ${fmt(s.mean)}`);
    say(`  median |gap| as % of entregados: ${fmt((s.median ?? 0) * 100)}%`);
    say('');
    say('  READ IT THIS WAY:');
    say('   · Few/no negatives + a stable positive gap → the gap is real 3PL volume.');
    say('   · Many negatives → the two numbers count different things; hypothesis dead.');
    say('   · Gap ≈ 0 everywhere → 3PL volume is negligible, or it IS in the driver file.');
    say('   · Wild week-to-week swings → something else is moving; do not use as a metric.');
  }

  // ---- TEST B -------------------------------------------------------------
  say('');
  say('─'.repeat(78));
  say('TEST B — is the same complaint written to BOTH armador and driver rows?');
  say('─'.repeat(78));
  say('If yes, hub-week TOTALS should match closely (same orders, grouped by the');
  say('two people who touched them). Decides whether bipartite attribution works.\n');

  for (const c of SHARED) {
    const keys = new Set([...opComplaint[c].keys(), ...drvComplaint[c].keys()]);
    const rowsB = [...keys].map((k) => ({ key: k, a: opComplaint[c].get(k) ?? NaN, b: drvComplaint[c].get(k) ?? NaN }))
      .filter((r) => Number.isFinite(r.a) && Number.isFinite(r.b));
    if (!rowsB.length) { say(`  ${c}: no overlap`); continue; }
    const s = summarise(rowsB);
    const opTot = rowsB.reduce((t, r) => t + r.a, 0);
    const drvTot = rowsB.reduce((t, r) => t + r.b, 0);
    const ratio = opTot > 0 ? drvTot / opTot : NaN;
    say(`  ${c}`);
    say(`    hub-weeks ${s.n}   armador total ${fmt(opTot, 0)}   driver total ${fmt(drvTot, 0)}   ratio ${fmt(ratio, 2)}×`);
    say(`    within ±5% per hub-week: ${s.within5}/${s.n}   median |rel diff| ${fmt((s.median ?? 0) * 100)}%`);
    const ratioOk = Math.abs(ratio - 1) < 0.1;
    const weekShareOk = s.n > 0 && s.within5 / s.n >= 0.6;
    const verdict = ratioOk && weekShareOk
      ? '✅ totals match → same complaint set → BIPARTITE METHOD VALID'
      : ratio > 1.5 || ratio < 0.67
        ? '❌ totals differ substantially → different complaint sets → method off the table'
        : '🔶 partial overlap → inspect before relying on it';
    say(`    ${verdict}`);
    say('');
  }

  // ---- TEST C -------------------------------------------------------------
  say('─'.repeat(78));
  say('TEST C — num_undelivered_orders (repartidores) vs "Por devolver" (discrepancia)');
  say('─'.repeat(78) + '\n');

  const keysC = new Set([...drvUndel.keys(), ...disPorDevolver.keys()]);
  const rowsC = [...keysC].map((k) => ({ key: k, a: drvUndel.get(k) ?? NaN, b: disPorDevolver.get(k) ?? NaN }))
    .filter((r) => Number.isFinite(r.a) && Number.isFinite(r.b))
    .sort((x, y) => x.key.localeCompare(y.key));

  if (!rowsC.length) {
    say('  no overlapping hub-weeks — cannot test');
  } else {
    const s = summarise(rowsC);
    const undelTot = rowsC.reduce((t, r) => t + r.a, 0);
    const devTot = rowsC.reduce((t, r) => t + r.b, 0);
    say(`  ${'hub | week'.padEnd(28)} ${'undelivered'.padStart(12)} ${'por devolver'.padStart(13)} ${'diff'.padStart(7)}`);
    for (const r of rowsC.slice(-20)) {
      say(`  ${r.key.replace('|', ' | ').padEnd(28)} ${fmt(r.a, 0).padStart(12)} ${fmt(r.b, 0).padStart(13)} ${fmt(r.a - r.b, 0).padStart(7)}`);
    }
    say('');
    say(`  hub-weeks ${s.n}   undelivered total ${fmt(undelTot, 0)}   por devolver total ${fmt(devTot, 0)}   ratio ${fmt(devTot / (undelTot || 1), 2)}×`);
    say(`  within ±5% per hub-week: ${s.within5}/${s.n}`);
    say('');
    say('  A stable ratio near 1 means both pipelines see the same events.');
    say('  A persistent gap means one of them is dropping rows — worth finding.');
  }

  writeFileSync('cross-checks.txt', L.join('\n'));
  say('\n✅ Wrote cross-checks.txt to the project root.');
}

main().catch((e) => { console.error(e); process.exit(1); });
