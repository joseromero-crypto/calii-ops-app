/**
 * COLUMN REVERSE-ENGINEERING — READ ONLY
 *
 * For a column whose meaning nobody remembers, test whether it can be derived
 * from columns we DO understand. Per José's rule: only accept a derivation at
 * ~100% match (98%+ where floats and rounding are involved). Anything below
 * that is reported as a lead, not an answer.
 *
 * Hypotheses tested, against the FULL history (not a sample):
 *   H1  T == C                     identity with another column
 *   H2  T == A + B                 sum of any two columns
 *   H3  T == A − B                 difference of any two columns
 *   H4  T == K − C  /  C − K       calendar arithmetic, K = 0..7
 *   H5  T == K                     constant
 *   H6  T == count of `incidentes` rows for the same person-week, by Tipo
 *       (cross-file, joined on normalised person name — only for the two
 *        weekly person files)
 *   H7  T == A / B                 ratio of any two columns
 *   H8  T == min(A / B, K)         capped ratio, K = 7/14/30/45/60/90/120/180/365
 *       H8 exists because a "days of cover" column with a hard ceiling looks
 *       like noise until you test for the ceiling. min() also catches the
 *       divide-by-zero fallback: when B = 0 the ratio is Infinity and the
 *       capped value is exactly K.
 *
 * Correlations are printed separately and clearly marked WEAK. A high
 * correlation is a hint about what a column relates to. It is NOT a
 * derivation and must never be recorded as one.
 *
 * Run from the project root:
 *   npx tsx scripts/reverse-engineer.ts
 *   npx tsx scripts/reverse-engineer.ts desempeno_operadores num_idle_days
 *
 * Nothing is written to Supabase. Safe to re-run.
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
import { config } from 'dotenv';
import { normalizeName } from '../lib/normalize';

config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

/** Accept a derivation at or above this. José's rule. */
const ACCEPT = 0.98;
/** Report as a lead worth looking at, but NOT an answer. */
const LEAD = 0.80;
const PAGE = 1000;

/** Default targets — the columns DATA_DICTIONARY.md currently lists as OPEN. */
const DEFAULT_TARGETS: [string, string][] = [
  ['desempeno_operadores', 'num_idle_days'],
  ['desempeno_operadores', 'order_total_multiplier'],
  ['desempeno_operadores', 'normalized_num_assembly_minutes'],
  ['desempeno_repartidores', 'num_admin_incidents'],
  // José confirmed the INTENT of this one (days of stock cover at current
  // consumption). We are testing whether the shipped VALUE matches that intent,
  // because '0' / '90' / '45' dominate and look like caps, not measurements.
  ['mna', 'Días de inventario'],
  ['mna', '1 en N pedidos'],
];

/**
 * Row cap per app. Derivation testing does not need every row — a formula either
 * holds or it does not — and `mna` has 670k rows against ~22 columns, which makes
 * the pairwise battery expensive. Whatever cap applies is printed in the report.
 */
const ROW_CAP: Record<string, number> = { mna: 50000 };
const DEFAULT_ROW_CAP = 100000;

// ---------------------------------------------------------------------------
async function fetchAll<T = any>(table: string, select: string, build?: (q: any) => any, cap = 200000): Promise<T[]> {
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

const num = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : NaN; }
  return NaN;
};

/** Tolerant equality — exact for integers, 0.5% relative for floats. */
function eq(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (Number.isInteger(a) && Number.isInteger(b)) return a === b;
  return Math.abs(a - b) <= 0.005 * Math.max(1, Math.abs(a));
}

function matchRate(target: number[], candidate: (i: number) => number): { rate: number; n: number } {
  let hit = 0, n = 0;
  for (let i = 0; i < target.length; i++) {
    const t = target[i];
    if (!Number.isFinite(t)) continue;
    const c = candidate(i);
    if (!Number.isFinite(c)) continue;
    n++;
    if (eq(t, c)) hit++;
  }
  return { rate: n === 0 ? 0 : hit / n, n };
}

function pearson(a: number[], b: number[]): number {
  const pairs: [number, number][] = [];
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) pairs.push([a[i], b[i]]);
  if (pairs.length < 3) return NaN;
  const n = pairs.length;
  const ma = pairs.reduce((s, p) => s + p[0], 0) / n;
  const mb = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sab = 0, sa = 0, sbb = 0;
  for (const [x, y] of pairs) { sab += (x - ma) * (y - mb); sa += (x - ma) ** 2; sbb += (y - mb) ** 2; }
  return sa === 0 || sbb === 0 ? NaN : sab / Math.sqrt(sa * sbb);
}

interface Result { label: string; rate: number; n: number; }

// ---------------------------------------------------------------------------
async function main() {
  const argApp = process.argv[2];
  const argCol = process.argv[3];
  const targets: [string, string][] = argApp && argCol ? [[argApp, argCol]] : DEFAULT_TARGETS;

  const L: string[] = [];
  const say = (s = '') => { L.push(s); console.log(s); };

  const uploads = await fetchAll<any>('uploads', 'id, app_id, week_start, status')
    .then((u) => u.filter((x) => x.status === 'validated'));

  // Pre-load incidentes once, indexed by person-week, for H6.
  say('Loading incidentes for the cross-file test…');
  const incUploads = uploads.filter((u) => u.app_id === 'incidentes');
  const incWeekById = new Map(incUploads.map((u) => [u.id, u.week_start]));
  const incRows = await fetchAll<any>('upload_rows', 'upload_id, data', (q) => q.in('upload_id', [...incWeekById.keys()]));
  /** `${normalisedName}|${week}|${tipo}` -> count, plus a `|*` total per person-week */
  const incIndex = new Map<string, number>();
  const tipos = new Set<string>();
  for (const r of incRows) {
    const d = r.data ?? {};
    const person = normalizeName(String(d['Operador'] ?? ''));
    const week = incWeekById.get(r.upload_id);
    const tipo = String(d['Tipo de incidente'] ?? '').trim();
    if (!person || !week) continue;
    tipos.add(tipo);
    for (const k of [`${person}|${week}|${tipo}`, `${person}|${week}|*`]) {
      incIndex.set(k, (incIndex.get(k) ?? 0) + 1);
    }
  }
  say(`  ${incRows.length} incidentes rows · tipos seen: ${[...tipos].join(', ')}\n`);

  for (const [appId, targetCol] of targets) {
    say('='.repeat(78));
    say(`TARGET:  ${appId}.${targetCol}`);
    say('='.repeat(78));

    const appUploads = uploads.filter((u) => u.app_id === appId);
    const weekById = new Map(appUploads.map((u) => [u.id, u.week_start]));
    const cap = ROW_CAP[appId] ?? DEFAULT_ROW_CAP;
    const rows = await fetchAll<any>('upload_rows', 'upload_id, data',
      (q) => q.in('upload_id', [...weekById.keys()]).eq('is_excluded', false), cap);
    if (rows.length >= cap) say(`  ⚠ row cap ${cap} reached — testing a prefix of the history, not all of it`);

    if (!rows.length) { say('  no rows\n'); continue; }

    const data = rows.map((r) => r.data ?? {});
    const target = data.map((d) => num(d[targetCol]));
    const defined = target.filter(Number.isFinite).length;
    if (defined === 0) { say(`  ${targetCol} has no numeric values — cannot test.\n`); continue; }

    // Which other columns are numeric enough to be worth testing?
    const allKeys = [...new Set(data.flatMap((d) => Object.keys(d)))].filter((k) => k !== targetCol);
    const cols = new Map<string, number[]>();
    for (const k of allKeys) {
      const v = data.map((d) => num(d[k]));
      if (v.filter(Number.isFinite).length >= defined * 0.5) cols.set(k, v);
    }

    const uniq = new Set(target.filter(Number.isFinite));
    say(`  rows: ${rows.length}   ${targetCol} non-null: ${defined}`);
    say(`  distinct values: ${uniq.size}   range: ${Math.min(...uniq)} … ${Math.max(...uniq)}`);
    say(`  numeric columns available to test against: ${cols.size}`);
    say(`  weeks covered: ${new Set([...weekById.values()]).size}\n`);

    const results: Result[] = [];

    // H1 identity
    for (const [k, v] of cols) {
      const { rate, n } = matchRate(target, (i) => v[i]);
      results.push({ label: `= ${k}`, rate, n });
    }

    // H5 constant
    for (let K = 0; K <= 7; K++) {
      const { rate, n } = matchRate(target, () => K);
      results.push({ label: `= ${K} (constant)`, rate, n });
    }

    // H4 calendar arithmetic
    for (const [k, v] of cols) {
      for (let K = 1; K <= 7; K++) {
        results.push({ label: `= ${K} − ${k}`, ...matchRate(target, (i) => K - v[i]) });
        results.push({ label: `= ${k} − ${K}`, ...matchRate(target, (i) => v[i] - K) });
      }
    }

    // H2 / H3 / H7 / H8 pairs
    const CAPS = [7, 14, 30, 45, 60, 90, 120, 180, 365];
    const keys = [...cols.keys()];
    for (let a = 0; a < keys.length; a++) {
      for (let b = a + 1; b < keys.length; b++) {
        const ka = keys[a], kb = keys[b];
        const va = cols.get(ka)!, vb = cols.get(kb)!;
        results.push({ label: `= ${ka} + ${kb}`, ...matchRate(target, (i) => va[i] + vb[i]) });
        results.push({ label: `= ${ka} − ${kb}`, ...matchRate(target, (i) => va[i] - vb[i]) });
        results.push({ label: `= ${kb} − ${ka}`, ...matchRate(target, (i) => vb[i] - va[i]) });
        // H7 ratios. Rows where the divisor is 0 give Infinity and are skipped,
        // so `n` on these rows is smaller — read the n, not just the rate.
        results.push({ label: `= ${ka} / ${kb}`, ...matchRate(target, (i) => va[i] / vb[i]) });
        results.push({ label: `= ${kb} / ${ka}`, ...matchRate(target, (i) => vb[i] / va[i]) });
        // H8 capped ratios. min(x/0, K) === K, so these DO cover the
        // divide-by-zero rows that H7 skips.
        for (const K of CAPS) {
          results.push({ label: `= min(${ka} / ${kb}, ${K})`, ...matchRate(target, (i) => Math.min(va[i] / vb[i], K)) });
          results.push({ label: `= min(${kb} / ${ka}, ${K})`, ...matchRate(target, (i) => Math.min(vb[i] / va[i], K)) });
        }
      }
    }

    // H6 cross-file: incidentes counts for the same person-week
    const nameCol = appId === 'desempeno_operadores' ? 'assembler'
                  : appId === 'desempeno_repartidores' ? 'driver_name' : null;
    if (nameCol) {
      const keysPW = rows.map((r, i) => {
        const person = normalizeName(String(data[i][nameCol] ?? ''));
        const week = weekById.get(r.upload_id);
        return person && week ? `${person}|${week}` : null;
      });
      const joined = keysPW.filter((k) => k && incIndex.has(`${k}|*`)).length;
      say(`  cross-file join to incidentes: ${joined}/${rows.length} person-weeks matched a name\n`);
      for (const tipo of [...tipos, '*']) {
        const label = tipo === '*' ? 'ALL tipos' : tipo;
        results.push({
          label: `= count of incidentes rows [${label}] for this person-week`,
          ...matchRate(target, (i) => (keysPW[i] ? (incIndex.get(`${keysPW[i]}|${tipo}`) ?? 0) : NaN)),
        });
      }
    }

    // ---- verdict ---------------------------------------------------------
    results.sort((a, b) => b.rate - a.rate);
    const accepted = results.filter((r) => r.rate >= ACCEPT && r.n >= defined * 0.5);
    const leads = results.filter((r) => r.rate >= LEAD && r.rate < ACCEPT && r.n >= defined * 0.5);

    if (accepted.length) {
      say(`  ✅ DERIVATION FOUND (≥${(ACCEPT * 100).toFixed(0)}% match)`);
      for (const r of accepted.slice(0, 6)) {
        say(`     ${(r.rate * 100).toFixed(2)}%  (n=${r.n})   ${targetCol} ${r.label}`);
      }
      if (accepted.length > 6) say(`     … and ${accepted.length - 6} more at or above threshold`);
    } else {
      say(`  ❌ NO DERIVATION at ≥${(ACCEPT * 100).toFixed(0)}%. ${targetCol} stays OPEN.`);
    }

    if (leads.length) {
      say(`\n  Below threshold — leads only, NOT answers:`);
      for (const r of leads.slice(0, 8)) {
        say(`     ${(r.rate * 100).toFixed(2)}%  (n=${r.n})   ${targetCol} ${r.label}`);
      }
    }

    // correlations — explicitly weak
    const corr = [...cols.entries()]
      .map(([k, v]) => ({ k, r: pearson(target, v) }))
      .filter((x) => Number.isFinite(x.r))
      .sort((a, b) => Math.abs(b.r) - Math.abs(a.r))
      .slice(0, 8);
    say(`\n  WEAK SIGNAL — correlation only. Says what it moves with, NOT what it is.`);
    say(`  Never record any of these in DATA_DICTIONARY.md as a meaning.`);
    for (const c of corr) say(`     r=${c.r >= 0 ? ' ' : ''}${c.r.toFixed(3)}   ${c.k}`);
    say('');
  }

  writeFileSync('reverse-engineer.txt', L.join('\n'));
  say('\n✅ Wrote reverse-engineer.txt to the project root.');
}

main().catch((e) => { console.error(e); process.exit(1); });
