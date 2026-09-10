/**
 * ROLE ACCOUNT CENSUS — READ ONLY
 *
 * Auxiliares and coordinadores appear in the data under role-named accounts
 * ("Auxiliar Inventarios SN (\"AI\")") rather than personal names — but the
 * naming is NOT consistent across hubs, so a pattern built on one spelling
 * will silently miss others.
 *
 * This lists every distinct person in every name column, per hub, across the
 * FULL history, flagging which look role-named. Two purposes:
 *
 *   1. Answer "which role accounts exist at which hub" definitively.
 *   2. Produce the flex-intensity baseline — for each aux account, how much
 *      they actually assembled, week by week. That is the middle link of the
 *      absences → aux-pulled-in → MNA/faltantes chain (OPS_CONTEXT.md §2).
 *
 * Run from the project root:
 *   npx tsx scripts/role-accounts.ts
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

/**
 * Deliberately broad. Better to over-flag and eyeball the list than to build a
 * tight pattern on one hub's spelling and silently miss another's.
 * Note "recibo" and "calidad" are separate terms — José's hypothesis is that
 * "Auxiliar de Recibo y Calidad" gets shortened either way depending on hub.
 */
const ROLE_PAT = /auxiliar|\baux\b|coordinad|\bl[ií]der\b|turno|inventari|calidad|recib|recepci|\bcapacit|\bpract|\bsupervis/i;

/**
 * Expected auxiliar headcount per hub, EXCLUDING líderes de turno and the
 * coordinador (OPS_CONTEXT.md §2, confirmed by José).
 *
 * The role is NOT inferable from the account name — the FyV/receiving auxiliar
 * is called "recibo", "recepción", "calidad" or "recibo y calidad" depending on
 * the hub. So this census is a VALIDATION, not a discovery: more accounts than
 * expected means duplicate or stale logins, fewer means a hub shares one.
 */
const EXPECTED_AUX: Record<string, number> = {
  mh_zapopan: 3,
  mh_condesa: 3,
  mh_contry: 2,
  mh_cumbres: 2,
  mh_san_nicolas: 2,
  mh_guadalupe: 2,
  mh_avicola: 2,
};

/** Name columns worth censusing, per app. */
const NAME_COLS: [string, string][] = [
  ['desempeno_operadores', 'assembler'],
  ['faltantes_armador', 'Armador'],
  ['desempeno_repartidores', 'driver_name'],
  ['incidentes', 'Operador'],
  ['incidentes', 'Responsable'],
  ['discrepancia', 'Repartidor'],
];

/** Where the hub lives, per app. */
const HUB_COL: Record<string, string | null> = {
  desempeno_operadores: 'geofence',
  faltantes_armador: 'Hub',
  desempeno_repartidores: 'hub',
  incidentes: null,          // no hub column — resolved via name only
  discrepancia: 'Hub',
};

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

interface Person {
  name: string;
  hub: string;
  weeks: Set<string>;
  rows: number;
  assembled: number;      // desempeno_operadores only
  faltantes: number;      // desempeno_operadores only
  isRole: boolean;
}

async function main() {
  const L: string[] = [];
  const say = (s = '') => { L.push(s); console.log(s); };

  const uploads = (await fetchAll<any>('uploads', 'id, app_id, week_start, status'))
    .filter((u) => u.status === 'validated');
  const weekById = new Map(uploads.map((u: any) => [u.id, u.week_start]));
  const allWeeks = [...new Set(uploads.map((u: any) => u.week_start))].sort();

  say('='.repeat(78));
  say('ROLE ACCOUNT CENSUS');
  say(`Full history: ${allWeeks.length} weeks, ${allWeeks[0]} → ${allWeeks[allWeeks.length - 1]}`);
  say('='.repeat(78));

  for (const [appId, col] of NAME_COLS) {
    const ids = uploads.filter((u: any) => u.app_id === appId).map((u: any) => u.id);
    if (!ids.length) continue;
    const rows = await fetchAll<any>('upload_rows', 'upload_id, data', (q) => q.in('upload_id', ids));

    const people = new Map<string, Person>();
    const hubCol = HUB_COL[appId];

    for (const r of rows) {
      const d = r.data ?? {};
      const name = String(d[col] ?? '').trim();
      if (!name) continue;
      const week = weekById.get(r.upload_id) ?? '';
      const hubRaw = hubCol ? String(d[hubCol] ?? '').trim() : '';
      const hub = (hubCol ? resolveHubId(hubRaw) : null) ?? '(no hub col)';

      const key = `${name}||${hub}`;
      const p = people.get(key) ?? {
        name, hub, weeks: new Set<string>(), rows: 0, assembled: 0, faltantes: 0,
        isRole: ROLE_PAT.test(name),
      };
      p.rows++;
      if (week) p.weeks.add(week);
      if (appId === 'desempeno_operadores') {
        const a = toNum(d['num_assembled']); if (Number.isFinite(a)) p.assembled += a;
        const f = toNum(d['num_orders_with_faltante_armador']); if (Number.isFinite(f)) p.faltantes += f;
      }
      people.set(key, p);
    }

    const all = [...people.values()];
    const roles = all.filter((p) => p.isRole).sort((a, b) => a.hub.localeCompare(b.hub) || b.rows - a.rows);

    say('');
    say('─'.repeat(78));
    say(`${appId}.${col}`);
    say(`  ${all.length} distinct name×hub combinations · ${roles.length} look role-named`);
    say('─'.repeat(78));

    if (!roles.length) { say('  (no role-named accounts found)'); continue; }

    if (appId === 'desempeno_operadores') {
      say('');
      say(`  ${'hub'.padEnd(16)} ${'account'.padEnd(42)} ${'wks'.padStart(4)} ${'assembled'.padStart(10)} ${'faltantes'.padStart(10)}`);
      for (const p of roles) {
        say(`  ${p.hub.padEnd(16)} ${p.name.slice(0, 41).padEnd(42)} ${String(p.weeks.size).padStart(4)} ${String(p.assembled).padStart(10)} ${String(p.faltantes).padStart(10)}`);
      }
      // Flex intensity: what share of each hub's assembly is done by role accounts?
      say('');
      say('  FLEX INTENSITY — share of hub assembly volume done by role accounts:');
      const byHub = new Map<string, { role: number; total: number }>();
      for (const p of all) {
        const h = byHub.get(p.hub) ?? { role: 0, total: 0 };
        h.total += p.assembled;
        if (p.isRole) h.role += p.assembled;
        byHub.set(p.hub, h);
      }
      for (const [hub, v] of [...byHub.entries()].sort((a, b) => (b[1].role / (b[1].total || 1)) - (a[1].role / (a[1].total || 1)))) {
        const pct = v.total > 0 ? ((v.role / v.total) * 100).toFixed(1) : '—';
        say(`    ${hub.padEnd(16)} ${String(pct).padStart(6)}%   (${v.role} of ${v.total} orders)`);
      }

      // Validation against the confirmed headcount, not discovery of roles.
      say('');
      say('  HEADCOUNT CHECK — role accounts seen vs auxiliares expected');
      say('  (expected excludes líderes de turno and the coordinador, so accounts');
      say('   ABOVE expected may simply be líderes/coordinador also assembling)');
      const seenByHub = new Map<string, string[]>();
      for (const p of roles) seenByHub.set(p.hub, [...(seenByHub.get(p.hub) ?? []), p.name]);
      for (const hub of Object.keys(EXPECTED_AUX)) {
        const seen = seenByHub.get(hub) ?? [];
        const exp = EXPECTED_AUX[hub];
        const mark = seen.length === exp ? '✓' : seen.length > exp ? '↑' : '↓';
        say(`    ${mark} ${hub.padEnd(16)} seen ${String(seen.length).padStart(2)} · expected aux ${exp}`);
        for (const n of seen) say(`         ${n}`);
      }
      const unexpected = [...seenByHub.keys()].filter((h) => !(h in EXPECTED_AUX));
      if (unexpected.length) say(`    ! role accounts at unrecognised hubs: ${unexpected.join(', ')}`);
    } else {
      say('');
      say(`  ${'hub'.padEnd(16)} ${'account'.padEnd(46)} ${'wks'.padStart(4)} ${'rows'.padStart(6)}`);
      for (const p of roles) {
        say(`  ${p.hub.padEnd(16)} ${p.name.slice(0, 45).padEnd(46)} ${String(p.weeks.size).padStart(4)} ${String(p.rows).padStart(6)}`);
      }
    }
  }

  // ---- the specific question: which role accounts exist at which hub? -------
  say('');
  say('='.repeat(78));
  say('WEEK-BY-WEEK: role accounts in desempeno_operadores');
  say('Shows whether an aux assembles EVERY week (structural) or only SOME weeks');
  say('(genuine flex). This is the distinction the causal chain depends on.');
  say('='.repeat(78));

  const opIds = uploads.filter((u: any) => u.app_id === 'desempeno_operadores').map((u: any) => u.id);
  const opRows = await fetchAll<any>('upload_rows', 'upload_id, data', (q) => q.in('upload_id', opIds));
  const series = new Map<string, Map<string, number>>();
  for (const r of opRows) {
    const d = r.data ?? {};
    const name = String(d['assembler'] ?? '').trim();
    if (!name || !ROLE_PAT.test(name)) continue;
    const week = weekById.get(r.upload_id) ?? '';
    const m = series.get(name) ?? new Map<string, number>();
    const a = toNum(d['num_assembled']);
    m.set(week, (m.get(week) ?? 0) + (Number.isFinite(a) ? a : 0));
    series.set(name, m);
  }
  const weeksShown = allWeeks.slice(-12);
  say('');
  say(`  ${'account'.padEnd(40)}${weeksShown.map((w) => w.slice(5).padStart(7)).join('')}`);
  for (const [name, m] of [...series.entries()].sort()) {
    const cells = weeksShown.map((w) => (m.has(w) ? String(m.get(w)) : '·').padStart(7)).join('');
    say(`  ${name.slice(0, 39).padEnd(40)}${cells}`);
  }
  say('');
  say('  · = no row that week (did not assemble at all)');
  say('  a number = orders assembled that week');

  writeFileSync('role-accounts.txt', L.join('\n'));
  say('\n✅ Wrote role-accounts.txt to the project root.');
}

main().catch((e) => { console.error(e); process.exit(1); });
