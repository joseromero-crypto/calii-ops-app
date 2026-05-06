/**
 * MNA subcategory verification script.
 *
 * Pulls the current week's MNA rows directly from Supabase, applies the same
 * classifier and monetary formula the site uses, and prints a comparison table
 * against what's stored in kpi_snapshots.
 *
 * Run from the project root:
 *   npx tsx scripts/verify-mna.ts
 */

import { createClient } from '@supabase/supabase-js';
import { classifyMnaProduct } from '../lib/sku-classifier';

// ── Load env ────────────────────────────────────────────────────────────────
import { config } from 'dotenv';
config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// ── Hub name normaliser (mirrors kpi-compute.ts) ─────────────────────────────
const HUB_ALIAS_MAP: Record<string, string> = {
  mh_contry: 'mh_contry',       contry: 'mh_contry',
  mh_cumbres: 'mh_cumbres',     cumbres: 'mh_cumbres',
  mh_san_nicolas: 'mh_san_nicolas', san_nicolas: 'mh_san_nicolas',
  mh_guadalupe: 'mh_guadalupe', guadalupe: 'mh_guadalupe',
  mh_avicola: 'mh_avicola',     avicola: 'mh_avicola',
  mh_saltillo: 'mh_avicola',    saltillo: 'mh_avicola',
  mh_zapopan: 'mh_zapopan',     zapopan: 'mh_zapopan',
  mh_condesa: 'mh_condesa',     condesa: 'mh_condesa',
  mh_san_pedro: 'mh_san_pedro', san_pedro: 'mh_san_pedro',
};
function resolveHub(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, '_');
  if (s.startsWith('ch_')) return null;
  return HUB_ALIAS_MAP[s] ?? null;
}

// ── KPI IDs and their category filters ──────────────────────────────────────
const MNA_KPIS = [
  { id: 'mna_pct',          label: 'Total MNA',  cat: null         },
  { id: 'mna_fyv_pct',      label: 'FyV',        cat: 'fyv'        },
  { id: 'mna_carnes_pct',   label: 'Carnes',     cat: 'carnes'     },
  { id: 'mna_graneles_pct', label: 'Graneles',   cat: 'abarrotes'  },
] as const;

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Resolve current week
  // Priority: CLI arg > current_week table > latest kpi_snapshots
  let weekStart: string | undefined = process.argv[2];
  if (weekStart && !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    console.error('Usage: npx tsx scripts/verify-mna.ts [YYYY-MM-DD]');
    process.exit(1);
  }
  if (!weekStart) {
    const { data: cw } = await sb.from('current_week').select('week_start').single();
    weekStart = cw?.week_start as string | undefined;
  }
  if (!weekStart) {
    const { data: latest } = await sb
      .from('uploads')
      .select('week_start')
      .eq('status', 'validated')
      .order('week_start', { ascending: false })
      .limit(1)
      .single();
    weekStart = latest?.week_start as string | undefined;
  }
  if (!weekStart) { console.error('No week found. Pass a date: npx tsx scripts/verify-mna.ts 2025-04-25'); process.exit(1); }
  console.log(`\nWeek: ${weekStart}\n`);

  // 1b. Debug — show what's actually in the uploads table
  const { data: debugUploads } = await sb
    .from('uploads')
    .select('app_id, week_start, status')
    .order('week_start', { ascending: false })
    .limit(10);
  console.log('Latest uploads in DB:');
  console.table(debugUploads ?? []);
  console.log();

  // 2. Fetch validated MNA uploads for this week
  const { data: uploads } = await sb
    .from('uploads')
    .select('id, hub_id')
    .eq('week_start', weekStart)
    .eq('status', 'validated')
    .eq('app_id', 'mna');

  if (!uploads || uploads.length === 0) {
    console.error('No validated MNA uploads for this week.');
    process.exit(1);
  }
  const uploadMap = new Map(uploads.map(u => [u.id, u]));
  console.log(`MNA uploads: ${uploads.length} files\n`);

  // 3. Fetch all MNA rows in pages
  const allRows: { upload_id: string; data: any }[] = [];
  let from = 0;
  while (true) {
    const { data: page } = await sb
      .from('upload_rows')
      .select('upload_id, data')
      .in('upload_id', uploads.map(u => u.id))
      .eq('is_excluded', false)
      .range(from, from + 999);
    if (!page || page.length === 0) break;
    allRows.push(...page);
    from += page.length;
    if (page.length < 1000) break;
  }
  console.log(`Total MNA rows: ${allRows.length}\n`);

  // 4. Aggregate per hub × category using the same monetary formula
  //    num = SUM(MNA $),  den = SUM(MNA $ + Recibido × Source price)
  type Agg = { num: number; den: number };
  // key: `hubId|categoryOrAll`
  const agg = new Map<string, Agg>();

  function add(key: string, num: number, den: number) {
    const ex = agg.get(key);
    if (ex) { ex.num += num; ex.den += den; }
    else agg.set(key, { num, den });
  }

  let skippedNoHub = 0, skippedNoThroughput = 0;

  for (const r of allRows) {
    const u = uploadMap.get(r.upload_id);
    if (!u) continue;

    // Hub resolution: prefer upload.hub_id, fall back to row data (mirrors kpi-compute.ts fix)
    const rawHub = u.hub_id ||
      String(r.data['Hub'] ?? r.data['geofence'] ?? r.data['Geofence'] ?? '').trim() || null;
    const hubId = resolveHub(rawHub);
    if (!hubId) { skippedNoHub++; continue; }

    const producto  = String(r.data['Producto']  ?? '').trim();
    const proveedor = String(r.data['Proveedor'] ?? '').trim();
    if (!producto) continue;

    const mna$    = Number(r.data['MNA ($)'])      || 0;
    const rec     = Number(r.data['Recibido'])      || 0;
    const sp      = Number(r.data['Source price'])  || 0;
    const revenue = rec * sp;
    const throughput = mna$ + revenue;
    if (throughput <= 0) { skippedNoThroughput++; continue; }

    const category = classifyMnaProduct(producto, proveedor);

    // Total (no filter)
    add(`${hubId}|all`, mna$, throughput);
    // Category bucket
    add(`${hubId}|${category}`, mna$, throughput);
  }

  console.log(`Skipped — no hub: ${skippedNoHub}  |  zero throughput: ${skippedNoThroughput}\n`);

  // 5. Fetch what kpi_snapshots has stored for this week
  const kpiIds = MNA_KPIS.map(k => k.id);
  const { data: snaps } = await sb
    .from('kpi_snapshots')
    .select('kpi_id, scope_key, value')
    .in('kpi_id', kpiIds)
    .eq('week_start', weekStart)
    .eq('scope_level', 'hub');

  const snapMap = new Map<string, number | null>();
  for (const s of snaps ?? []) {
    snapMap.set(`${s.scope_key}|${s.kpi_id}`, s.value);
  }

  // 6. Print comparison table
  const catKey: Record<string, string> = {
    mna_pct: 'all', mna_fyv_pct: 'fyv', mna_carnes_pct: 'carnes', mna_graneles_pct: 'abarrotes',
  };

  const hubs = [...new Set([...agg.keys()].map(k => k.split('|')[0]))].sort();

  for (const hubId of hubs) {
    console.log(`── ${hubId} ──────────────────────────────`);
    console.log(`${'KPI'.padEnd(20)} ${'Calculated'.padStart(12)} ${'In DB'.padStart(12)} ${'Match?'.padStart(8)}`);
    for (const kpi of MNA_KPIS) {
      const bucket = agg.get(`${hubId}|${catKey[kpi.id]}`);
      const calc = bucket && bucket.den > 0 ? bucket.num / bucket.den : null;
      const stored = snapMap.get(`${hubId}|${kpi.id}`) ?? null;
      const calcStr = calc !== null ? `${(calc * 100).toFixed(2)}%` : '—';
      const storedStr = stored !== null ? `${(stored * 100).toFixed(2)}%` : '—';
      const match = calc !== null && stored !== null
        ? Math.abs(calc - stored) < 0.0001 ? '✓' : '✗'
        : '—';
      console.log(`${kpi.label.padEnd(20)} ${calcStr.padStart(12)} ${storedStr.padStart(12)} ${match.padStart(8)}`);
    }
    console.log();
  }
}

main().catch(console.error);
