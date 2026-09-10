/**
 * JSON BLOB INSPECTOR — READ ONLY
 *
 * Several columns are stored as JSON and marked `role: 'ignored'`, so nothing
 * in the app has ever looked inside them. The biggest is
 * `desempeno_repartidores.orders_data` — ~57 entries per driver-week, which
 * makes it the finest grain in the whole database.
 *
 * This dumps what is ACTUALLY in there: every key that appears across the
 * sampled entries, how often each is populated, its observed types, and a few
 * real values per key. No guessing.
 *
 * Run from the project root:
 *   npx tsx scripts/inspect-blob.ts
 *   npx tsx scripts/inspect-blob.ts desempeno_repartidores orders_data
 *
 * Nothing is written to Supabase. Safe to re-run.
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
import { config } from 'dotenv';

config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

/** Blob columns worth opening, in priority order. */
const DEFAULT_TARGETS: [string, string][] = [
  ['desempeno_repartidores', 'orders_data'],
  ['desempeno_repartidores', 'client_issues_for_driver'],
  ['desempeno_repartidores', 'admin_incidents'],
  ['desempeno_operadores', 'issues_comments'],
  ['desempeno_repartidores', 'issues_comments'],
];

/** How many parent rows to open. Entries multiply fast — 57 per row here. */
const ROW_SAMPLE = 200;
const PAGE = 1000;

async function fetchSome(uploadIds: string[], limit: number): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await sb
      .from('upload_rows').select('data')
      .in('upload_id', uploadIds)
      .range(from, Math.min(from + PAGE, limit) - 1);
    if (error) { console.error(`  ! ${error.message}`); break; }
    if (!data?.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

/** Does this string look like a date/time we could actually use? */
function looksTemporal(v: unknown): boolean {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v);
}

async function main() {
  const argApp = process.argv[2], argCol = process.argv[3];
  const targets = argApp && argCol ? [[argApp, argCol] as [string, string]] : DEFAULT_TARGETS;

  const L: string[] = [];
  const say = (s = '') => { L.push(s); console.log(s); };

  const { data: uploads } = await sb.from('uploads').select('id, app_id, week_start, status');
  const validated = (uploads ?? []).filter((u: any) => u.status === 'validated');

  for (const [appId, col] of targets) {
    say('='.repeat(78));
    say(`BLOB:  ${appId}.${col}`);
    say('='.repeat(78));

    // Newest weeks first — structure may have changed over 20 weeks.
    const ids = validated
      .filter((u: any) => u.app_id === appId)
      .sort((a: any, b: any) => b.week_start.localeCompare(a.week_start))
      .map((u: any) => u.id);
    if (!ids.length) { say('  no uploads\n'); continue; }

    const rows = await fetchSome(ids, ROW_SAMPLE);
    const blobs = rows.map((r) => r.data?.[col]).filter((v) => v != null);
    if (!blobs.length) { say(`  ${col} is null/absent in all ${rows.length} sampled rows\n`); continue; }

    // Flatten: an array blob contributes its entries; anything else is one entry.
    const entries: unknown[] = [];
    let arrayBlobs = 0;
    for (const b of blobs) {
      if (Array.isArray(b)) { arrayBlobs++; entries.push(...b); }
      else entries.push(b);
    }

    say(`  parent rows sampled: ${rows.length}   non-null blobs: ${blobs.length}`);
    say(`  blob shape: ${arrayBlobs === blobs.length ? 'array' : arrayBlobs === 0 ? 'scalar/object' : 'MIXED — some array, some not'}`);
    say(`  total entries extracted: ${entries.length}`);

    const entryTypes = new Map<string, number>();
    for (const e of entries) entryTypes.set(typeOf(e), (entryTypes.get(typeOf(e)) ?? 0) + 1);
    say(`  entry types: ${[...entryTypes].map(([t, n]) => `${t}=${n}`).join(', ')}\n`);

    const objects = entries.filter((e) => e !== null && typeof e === 'object' && !Array.isArray(e)) as Record<string, unknown>[];

    if (!objects.length) {
      // Plain strings — e.g. issues_comments. Show them raw.
      say('  Entries are not objects. Verbatim samples:\n');
      for (const e of entries.slice(0, 12)) say(`    ${String(e).slice(0, 200)}`);
      say('');
      continue;
    }

    // Key-by-key profile.
    const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))];
    say(`  ${objects.length} object entries · ${keys.length} distinct keys\n`);
    say(`  ${'key'.padEnd(28)} ${'fill'.padStart(6)}  types                samples`);
    say(`  ${'─'.repeat(74)}`);

    const temporalKeys: string[] = [];
    for (const k of keys.sort()) {
      const present = objects.filter((o) => k in o && o[k] !== null && o[k] !== '');
      const types = new Map<string, number>();
      for (const o of present) types.set(typeOf(o[k]), (types.get(typeOf(o[k])) ?? 0) + 1);
      const fill = `${((present.length / objects.length) * 100).toFixed(0)}%`;
      const tstr = [...types.keys()].join('/');
      const samples = present.slice(0, 2)
        .map((o) => (typeof o[k] === 'object' ? JSON.stringify(o[k]) : String(o[k])).slice(0, 28))
        .join(' · ');
      if (present.some((o) => looksTemporal(o[k]))) temporalKeys.push(k);
      say(`  ${k.slice(0, 27).padEnd(28)} ${fill.padStart(6)}  ${tstr.padEnd(20)} ${samples}`);
    }

    if (temporalKeys.length) {
      say(`\n  ⏱  TIMESTAMP-LIKE KEYS: ${temporalKeys.join(', ')}`);
      say('     These are what would make per-order window and lateness analysis possible.');
      say('     Nothing in the app reads them today.');
    } else {
      say('\n  No timestamp-like keys found in this sample.');
    }

    say('\n  Two full entries, verbatim:');
    for (const o of objects.slice(0, 2)) say(`    ${JSON.stringify(o).slice(0, 700)}`);
    say('');
  }

  writeFileSync('inspect-blob.txt', L.join('\n'));
  say('\n✅ Wrote inspect-blob.txt to the project root.');
}

main().catch((e) => { console.error(e); process.exit(1); });
