/**
 * HUB INVESTIGATION — READ ONLY
 *
 * The first end-to-end implementation of the analysis method in
 * ASSISTANT_DESIGN.md §2. Answers questions of the shape:
 *
 *   "Why is <hub> higher on faltantes armador than the others?"
 *
 * The method, and the reason it is not just a top-N list:
 *
 *   1. DECOMPOSE   the aggregate into components
 *   2. NORMALISE   against peer hubs, per unit of volume
 *   3. DISCARD     ⭐ anything that does not DISCRIMINATE — a component that is
 *                  large everywhere explains nothing about why THIS hub differs
 *   4. ISOLATE     what remains that is specific to this hub
 *   5. REACH       into other weekly files for candidate explanations
 *   6. PROPOSE     a cause, hedged, with the confidence axes named
 *
 * Step 3 is the whole point. "Papa blanca is your biggest merma line" is true
 * at every hub and therefore worthless. Every candidate below is tested for
 * whether it actually moves the gap.
 *
 * Run from the project root:
 *   npx tsx scripts/investigate-hub.ts                 # defaults to mh_contry
 *   npx tsx scripts/investigate-hub.ts mh_cumbres 12   # hub, lookback weeks
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

const TARGET_HUB = process.argv[2] ?? 'mh_contry';
const LOOKBACK = Number(process.argv[3] ?? 12);
const PAGE = 1000;

/** Role accounts (auxiliares, coordinadores) — OPS_CONTEXT.md §2. */
const ROLE_PAT = /auxiliar|\baux\b|coordinad|\bl[ií]der\b|turno|inventari|calidad|recib|recepci/i;

/**
 * `desempeno_operadores.assembler` and `faltantes_armador.Armador` both carry
 * `Nombre Completo ("Apodo")`. Strip the parenthetical so the two files join.
 * (The failure to do this is why the incidentes cross-file test matched 0/2845
 * in reverse-engineer.ts — see DATA_DICTIONARY.md.)
 */
const stripNick = (s: string) => s.replace(/\s*\(\s*["“].*?["”]\s*\)\s*$/, '').trim();
const normPerson = (s: string) =>
  stripNick(String(s ?? ''))
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();

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
const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '—');
const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');

/** Spearman rank correlation across hubs — small n, so ranks not values. */
function spearman(pairs: [number, number][]): number {
  const n = pairs.length;
  if (n < 4) return NaN;
  const rank = (vals: number[]) => {
    const idx = vals.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n).fill(0);
    idx.forEach(([, i], k) => { r[i] = k + 1; });
    return r;
  };
  const ra = rank(pairs.map((p) => p[0]));
  const rb = rank(pairs.map((p) => p[1]));
  const d2 = ra.reduce((s, v, i) => s + (v - rb[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

interface Ev { hub: string; week: string; producto: string; armador: string; inv: number; nota: string; }

async function main() {
  const L: string[] = [];
  const say = (s = '') => { L.push(s); console.log(s); };

  const uploads = (await fetchAll<any>('uploads', 'id, app_id, week_start, status'))
    .filter((u) => u.status === 'validated');
  const weekById = new Map(uploads.map((u: any) => [u.id, u.week_start]));
  const allWeeks = [...new Set(uploads.map((u: any) => u.week_start))].sort();
  const weeks = allWeeks.slice(-LOOKBACK);
  const inWindow = (id: string) => weeks.includes(weekById.get(id) ?? '');
  const ids = (app: string) => uploads.filter((u: any) => u.app_id === app && inWindow(u.id)).map((u: any) => u.id);

  say('='.repeat(78));
  say(`HUB INVESTIGATION — ${TARGET_HUB}`);
  say(`Question: why is faltantes armador higher here than at peer hubs?`);
  say(`Window: ${weeks[0]} → ${weeks[weeks.length - 1]} (${weeks.length} weeks)`);
  say('='.repeat(78));

  // ---- load ---------------------------------------------------------------
  const fRows = await fetchAll<any>('upload_rows', 'upload_id, data', (q) => q.in('upload_id', ids('faltantes_armador')));
  const oRows = await fetchAll<any>('upload_rows', 'upload_id, data',
    (q) => q.in('upload_id', ids('desempeno_operadores')).eq('is_excluded', false));

  const events: Ev[] = [];
  for (const r of fRows) {
    const d = r.data ?? {};
    const hub = resolveHubId(String(d['Hub'] ?? '').trim());
    if (!hub) continue;
    events.push({
      hub, week: weekById.get(r.upload_id) ?? '',
      producto: String(d['Producto'] ?? '').trim(),
      armador: normPerson(d['Armador']),
      inv: toNum(d['Inventario disponible']),
      nota: String(d['Notas armador'] ?? '').trim(),
    });
  }

  /** Per-hub volume + workforce facts from the armador file. */
  interface HubFacts {
    assembled: number; rows: number; people: Set<string>;
    absences: number; absencesJust: number; idleDays: number;
    skuRateSum: number; skuRateN: number;
    roleAssembled: number; declaredFA: number;
  }
  const hubs = new Map<string, HubFacts>();
  const perPerson = new Map<string, { hub: string; assembled: number; declaredFA: number; isRole: boolean }>();

  for (const r of oRows) {
    const d = r.data ?? {};
    const hub = resolveHubId(String(d['geofence'] ?? '').trim());
    if (!hub) continue;
    const h = hubs.get(hub) ?? {
      assembled: 0, rows: 0, people: new Set<string>(), absences: 0, absencesJust: 0,
      idleDays: 0, skuRateSum: 0, skuRateN: 0, roleAssembled: 0, declaredFA: 0,
    };
    const raw = String(d['assembler'] ?? '');
    const person = normPerson(raw);
    const isRole = ROLE_PAT.test(raw);
    const asm = toNum(d['num_assembled']);
    const fa = toNum(d['num_orders_with_faltante_armador']);

    h.rows++;
    if (Number.isFinite(asm)) { h.assembled += asm; if (isRole) h.roleAssembled += asm; }
    if (Number.isFinite(fa)) h.declaredFA += fa;
    if (person) h.people.add(person);
    const ab = toNum(d['num_absences']); if (Number.isFinite(ab)) h.absences += ab;
    const abj = toNum(d['num_absences_including_justified']); if (Number.isFinite(abj)) h.absencesJust += abj;
    const idl = toNum(d['num_idle_days']); if (Number.isFinite(idl)) h.idleDays += idl;
    const rate = toNum(d['num_skus_per_hour_assembly_rate']);
    if (Number.isFinite(rate)) { h.skuRateSum += rate; h.skuRateN++; }
    hubs.set(hub, h);

    if (person) {
      const p = perPerson.get(`${hub}|${person}`) ?? { hub, assembled: 0, declaredFA: 0, isRole };
      if (Number.isFinite(asm)) p.assembled += asm;
      if (Number.isFinite(fa)) p.declaredFA += fa;
      perPerson.set(`${hub}|${person}`, p);
    }
  }

  const hubList = [...hubs.keys()].sort();
  const rate1k = (h: string) => {
    const f = hubs.get(h); if (!f || f.assembled === 0) return NaN;
    return (events.filter((e) => e.hub === h).length / f.assembled) * 1000;
  };

  // =========================================================================
  say('\n\n' + '─'.repeat(78));
  say('1 · IS THE PREMISE TRUE?   faltante events per 1,000 orders assembled');
  say('─'.repeat(78));
  say('  Raw counts favour big hubs. This does not.\n');
  const ranked = hubList.map((h) => ({ h, r: rate1k(h) })).sort((a, b) => (b.r || 0) - (a.r || 0));
  say(`  ${'hub'.padEnd(18)} ${'events'.padStart(7)} ${'assembled'.padStart(10)} ${'per 1k'.padStart(8)}`);
  for (const { h, r } of ranked) {
    const n = events.filter((e) => e.hub === h).length;
    const mark = h === TARGET_HUB ? '  ← target' : '';
    say(`  ${h.padEnd(18)} ${String(n).padStart(7)} ${String(hubs.get(h)!.assembled).padStart(10)} ${f1(r).padStart(8)}${mark}`);
  }
  const targetRate = rate1k(TARGET_HUB);
  const peers = hubList.filter((h) => h !== TARGET_HUB);
  const peerRates = peers.map(rate1k).filter(Number.isFinite);
  const peerMean = peerRates.reduce((a, b) => a + b, 0) / (peerRates.length || 1);
  const GAP = targetRate - peerMean;
  say('');
  say(`  ${TARGET_HUB} = ${f1(targetRate)} per 1k · peer mean = ${f1(peerMean)} · GAP = ${GAP >= 0 ? '+' : ''}${f1(GAP)}`);
  if (!(GAP > 0)) say(`  ⚠ ${TARGET_HUB} is NOT above the peer mean in this window. The premise does not hold —\n    everything below is explaining a gap that may not exist.`);
  say('\n  ⭐ THE GAP IS THE THING TO EXPLAIN. Every candidate below is judged on whether');
  say('     it moves this number, not on how big it is.');

  // =========================================================================
  say('\n\n' + '─'.repeat(78));
  say('2 · CANDIDATE A — stock availability   (does the inventory split explain it?)');
  say('─'.repeat(78));
  say('  `Inventario disponible` = system stock at the moment of the report (CONFIRMED).');
  say('  = 0 → genuine stockout, not the armador. > 0 → stock was believed present.\n');
  say(`  ${'hub'.padEnd(18)} ${'n'.padStart(6)} ${'inv=0'.padStart(7)} ${'inv>0'.padStart(7)} ${'inv<0'.padStart(6)} ${'rate1k (inv>0 only)'.padStart(20)}`);
  const adjRate = new Map<string, number>();
  for (const { h } of ranked) {
    const ev = events.filter((e) => e.hub === h);
    const z = ev.filter((e) => e.inv === 0).length;
    const p = ev.filter((e) => e.inv > 0).length;
    const n = ev.filter((e) => e.inv < 0).length;
    const adj = (p / (hubs.get(h)!.assembled || 1)) * 1000;
    adjRate.set(h, adj);
    say(`  ${h.padEnd(18)} ${String(ev.length).padStart(6)} ${pct(z, ev.length).padStart(7)} ${pct(p, ev.length).padStart(7)} ${String(n).padStart(6)} ${f1(adj).padStart(20)}`);
  }
  const adjPeerMean = peers.map((h) => adjRate.get(h)!).filter(Number.isFinite).reduce((a, b) => a + b, 0) / (peers.length || 1);
  const adjGap = adjRate.get(TARGET_HUB)! - adjPeerMean;
  say('');
  say(`  Gap on ALL events:        ${GAP >= 0 ? '+' : ''}${f1(GAP)} per 1k`);
  say(`  Gap on inv>0 events only: ${adjGap >= 0 ? '+' : ''}${f1(adjGap)} per 1k`);
  const closed = GAP !== 0 ? (1 - adjGap / GAP) * 100 : NaN;
  say(`  → removing genuine stockouts closes ${f1(closed)}% of the gap`);
  say('');
  const stockDiscriminates = !(Math.abs(adjGap) > Math.abs(GAP) * 0.8);
  say(stockDiscriminates
    ? '  ✅ DISCRIMINATES — a real part of the gap is genuine stockouts, not operations.'
    : '  ❌ DOES NOT DISCRIMINATE — the gap survives. Stockouts are not the story.');

  // =========================================================================
  say('\n\n' + '─'.repeat(78));
  say('3 · CANDIDATE B — product mix   (which products are SPECIFIC to this hub?)');
  say('─'.repeat(78));
  say('  ⭐ A product that is big everywhere explains nothing. Only products that are');
  say('     over-represented HERE relative to peers can explain the gap.\n');
  const tEvents = events.filter((e) => e.hub === TARGET_HUB);
  const prodT = new Map<string, number>();
  for (const e of tEvents) prodT.set(e.producto, (prodT.get(e.producto) ?? 0) + 1);
  const peerTotal = events.filter((e) => e.hub !== TARGET_HUB).length;
  const rows = [...prodT.entries()].map(([p, n]) => {
    const peerN = events.filter((e) => e.hub !== TARGET_HUB && e.producto === p).length;
    const shareT = n / (tEvents.length || 1);
    const shareP = peerN / (peerTotal || 1);
    return { p, n, peerN, shareT, shareP, lift: shareP > 0 ? shareT / shareP : Infinity };
  }).sort((a, b) => b.n - a.n);

  say(`  ${'product'.padEnd(38)} ${'here'.padStart(5)} ${'peers'.padStart(6)} ${'share'.padStart(7)} ${'peer'.padStart(7)} ${'lift'.padStart(7)}`);
  for (const r of rows.slice(0, 15)) {
    const flag = r.lift >= 2 ? '  ← specific' : r.lift <= 0.5 ? '  (under)' : '';
    say(`  ${r.p.slice(0, 37).padEnd(38)} ${String(r.n).padStart(5)} ${String(r.peerN).padStart(6)} ${(r.shareT * 100).toFixed(1).padStart(6)}% ${(r.shareP * 100).toFixed(1).padStart(6)}% ${(Number.isFinite(r.lift) ? r.lift.toFixed(1) : '∞').padStart(7)}${flag}`);
  }
  const discriminating = rows.filter((r) => r.n >= 5 && r.lift >= 2);
  say('');
  say(`  Products ≥5 events here AND ≥2× peer share: ${discriminating.length}`);
  if (discriminating.length) {
    const share = discriminating.reduce((s, r) => s + r.n, 0) / (tEvents.length || 1);
    say(`  They account for ${(share * 100).toFixed(1)}% of this hub's faltantes.`);
    say('  ✅ DISCRIMINATES — these are hub-specific and worth naming:');
    for (const r of discriminating.slice(0, 10)) say(`     ${r.p.slice(0, 50)}  (${r.n} here vs ${r.peerN} across ${peers.length} peers)`);
  } else {
    say('  ❌ DOES NOT DISCRIMINATE — no product is meaningfully over-represented here.');
    say('     The faltantes are spread across the same catalogue as everywhere else.');
  }

  // =========================================================================
  say('\n\n' + '─'.repeat(78));
  say('4 · CANDIDATE C — is it concentrated in PEOPLE?');
  say('─'.repeat(78));
  say('  Using the armador file\'s own declared count (num_orders_with_faltante_armador),');
  say('  which is ORDERS-with-a-faltante ÷ orders assembled — a true rate per person.\n');
  const persons = [...perPerson.values()].filter((p) => p.assembled >= 50);
  const byHubShare = new Map<string, number>();
  for (const h of hubList) {
    const hp = persons.filter((p) => p.hub === h).sort((a, b) => (b.declaredFA / b.assembled) - (a.declaredFA / a.assembled));
    if (hp.length < 3) continue;
    const totalFA = hp.reduce((s, p) => s + p.declaredFA, 0);
    const top3 = hp.slice(0, 3).reduce((s, p) => s + p.declaredFA, 0);
    byHubShare.set(h, totalFA > 0 ? top3 / totalFA : NaN);
  }
  say(`  ${'hub'.padEnd(18)} ${'people'.padStart(7)} ${'hub rate'.padStart(9)} ${'top-3 share of FA'.padStart(18)}`);
  for (const { h } of ranked) {
    const hp = persons.filter((p) => p.hub === h);
    const asm = hp.reduce((s, p) => s + p.assembled, 0);
    const fa = hp.reduce((s, p) => s + p.declaredFA, 0);
    say(`  ${h.padEnd(18)} ${String(hp.length).padStart(7)} ${pct(fa, asm).padStart(9)} ${(byHubShare.has(h) ? (byHubShare.get(h)! * 100).toFixed(0) + '%' : '—').padStart(18)}`);
  }
  say('');
  say(`  Worst individual rates at ${TARGET_HUB} (≥50 orders assembled):`);
  const tp = persons.filter((p) => p.hub === TARGET_HUB).sort((a, b) => (b.declaredFA / b.assembled) - (a.declaredFA / a.assembled));
  const tpMedian = tp.length ? tp[Math.floor(tp.length / 2)] : null;
  for (const p of tp.slice(0, 8)) {
    const key = [...perPerson.entries()].find(([, v]) => v === p)?.[0] ?? '';
    const name = key.split('|')[1] ?? '';
    say(`     ${name.slice(0, 44).padEnd(46)} ${String(p.declaredFA).padStart(4)} / ${String(p.assembled).padStart(5)} = ${pct(p.declaredFA, p.assembled).padStart(6)}${p.isRole ? '   [role account]' : ''}`);
  }
  if (tpMedian) say(`     median at this hub: ${pct(tpMedian.declaredFA, tpMedian.assembled)}`);
  const conc = byHubShare.get(TARGET_HUB);
  const peerConc = peers.map((h) => byHubShare.get(h)).filter((v): v is number => Number.isFinite(v ?? NaN));
  const peerConcMean = peerConc.reduce((a, b) => a + b, 0) / (peerConc.length || 1);
  say('');
  if (Number.isFinite(conc ?? NaN)) {
    say(`  Top-3 share here ${(conc! * 100).toFixed(0)}% vs peer mean ${(peerConcMean * 100).toFixed(0)}%`);
    say(conc! > peerConcMean * 1.2
      ? '  ✅ DISCRIMINATES — more concentrated in a few people here than elsewhere.\n     A person problem, not a hub problem.'
      : '  ❌ DOES NOT DISCRIMINATE — spread across the workforce much like peer hubs.\n     A hub/process problem, not a few individuals.');
  }

  // =========================================================================
  say('\n\n' + '─'.repeat(78));
  say('5 · CANDIDATE D — cross-file factors   (does anything else track the gap?)');
  say('─'.repeat(78));
  say('  For each factor: the hub value, and whether it rank-correlates with the');
  say('  faltantes rate ACROSS ALL HUBS. A factor that does not correlate cannot');
  say('  explain why one hub differs, however bad its own value looks.\n');

  const factors: { name: string; get: (h: string) => number; note?: string }[] = [
    { name: 'orders per armador', get: (h) => hubs.get(h)!.assembled / (hubs.get(h)!.people.size || 1) },
    { name: 'tasa_armado (mean SKU/hr)', get: (h) => hubs.get(h)!.skuRateSum / (hubs.get(h)!.skuRateN || 1) },
    { name: 'unjustified absences /person-wk', get: (h) => hubs.get(h)!.absences / (hubs.get(h)!.rows || 1) },
    { name: 'idle days /person-wk', get: (h) => hubs.get(h)!.idleDays / (hubs.get(h)!.rows || 1), note: '⚠ num_idle_days is OPEN — meaning unknown' },
    { name: 'role-account share of assembly', get: (h) => hubs.get(h)!.roleAssembled / (hubs.get(h)!.assembled || 1) },
    { name: 'workforce size', get: (h) => hubs.get(h)!.people.size },
  ];

  interface FactorResult { name: string; tv: number; pm: number; rho: number; discriminates: boolean; openMeaning: boolean; get: (h: string) => number; }
  const factorResults: FactorResult[] = [];

  say(`  ${'factor'.padEnd(32)} ${TARGET_HUB.slice(0, 10).padStart(10)} ${'peer mean'.padStart(10)} ${'rank corr'.padStart(10)}  verdict`);
  for (const f of factors) {
    const tv = f.get(TARGET_HUB);
    const pv = peers.map(f.get).filter(Number.isFinite);
    const pm = pv.reduce((a, b) => a + b, 0) / (pv.length || 1);
    const rho = spearman(hubList.map((h) => [f.get(h), rate1k(h)] as [number, number]));
    const strong = Math.abs(rho) >= 0.6;
    const outlier = Math.abs(tv - pm) > Math.abs(pm) * 0.2;
    const discriminates = strong && outlier;
    const verdict = discriminates ? '✅ DISCRIMINATES'
      : strong ? '🔶 correlates, but this hub is not an outlier'
      : outlier ? '❌ outlier here, but no cross-hub relationship'
      : '❌ neither';
    say(`  ${f.name.padEnd(32)} ${f2(tv).padStart(10)} ${f2(pm).padStart(10)} ${f2(rho).padStart(10)}  ${verdict}`);
    if (f.note) say(`     ${f.note}`);
    factorResults.push({ name: f.name, tv, pm, rho, discriminates, openMeaning: !!f.note, get: f.get });
  }
  say('');
  say('  ⚠ 7 hubs = 7 data points. A rank correlation on n=7 is a LEAD, never proof.');

  // =========================================================================
  say('\n\n' + '─'.repeat(78));
  say('6 · WHAT THE ARMADORES THEMSELVES WROTE');
  say('─'.repeat(78));
  say('  `Notas armador` is free text typed by the armador (CONFIRMED). Raw counts,');
  say('  normalised only for case/accents. NO taxonomy applied — the official one');
  say('  (Error del armador / de inventario / del sistema) lives in the #hub_fa');
  say('  Slack thread, which we do not ingest.\n');
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const noteT = new Map<string, number>();
  for (const e of tEvents) { const k = norm(e.nota); if (k) noteT.set(k, (noteT.get(k) ?? 0) + 1); }
  const notesSorted = [...noteT.entries()].sort((a, b) => b[1] - a[1]);
  say(`  ${TARGET_HUB}: ${notesSorted.length} distinct notes over ${tEvents.length} events`);
  say(`  ${'note'.padEnd(44)} ${'here'.padStart(6)} ${'peer share'.padStart(11)} ${'lift'.padStart(6)}`);
  const specificNotes: { note: string; here: number; lift: number }[] = [];
  for (const [n, c] of notesSorted.slice(0, 15)) {
    const peerN = events.filter((e) => e.hub !== TARGET_HUB && norm(e.nota) === n).length;
    const shareT = c / (tEvents.length || 1);
    const shareP = peerN / (peerTotal || 1);
    const lift = shareP > 0 ? shareT / shareP : Infinity;
    const isSpecific = lift >= 2 && c >= 5;
    const flag = isSpecific ? '  ← specific' : '';
    if (isSpecific) specificNotes.push({ note: n, here: c, lift });
    say(`  ${n.slice(0, 43).padEnd(44)} ${String(c).padStart(6)} ${(shareP * 100).toFixed(1).padStart(10)}% ${(Number.isFinite(lift) ? lift.toFixed(1) : '∞').padStart(6)}${flag}`);
  }

  // =========================================================================
  say('\n\n' + '='.repeat(78));
  say('7 · CONFIDENCE — ASSISTANT_DESIGN.md §3');
  say('='.repeat(78));
  say('  Overall confidence = the WEAKEST axis. Never the average.\n');
  const invNull = tEvents.filter((e) => !Number.isFinite(e.inv)).length;
  say(`  COVERAGE     ✅  ${tEvents.length} events at ${TARGET_HUB}, ${weeks.length} weeks.`);
  say(`                   Inventario disponible missing on ${invNull} (${pct(invNull, tEvents.length)}).`);
  say(`  MEANING      ✅  Inventario disponible, Notas armador, num_assembled — all CONFIRMED.`);
  say(`               🔶  num_idle_days is OPEN. Any conclusion using it is unfounded.`);
  say(`  STATISTICAL  🔶  7 hubs. Rank correlations are leads, not evidence.`);
  say(`  CAUSAL       🔶  Nothing here traces a MECHANISM. Discrimination narrows the`);
  say(`                   field; it does not prove causation.`);
  say('');
  say('  ⚠ NOT VISIBLE TO THIS ANALYSIS, and each could change the answer:');
  say('    · The #hub_fa Slack thread — official root cause per event, and the aux');
  say('      verification. The only place "error del armador vs de inventario vs del');
  say('      sistema" is actually recorded.');
  say('    · Whether the armador consulted the aux before marking (never recorded).');
  say('    · MNA-flagged stock — Inventario can be >0 yet genuinely unavailable.');
  say('    · Express orders jumping the queue; marketplace orders absent entirely.');
  say('    · Daily patterns — the Mon/Tue/Sun aux rota is invisible at weekly grain.');

  // =========================================================================
  // 8 · SYNTHESIS — composed from the verdicts above, in code, not narrated.
  //
  // DATA_DICTIONARY.md "What an output should be": Finding + Evidence +
  // Suggested action, all three. This is a deterministic first pass at that —
  // template-filling over the ✅/❌ verdicts already computed, the same way
  // buildTextBundle() assembles finished sentences server-side rather than
  // letting a model narrate its own derivation (BUILD.md "Things NOT to do").
  // =========================================================================
  say('\n\n' + '='.repeat(78));
  say('8 · SYNTHESIS — finding + evidence + suggested action');
  say('='.repeat(78));

  const finding: string[] = [];
  finding.push(
    `${TARGET_HUB}'s faltante rate is ${f1(GAP)} per 1k orders above the peer mean ` +
    `(${f1(targetRate)} vs ${f1(peerMean)}) — a real gap, normalised for hub size, not a raw-count artifact.`
  );

  if (Number.isFinite(closed)) {
    finding.push(
      stockDiscriminates && closed >= 80
        ? `Almost all of it is genuine stockouts (Inventario disponible = 0) — this reads as a supply problem, not an operations one.`
        : `Genuine stockouts explain ${f1(closed)}% of the gap; the remaining ${f1(100 - closed)}% survives even after removing them, so this is not purely a supply-side problem.`
    );
  }

  if (Number.isFinite(conc ?? NaN)) {
    finding.push(
      conc! > peerConcMean * 1.2
        ? `It IS concentrated in a few people (top-3 share ${(conc! * 100).toFixed(0)}% vs peer ${(peerConcMean * 100).toFixed(0)}%) — points at specific armadores, not the hub as a whole.`
        : `It is NOT concentrated in a few people (top-3 share ${(conc! * 100).toFixed(0)}% vs peer ${(peerConcMean * 100).toFixed(0)}%) — rules out "a few bad armadores"; whatever this is, it's hub-wide.`
    );
  }

  if (discriminating.length) {
    const share = discriminating.reduce((s, r) => s + r.n, 0) / (tEvents.length || 1);
    finding.push(
      `${discriminating.length} products are specifically over-represented here (${(share * 100).toFixed(1)}% of this hub's faltantes) — led by ${discriminating.slice(0, 3).map((r) => r.p).join(', ')}.`
    );
  }

  const topFactors = factorResults.filter((f) => f.discriminates).sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
  for (const tf of topFactors.slice(0, 2)) {
    finding.push(
      `Cross-hub, "${tf.name}" discriminates (${TARGET_HUB} ${f2(tf.tv)} vs peer ${f2(tf.pm)}, rank-correlation ${f2(tf.rho)}) — ` +
      (tf.openMeaning ? `a LEAD only (n=7 hubs), and it touches an OPEN column — see §7.` : `a lead, not proof (n=7 hubs).`)
    );
  }

  // Most hub-SPECIFIC note (highest lift), not merely highest-volume — a
  // note that's common everywhere isn't evidence about this hub. Reused by
  // both FINDING and SUGGESTED ACTION below so they never cite different notes.
  const topByLift = specificNotes.length ? [...specificNotes].sort((a, b) => b.lift - a.lift)[0] : null;
  if (topByLift) {
    finding.push(
      `The note "${topByLift.note}" appears ${topByLift.here} times here — ` +
      (Number.isFinite(topByLift.lift) ? `${topByLift.lift.toFixed(1)}× the peer share` : `not seen at any peer hub at all`) +
      `. Free text, no official taxonomy applied (that lives in the #hub_fa Slack thread, not ingested — §7).`
    );
  }

  say('\n  FINDING');
  for (const p of finding) say(`    · ${p}`);

  // Suggested actions, tied 1:1 to what actually discriminated — never a
  // generic "investigate further". If nothing discriminated on an axis, no
  // action is proposed for it.
  const actions: string[] = [];
  if (Number.isFinite(conc ?? NaN) && !(conc! > peerConcMean * 1.2)) {
    actions.push(`Not a coaching problem for specific people — the elevated rate is spread across the whole floor.`);
  } else if (Number.isFinite(conc ?? NaN)) {
    actions.push(`Start with the top-3 armadores by declared faltante rate at this hub (see §4) — the concentration suggests individual coaching, not a hub-wide process fix.`);
  }
  const tasaFactor = topFactors.find((f) => f.name.includes('tasa_armado'));
  if (tasaFactor) {
    actions.push(`Check whether staffing/scheduling is keeping pace with order volume — assembly rate is the strongest below-peer number found (${f2(tasaFactor.tv)} vs ${f2(tasaFactor.pm)} SKU/hr), and "orders per armador" itself came back inconclusive, so headcount ratio alone doesn't explain it.`);
  }
  if (topByLift) {
    actions.push(
      `Look into "${topByLift.note}" at ${TARGET_HUB} specifically — it's the most hub-specific note found ` +
      `(${topByLift.here} events, ${Number.isFinite(topByLift.lift) ? `${topByLift.lift.toFixed(1)}× peer share` : 'absent at every peer hub'}), ` +
      `which points at whatever that phrase describes as a pattern local to this hub, not network-wide noise.`
    );
  }
  if (discriminating.length) {
    actions.push(`Flag the hub-specific products above to whoever owns stocking/exhibition capacity here — a stocking-pattern issue, not a network-wide catalog one.`);
  }

  say('\n  SUGGESTED ACTION  (hedged — Causal confidence is 🔶, see §7; José decides, this is input not a directive)');
  if (actions.length) {
    for (const a of actions) say(`    · ${a}`);
  } else {
    say(`    · Nothing here discriminated strongly enough to propose an action. The gap is real (§1) but this pass didn't isolate why.`);
  }

  // Surface any candidate whose result runs opposite to a documented
  // hypothesis, rather than quietly dropping it — "silence about an
  // assumption is the failure mode" (ASSISTANT_DESIGN.md §7, item 3).
  const auxFactor = factorResults.find((f) => f.name.includes('role-account'));
  if (auxFactor?.discriminates && auxFactor.rho < 0 && auxFactor.tv < auxFactor.pm) {
    // Check the two specific claims against the actual per-hub data rather
    // than assuming TARGET_HUB is the extreme on either axis — it usually
    // isn't (e.g. mh_cumbres is 4th of 7 on faltantes rate, not 1st).
    const isTopFaltanteRate = ranked[0]?.h === TARGET_HUB;
    const auxValsByHub = hubList.map((h) => ({ h, v: auxFactor.get(h) })).sort((a, b) => a.v - b.v);
    const isLowestAux = auxValsByHub[0]?.h === TARGET_HUB;
    say('\n  ⚠ CONTRADICTS A DOCUMENTED HYPOTHESIS');
    say(`    OPS_CONTEXT.md §2 predicts more aux time on assembly → less on inventory → MORE faltantes.`);
    say(`    Here the correlation runs the OTHER way (ρ=${f2(auxFactor.rho)}): hubs where aux assemble MORE tend`);
    say(`    to have FEWER faltantes. ${TARGET_HUB} is ` +
      `${isTopFaltanteRate ? 'the highest-faltante-rate hub in this window' : `ranked ${ranked.findIndex((r) => r.h === TARGET_HUB) + 1} of ${ranked.length} on faltante rate`}` +
      ` and ${isLowestAux ? 'has the LOWEST aux-assembly share of any hub' : `is ${auxValsByHub.findIndex((r) => r.h === TARGET_HUB) + 1} of ${auxValsByHub.length} lowest on aux-assembly share`}.`);
    say(`    Either the flex-chain hypothesis needs revising, or something else is compensating at the`);
    say(`    hubs with higher aux-assembly share. Not resolved by this data alone.`);
  }

  writeFileSync('investigate-hub.txt', L.join('\n'));
  say('\n✅ Wrote investigate-hub.txt to the project root.');
}

main().catch((e) => { console.error(e); process.exit(1); });
