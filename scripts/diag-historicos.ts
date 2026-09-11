/**
 * Read-only diagnostic for /historicos data volume (session 16, 2026-09-11).
 *
 * Answers the question session 15 never measured: how much data does this page
 * actually move, and how much of it does the rendered tab use? Prints the old
 * (fetch-everything) volume next to the new (per-tab) volume.
 *
 *   npx tsx scripts/diag-historicos.ts
 *
 * Row counts and byte-per-row figures are properties of the data, not of the
 * machine — unlike wall-clock timings, they are comparable from anywhere.
 */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const TREND_WEEKS = 8;   // must match app/(app)/historicos/page.tsx
const PAGE = 1000;
const mb = (b: number) => `${(b / 1e6).toFixed(2)} MB`;
const pages = (n: number) => Math.max(0, Math.ceil(n / PAGE));

async function count(q: any): Promise<number> {
  const { count } = await q;
  return count ?? 0;
}

async function bytesPerRow(q: any): Promise<number> {
  const { data } = await q;
  if (!data || data.length === 0) return 0;
  return Buffer.byteLength(JSON.stringify(data)) / data.length;
}

async function main() {
  const { data: cw } = await sb.from('current_week').select('week_start').single();
  let currentWeek = cw?.week_start as string | undefined;
  if (!currentWeek) {
    const { data: l } = await sb.from('kpi_snapshots').select('week_start')
      .order('week_start', { ascending: false }).limit(1).single();
    currentWeek = l?.week_start as string;
  }
  const since = new Date(currentWeek + 'T00:00:00');
  since.setDate(since.getDate() - 7 * 51);
  const sinceIso = since.toISOString().slice(0, 10);

  // Trend window, derived exactly as page.tsx derives it.
  const { data: roster } = await sb.from('uploads').select('app_id, week_start')
    .eq('status', 'validated').in('app_id', ['desempeno_operadores', 'desempeno_repartidores']);
  const windowStart = (app: string) => {
    const w = [...new Set((roster ?? []).filter((r) => r.app_id === app).map((r) => r.week_start))].sort();
    return w.length === 0 ? sinceIso : w[Math.max(0, w.length - TREND_WEEKS)];
  };
  const asmSince = windowStart('desempeno_operadores');
  const drvSince = windowStart('desempeno_repartidores');

  console.log(`week=${currentWeek}  old trend window from ${sinceIso}  new: armador ${asmSince} / repartidor ${drvSince}\n`);

  const peerCols = 'kpi_id, week_start, entity_type, entity_key, scope_type, scope_key, value, peer_mean, z_score, rank, rank_total';
  const snapCols = 'kpi_id, week_start, scope_level, scope_key, value, numerator, denominator, prev_week_value, rolling_mean_4w';

  const nSnap = await count(sb.from('kpi_snapshots').select('*', { count: 'exact', head: true })
    .gte('week_start', sinceIso).lte('week_start', currentWeek).in('scope_level', ['hub', 'city', 'global']));
  const nPeerWk = await count(sb.from('peer_comparisons').select('*', { count: 'exact', head: true })
    .eq('week_start', currentWeek));
  const nAsmOld = await count(sb.from('peer_comparisons').select('*', { count: 'exact', head: true })
    .eq('entity_type', 'operator').eq('scope_type', 'within_hub').gte('week_start', sinceIso).lte('week_start', currentWeek));
  const nAsmNew = await count(sb.from('peer_comparisons').select('*', { count: 'exact', head: true })
    .eq('entity_type', 'operator').eq('scope_type', 'within_hub').gte('week_start', asmSince).lte('week_start', currentWeek));
  const nDrvOld = await count(sb.from('peer_comparisons').select('*', { count: 'exact', head: true })
    .eq('entity_type', 'driver').eq('scope_type', 'within_hub').gte('week_start', sinceIso).lte('week_start', currentWeek));
  const nDrvNew = await count(sb.from('peer_comparisons').select('*', { count: 'exact', head: true })
    .eq('entity_type', 'driver').eq('scope_type', 'within_hub').gte('week_start', drvSince).lte('week_start', currentWeek));

  const snapB = await bytesPerRow(sb.from('kpi_snapshots').select(snapCols)
    .gte('week_start', sinceIso).lte('week_start', currentWeek).in('scope_level', ['hub', 'city', 'global']).limit(500));
  const peerB = await bytesPerRow(sb.from('peer_comparisons').select(peerCols).eq('week_start', currentWeek).limit(500));

  // Raw upload_rows — the MNA/faltantes aggregation inputs.
  const { data: mnaUp } = await sb.from('uploads').select('id, hub_id')
    .eq('week_start', currentWeek).eq('status', 'validated').eq('app_id', 'mna');
  const { data: falUp } = await sb.from('uploads').select('id, hub_id')
    .eq('week_start', currentWeek).eq('status', 'validated').eq('app_id', 'faltantes_armador');

  const rowCount = async (id: string) => count(sb.from('upload_rows')
    .select('*', { count: 'exact', head: true }).eq('upload_id', id).eq('is_excluded', false));

  const mnaCounts = await Promise.all((mnaUp ?? []).map((u) => rowCount(u.id)));
  const falCounts = await Promise.all((falUp ?? []).map((u) => rowCount(u.id)));
  const mnaRows = mnaCounts.reduce((a, b) => a + b, 0);
  const falRows = falCounts.reduce((a, b) => a + b, 0);
  const mnaPagesOld = mnaCounts.reduce((a, n) => a + Math.max(1, Math.ceil(n / PAGE)), 0);
  const biggestMna = mnaCounts.length ? Math.max(...mnaCounts) : 0;
  const rawB = (mnaUp ?? []).length
    ? await bytesPerRow(sb.from('upload_rows').select('upload_id, data').eq('upload_id', mnaUp![0].id).eq('is_excluded', false).limit(200))
    : 0;

  const row = (label: string, oldRows: number, newRows: number, b: number) =>
    console.log(`${label.padEnd(24)} ${String(oldRows).padStart(8)} -> ${String(newRows).padStart(8)} rows   ${mb(oldRows * b).padStart(9)} -> ${mb(newRows * b).padStart(9)}`);

  console.log('DEFAULT TAB (Por KPI)            before   ->    after');
  row('snapshots', nSnap, nSnap, snapB);
  row('peers (current week)', nPeerWk, 0, peerB);
  row('assembler trend', nAsmOld, 0, peerB);
  row('driver trend', nDrvOld, 0, peerB);
  row('mna raw upload_rows', mnaRows, 0, rawB);
  row('faltantes raw rows', falRows, 0, rawB);
  const defOld = nSnap * snapB + (nPeerWk + nAsmOld + nDrvOld) * peerB + (mnaRows + falRows) * rawB;
  const defNew = nSnap * snapB;
  console.log(`${'TOTAL fetched'.padEnd(24)} ${mb(defOld).padStart(20)} -> ${mb(defNew).padStart(9)}   (${(defOld / Math.max(defNew, 1)).toFixed(1)}x less)`);
  console.log(`${'supabase requests'.padEnd(24)} ${String(5 + pages(nSnap) + pages(nPeerWk) + pages(nAsmOld) + pages(nDrvOld) + mnaPagesOld + (mnaUp?.length ?? 0) + (falUp?.length ?? 0) + 8).padStart(20)} -> ${String(5 + pages(nSnap)).padStart(9)}`);

  console.log('\nPOR HUB TAB                      before   ->    after');
  row('snapshots', nSnap, nSnap, snapB);
  row('peers (current week)', nPeerWk, nPeerWk, peerB);
  row('assembler trend', nAsmOld, nAsmNew, peerB);
  row('driver trend', nDrvOld, nDrvNew, peerB);
  row('mna raw (blocking)', mnaRows, 0, rawB);
  row('faltantes raw (blocking)', falRows, 0, rawB);
  const hubOld = defOld;
  const hubNew = nSnap * snapB + (nPeerWk + nAsmNew + nDrvNew) * peerB;
  console.log(`${'TOTAL blocking fetch'.padEnd(24)} ${mb(hubOld).padStart(20)} -> ${mb(hubNew).padStart(9)}   (${(hubOld / Math.max(hubNew, 1)).toFixed(1)}x less)`);
  console.log(`\nafter first paint, per selected hub: ~${biggestMna} mna rows (~${mb(biggestMna * rawB)}) via /api/historicos/mna-products`);
}

main().catch((e) => { console.error(e); process.exit(1); });
