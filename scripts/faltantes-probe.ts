/**
 * FALTANTES PROBE — READ ONLY
 *
 * A hand-built version of the answer we want the chatbox to produce on its own.
 * It reads the RAW event rows (upload_rows), not the aggregated KPI snapshots,
 * and answers:
 *
 *   "Where is faltantes armador worst, and WHY is each hub's mix different?"
 *
 * Two outputs:
 *   faltantes-probe.txt  — the analysis (this is the "chatbox answer" mock-up)
 *   faltantes-vocab.txt  — every distinct value of the columns that matter,
 *                          with counts, so we can agree on what they MEAN
 *                          before anything is built on top of them.
 *
 * The vocab file is the more important of the two. Read it and tell me which
 * cause buckets are wrong and what the real operational categories are.
 *
 * Run from the project root:
 *   npx tsx scripts/faltantes-probe.ts
 *   npx tsx scripts/faltantes-probe.ts 12      # look back 12 weeks instead of 8
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

const LOOKBACK_WEEKS = Number(process.argv[2] ?? 8);
const PAGE = 1000;

// ---------------------------------------------------------------------------
// THE PART YOU SHOULD EDIT
//
// This is my guess at what the armadores mean when they type a note. It is a
// guess — I built it from the 8 most frequent strings. Order matters: the
// first rule that matches wins. Anything unmatched lands in `otro` and gets
// printed in full at the bottom of the report so we can see what we missed.
// ---------------------------------------------------------------------------
const CAUSE_RULES: [string, RegExp][] = [
  ['sin_stock',        /agotad|sin stock|0 en stock|cero en stock|no hay|sin existenc|se acab|no queda|out of stock/],
  ['merma',            /merma|mal estado|hongo|podrid|madur|golpead|caduc|descompuest|mal olor|echad|maltratad/],
  ['error_inventario', /error de inventario|error inventario|inventario (incorrect|erroneo|mal)|no coincide|mal inventario|diferencia de inventario/],
  ['no_localizado',    /no localizad|no se encontr|no encontr|no aparec|no lo encuentr|no estaba|no se ve/],
  ['error_recepcion',  /recepcion|no lleg|no se recibi|nunca lleg|falto en recep|no vino|no surtier/],
  ['dato_captura',     /codigo|barras|scane|escane|captur|etiquet/],
  ['proveedor',        /proveedor/],
];

function normalize(s: string): string {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip accents
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!¡?¿"']+$/g, '')
    .trim();
}

function classifyNote(raw: unknown): string {
  const n = normalize(String(raw ?? ''));
  if (!n) return '(sin nota)';
  for (const [label, re] of CAUSE_RULES) if (re.test(n)) return label;
  return 'otro';
}

// ---------------------------------------------------------------------------
// plumbing
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

const pct = (n: number, d: number) => (d === 0 ? '  –  ' : `${((n / d) * 100).toFixed(1)}%`.padStart(6));
const bar = (frac: number, w = 22) => '█'.repeat(Math.round(frac * w)).padEnd(w, '·');

function tally<T>(rows: T[], key: (r: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) { const k = key(r); m.set(k, (m.get(k) ?? 0) + 1); }
  return new Map([...m.entries()].sort((a, b) => b[1] - a[1]));
}

const toNum = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : NaN; }
  return NaN;
};

// ---------------------------------------------------------------------------
interface Ev {
  hub: string; hubRaw: string; ciudad: string; week: string;
  producto: string; itemId: string; armador: string; fecha: string;
  inv: number; invRaw: unknown; nota: string; cause: string;
}

async function main() {
  const L: string[] = [];
  const say = (s = '') => { L.push(s); console.log(s); };

  // ---- which weeks -------------------------------------------------------
  const uploads = await fetchAll<any>('uploads', 'id, app_id, week_start, hub_id, city, status');
  const validated = uploads.filter((u) => u.status === 'validated');
  const allWeeks = [...new Set(validated.map((u) => u.week_start))].sort();
  const weeks = allWeeks.slice(-LOOKBACK_WEEKS);
  if (!weeks.length) { console.error('No validated uploads found.'); process.exit(1); }

  say('='.repeat(78));
  say('FALTANTES ARMADOR — RAW EVENT ANALYSIS');
  say(`Weeks: ${weeks[0]} → ${weeks[weeks.length - 1]}  (${weeks.length} weeks)`);
  say('Source: upload_rows for faltantes_armador + desempeno_operadores');
  say('='.repeat(78));

  // ---- faltantes events --------------------------------------------------
  const fIds = validated.filter((u) => u.app_id === 'faltantes_armador' && weeks.includes(u.week_start));
  const fByUpload = new Map(fIds.map((u) => [u.id, u.week_start]));
  const fRows = await fetchAll<any>('upload_rows', 'upload_id, data', (q) => q.in('upload_id', [...fByUpload.keys()]));

  const events: Ev[] = [];
  let unresolvedHub = 0;
  for (const r of fRows) {
    const d = r.data ?? {};
    const hubRaw = String(d['Hub'] ?? '').trim();
    const hub = resolveHubId(hubRaw) ?? '';
    if (!hub) { unresolvedHub++; continue; }
    const nota = String(d['Notas armador'] ?? '');
    events.push({
      hub, hubRaw,
      ciudad: String(d['Ciudad'] ?? '').trim(),
      week: fByUpload.get(r.upload_id) ?? '',
      producto: String(d['Producto'] ?? '').trim(),
      itemId: String(d['Item ID'] ?? '').trim(),
      armador: String(d['Armador'] ?? '').trim(),
      fecha: String(d['Fecha'] ?? ''),
      inv: toNum(d['Inventario disponible']),
      invRaw: d['Inventario disponible'],
      nota,
      cause: classifyNote(nota),
    });
  }

  // ---- denominator: pedidos armados per hub ------------------------------
  const oIds = validated.filter((u) => u.app_id === 'desempeno_operadores' && weeks.includes(u.week_start)).map((u) => u.id);
  const oRows = await fetchAll<any>('upload_rows', 'data', (q) => q.in('upload_id', oIds).eq('is_excluded', false));
  const armadosByHub = new Map<string, number>();
  for (const r of oRows) {
    const hub = resolveHubId(String(r.data?.['geofence'] ?? '').trim());
    if (!hub) continue;
    const n = toNum(r.data?.['num_assembled']);
    if (Number.isFinite(n)) armadosByHub.set(hub, (armadosByHub.get(hub) ?? 0) + n);
  }

  say(`\nEvents loaded: ${events.length}  (${unresolvedHub} rows dropped — hub name did not resolve)`);
  say(`Pedidos armados in the same window: ${[...armadosByHub.values()].reduce((a, b) => a + b, 0).toLocaleString()}`);

  // =========================================================================
  // 1. RATE PER HUB
  // =========================================================================
  say('\n\n' + '─'.repeat(78));
  say('1 · HOW BAD, PER HUB');
  say('─'.repeat(78));
  say('Faltante events per 1,000 pedidos armados. Raw counts favour big hubs;');
  say('this does not.\n');

  const hubs = [...new Set(events.map((e) => e.hub))].sort();
  const rate = (h: string) => {
    const n = events.filter((e) => e.hub === h).length;
    const d = armadosByHub.get(h) ?? 0;
    return { hub: h, n, d, per1k: d > 0 ? (n / d) * 1000 : NaN };
  };
  const rates = hubs.map(rate).sort((a, b) => (b.per1k || 0) - (a.per1k || 0));
  const worstRate = Math.max(...rates.map((r) => r.per1k || 0));

  say('  hub                events   armados   per 1k');
  for (const r of rates) {
    const p = Number.isFinite(r.per1k) ? r.per1k.toFixed(1).padStart(6) : '     –';
    say(`  ${r.hub.padEnd(18)} ${String(r.n).padStart(6)} ${String(r.d).padStart(9)}   ${p}  ${bar((r.per1k || 0) / worstRate)}`);
  }

  // =========================================================================
  // 2. OUR FAULT OR NOT
  // =========================================================================
  say('\n\n' + '─'.repeat(78));
  say('2 · WAS THERE STOCK WHEN THE ARMADOR REPORTED IT MISSING?');
  say('─'.repeat(78));
  say('`Inventario disponible` at the moment of the faltante.');
  say('  = 0  → nothing to pick. Supply problem, not the armador.');
  say('  > 0  → system said stock existed. Pick failure, location, or bad inventory.');
  say('  < 0  → negative available inventory. Data question — see section 6.\n');

  say('  hub                  n     =0 (sin stock)   >0 (había stock)    <0     null');
  for (const h of rates.map((r) => r.hub)) {
    const ev = events.filter((e) => e.hub === h);
    const zero = ev.filter((e) => e.inv === 0).length;
    const pos = ev.filter((e) => e.inv > 0).length;
    const neg = ev.filter((e) => e.inv < 0).length;
    const nul = ev.filter((e) => !Number.isFinite(e.inv)).length;
    say(`  ${h.padEnd(18)} ${String(ev.length).padStart(5)}   ${pct(zero, ev.length)} ${bar(zero / (ev.length || 1), 10)}   ${pct(pos, ev.length)}   ${String(neg).padStart(4)}  ${String(nul).padStart(5)}`);
  }

  const gz = events.filter((e) => e.inv === 0).length;
  say(`\n  ALL HUBS           ${String(events.length).padStart(5)}   ${pct(gz, events.length)}`);

  // =========================================================================
  // 3. CAUSE MIX — the comparison
  // =========================================================================
  say('\n\n' + '─'.repeat(78));
  say('3 · WHY — CAUSE MIX PER HUB');
  say('─'.repeat(78));
  say('Buckets come from CAUSE_RULES at the top of this file. They are a guess.');
  say('Compare columns across hubs — the differences are the interesting part.\n');

  const causes = [...tally(events, (e) => e.cause).keys()];
  const head = causes.map((c) => c.slice(0, 11).padStart(12)).join('');
  say(`  hub              ${head}`);
  for (const h of rates.map((r) => r.hub)) {
    const ev = events.filter((e) => e.hub === h);
    const row = causes.map((c) => pct(ev.filter((e) => e.cause === c).length, ev.length).padStart(12)).join('');
    say(`  ${h.padEnd(16)}${row}`);
  }
  const allRow = causes.map((c) => pct(events.filter((e) => e.cause === c).length, events.length).padStart(12)).join('');
  say(`  ${'ALL'.padEnd(16)}${allRow}`);

  say('\n  Biggest deviations from the all-hub average:');
  const avg = new Map(causes.map((c) => [c, events.filter((e) => e.cause === c).length / events.length]));
  const devs: { hub: string; cause: string; d: number; share: number; n: number }[] = [];
  for (const h of hubs) {
    const ev = events.filter((e) => e.hub === h);
    if (ev.length < 30) continue;
    for (const c of causes) {
      const share = ev.filter((e) => e.cause === c).length / ev.length;
      devs.push({ hub: h, cause: c, d: share - (avg.get(c) ?? 0), share, n: ev.filter((e) => e.cause === c).length });
    }
  }
  devs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  for (const d of devs.slice(0, 10)) {
    const sign = d.d > 0 ? '+' : '−';
    say(`    ${d.hub.padEnd(17)} ${d.cause.padEnd(18)} ${(d.share * 100).toFixed(1).padStart(5)}%  (${sign}${Math.abs(d.d * 100).toFixed(1)} pts vs avg, n=${d.n})`);
  }

  // =========================================================================
  // 4. WHAT AND WHO
  // =========================================================================
  say('\n\n' + '─'.repeat(78));
  say('4 · CONCENTRATION — PRODUCTS AND PEOPLE');
  say('─'.repeat(78));

  const prodAll = tally(events, (e) => e.producto);
  const top20 = [...prodAll.entries()].slice(0, 20);
  const top20share = top20.reduce((a, [, n]) => a + n, 0) / events.length;
  say(`\n  ${prodAll.size} distinct products. Top 20 account for ${(top20share * 100).toFixed(1)}% of all faltantes.\n`);
  say('  product                                    n     sin stock   worst hub');
  for (const [p, n] of top20.slice(0, 12)) {
    const ev = events.filter((e) => e.producto === p);
    const z = ev.filter((e) => e.inv === 0).length;
    const byHub = tally(ev, (e) => e.hub);
    const worst = [...byHub.entries()][0];
    say(`  ${p.slice(0, 40).padEnd(42)}${String(n).padStart(4)}   ${pct(z, n)}     ${worst[0]} (${worst[1]})`);
  }

  say('\n  Armadores with the most events (raw count — not normalised by volume):');
  for (const [a, n] of [...tally(events, (e) => e.armador).entries()].slice(0, 8)) {
    const ev = events.filter((e) => e.armador === a);
    const z = ev.filter((e) => e.inv === 0).length;
    say(`    ${a.slice(0, 44).padEnd(46)} ${String(n).padStart(4)}   ${pct(z, n)} sin stock   ${ev[0]?.hub ?? ''}`);
  }

  // =========================================================================
  // 5. TREND
  // =========================================================================
  say('\n\n' + '─'.repeat(78));
  say('5 · IS IT MOVING? — per-week rate by hub');
  say('─'.repeat(78) + '\n');
  say(`  hub              ${weeks.map((w) => w.slice(5).padStart(8)).join('')}`);
  for (const h of rates.map((r) => r.hub)) {
    const cells = weeks.map((w) => {
      const n = events.filter((e) => e.hub === h && e.week === w).length;
      return String(n).padStart(8);
    }).join('');
    say(`  ${h.padEnd(16)}${cells}`);
  }
  say('\n  (raw event counts per week — divide by that week\'s volume for a fair read)');

  // =========================================================================
  // 6. DATA QUESTIONS
  // =========================================================================
  say('\n\n' + '─'.repeat(78));
  say('6 · THINGS I CANNOT INTERPRET WITHOUT YOU');
  say('─'.repeat(78));

  const negs = events.filter((e) => e.inv < 0);
  say(`\n  a) ${negs.length} events have NEGATIVE Inventario disponible (min ${Math.min(...negs.map((e) => e.inv))}).`);
  say('     Examples:');
  for (const e of negs.slice(0, 5)) say(`       ${e.hub}  ${e.producto.slice(0, 34).padEnd(36)} inv=${e.inv}  "${e.nota.trim().slice(0, 40)}"`);

  const nulls = events.filter((e) => !Number.isFinite(e.inv));
  say(`\n  b) ${nulls.length} events have no Inventario disponible at all.`);

  const otro = events.filter((e) => e.cause === 'otro');
  say(`\n  c) ${otro.length} notes (${pct(otro.length, events.length).trim()}) did not match any CAUSE_RULE.`);
  say('     These are what the taxonomy is missing — the top 30 distinct:');
  for (const [n, c] of [...tally(otro, (e) => normalize(e.nota)).entries()].slice(0, 30)) {
    say(`       ${String(c).padStart(4)}  ${n.slice(0, 62)}`);
  }

  const sinNota = events.filter((e) => e.cause === '(sin nota)').length;
  say(`\n  d) ${sinNota} events have no note at all (${pct(sinNota, events.length).trim()}).`);

  // ---- vocab file --------------------------------------------------------
  const V: string[] = [];
  V.push('FALTANTES ARMADOR — FULL VOCABULARY');
  V.push(`Weeks ${weeks[0]} → ${weeks[weeks.length - 1]} · ${events.length} events`);
  V.push('');
  V.push('This is every distinct value the columns actually take, with counts.');
  V.push('Read it and tell me what these mean operationally. That is the context');
  V.push('the app does not have and cannot guess.');
  V.push('');

  V.push('='.repeat(70));
  V.push('NOTAS ARMADOR — every distinct note, normalised, by frequency');
  V.push('Format:  count  [my guessed bucket]  note');
  V.push('='.repeat(70));
  for (const [n, c] of tally(events, (e) => normalize(e.nota)).entries()) {
    const bucket = classifyNote(n);
    V.push(`${String(c).padStart(5)}  [${bucket.padEnd(17)}]  ${n}`);
  }

  V.push('');
  V.push('='.repeat(70));
  V.push('INVENTARIO DISPONIBLE — value distribution');
  V.push('='.repeat(70));
  const invBuckets: [string, (n: number) => boolean][] = [
    ['negative', (n) => n < 0], ['exactly 0', (n) => n === 0], ['1', (n) => n === 1],
    ['2–5', (n) => n >= 2 && n <= 5], ['6–20', (n) => n > 5 && n <= 20],
    ['21–100', (n) => n > 20 && n <= 100], ['>100', (n) => n > 100],
  ];
  for (const [label, test] of invBuckets) {
    const n = events.filter((e) => Number.isFinite(e.inv) && test(e.inv)).length;
    V.push(`${label.padEnd(12)} ${String(n).padStart(6)}  ${pct(n, events.length)}`);
  }
  V.push(`${'null/blank'.padEnd(12)} ${String(nulls.length).padStart(6)}  ${pct(nulls.length, events.length)}`);

  V.push('');
  V.push('='.repeat(70));
  V.push('HUB — raw strings as they arrive (note the trailing spaces)');
  V.push('='.repeat(70));
  for (const [h, c] of tally(events, (e) => `"${e.hubRaw}"  →  ${e.hub}`).entries()) V.push(`${String(c).padStart(6)}  ${h}`);

  V.push('');
  V.push('='.repeat(70));
  V.push('CIUDAD');
  V.push('='.repeat(70));
  for (const [c, n] of tally(events, (e) => e.ciudad).entries()) V.push(`${String(n).padStart(6)}  ${c}`);

  V.push('');
  V.push('='.repeat(70));
  V.push(`PRODUCTO — all ${prodAll.size} distinct, by frequency`);
  V.push('='.repeat(70));
  for (const [p, n] of prodAll.entries()) V.push(`${String(n).padStart(5)}  ${p}`);

  writeFileSync('faltantes-probe.txt', L.join('\n'));
  writeFileSync('faltantes-vocab.txt', V.join('\n'));
  say('\n\n✅ Wrote faltantes-probe.txt and faltantes-vocab.txt to the project root.');
  say('   The vocab file is the one that matters — it is the raw material for the');
  say('   data dictionary. Send both back.');
}

main().catch((e) => { console.error(e); process.exit(1); });
