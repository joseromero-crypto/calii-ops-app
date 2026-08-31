/**
 * Calii Ops — full data audit (READ ONLY).
 *
 * Answers: what actually lands in this database every week, how much of it
 * there is, how far back it goes, which columns carry real signal, and which
 * ones we store and then never look at again.
 *
 * Writes two files next to the project root:
 *   data-audit-report.json   — the machine-readable dump (this is what Claude reads)
 *   data-audit-summary.txt   — a quick human skim of the same thing
 *
 * Run from the project root:
 *   npx tsx scripts/data-audit.ts
 *
 * Nothing here writes to Supabase. Safe to re-run.
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

/** How many recent weeks of upload_rows to profile in depth. */
const PROFILE_WEEKS = 4;
/** Hard cap on rows pulled per app for profiling, so this stays a few minutes. */
const PROFILE_ROW_CAP = 12000;
const PAGE = 1000;

const log = (...a: any[]) => console.log(...a);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function countOf(table: string, filters: Record<string, any> = {}): Promise<number | null> {
  let q = sb.from(table).select('*', { count: 'exact', head: true });
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  const { count, error } = await q;
  if (error) return null;
  return count ?? 0;
}

async function tableExists(table: string): Promise<boolean> {
  const { error } = await sb.from(table).select('*', { count: 'exact', head: true });
  return !error;
}

async function fetchAll<T = any>(
  table: string,
  select: string,
  build?: (q: any) => any,
  cap = 50000
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    let q = sb.from(table).select(select).range(from, from + PAGE - 1);
    if (build) q = build(q);
    const { data, error } = await q;
    if (error) {
      log(`   ! ${table}: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    out.push(...(data as T[]));
    if (data.length < PAGE) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// column profiler
// ---------------------------------------------------------------------------

interface ColStat {
  present: number;         // key existed on the row
  nonEmpty: number;        // had a meaningful value
  nulls: number;
  emptyString: number;
  emptyList: number;
  types: Record<string, number>;
  numeric?: { min: number; max: number; mean: number; zeros: number; negatives: number; n: number };
  distinctApprox?: number;
  topValues?: [string, number][];
  listLen?: { min: number; max: number; mean: number };
  textLen?: { min: number; max: number; mean: number };
  samples: string[];
}

function newStat(): ColStat {
  return {
    present: 0, nonEmpty: 0, nulls: 0, emptyString: 0, emptyList: 0,
    types: {}, samples: [],
  };
}

function profileRows(rows: any[]): Record<string, ColStat> {
  const stats: Record<string, ColStat> = {};
  const nums: Record<string, number[]> = {};
  const vals: Record<string, Map<string, number>> = {};
  const lens: Record<string, number[]> = {};
  const tlens: Record<string, number[]> = {};

  for (const r of rows) {
    const d = r?.data ?? {};
    for (const [k, v] of Object.entries(d)) {
      const s = (stats[k] ??= newStat());
      s.present++;

      const t = v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v;
      s.types[t] = (s.types[t] ?? 0) + 1;

      if (v === null || v === undefined) { s.nulls++; continue; }
      if (typeof v === 'string' && v.trim() === '') { s.emptyString++; continue; }
      if (Array.isArray(v) && v.length === 0) { s.emptyList++; continue; }

      s.nonEmpty++;

      if (typeof v === 'number' && Number.isFinite(v)) {
        (nums[k] ??= []).push(v);
      } else if (Array.isArray(v)) {
        (lens[k] ??= []).push(v.length);
        if (s.samples.length < 3) s.samples.push(JSON.stringify(v).slice(0, 220));
      } else if (typeof v === 'string') {
        (tlens[k] ??= []).push(v.length);
        const m = (vals[k] ??= new Map());
        if (m.size < 5000) m.set(v, (m.get(v) ?? 0) + 1);
        if (s.samples.length < 3 && v.length > 0) s.samples.push(v.slice(0, 220));
      } else if (typeof v === 'boolean') {
        const m = (vals[k] ??= new Map());
        m.set(String(v), (m.get(String(v)) ?? 0) + 1);
      } else if (typeof v === 'object') {
        if (s.samples.length < 2) s.samples.push(JSON.stringify(v).slice(0, 220));
      }
    }
  }

  const agg = (arr: number[]) => ({
    min: Math.min(...arr),
    max: Math.max(...arr),
    mean: Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(4)),
  });

  for (const [k, s] of Object.entries(stats)) {
    const n = nums[k];
    if (n?.length) {
      const a = agg(n);
      s.numeric = { ...a, zeros: n.filter((x) => x === 0).length, negatives: n.filter((x) => x < 0).length, n: n.length };
    }
    const l = lens[k];
    if (l?.length) s.listLen = agg(l);
    const tl = tlens[k];
    if (tl?.length) s.textLen = agg(tl);
    const m = vals[k];
    if (m) {
      s.distinctApprox = m.size;
      s.topValues = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([v, c]) => [v.slice(0, 80), c] as [string, number]);
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const report: any = { generated_at: new Date().toISOString(), supabase_url: SUPABASE_URL };

  // -- 1. registry ----------------------------------------------------------
  log('\n[1/8] Registry…');
  const [apps, appColumns, kpis, hubs, kpiTargets] = await Promise.all([
    fetchAll('apps', '*'),
    fetchAll('app_columns', '*'),
    fetchAll('kpis', '*'),
    fetchAll('hubs', '*'),
    fetchAll('kpi_targets', '*'),
  ]);
  report.registry = {
    apps,
    app_columns_count: appColumns.length,
    app_columns: appColumns,
    kpis,
    hubs,
    kpi_targets_count: kpiTargets.length,
    kpi_targets: kpiTargets,
  };
  log(`   apps=${apps.length} app_columns=${appColumns.length} kpis=${kpis.length} hubs=${hubs.length} targets=${kpiTargets.length}`);

  // prompt-context registry (drives the insight system prompt)
  log('\n[2/8] Prompt context registry…');
  const promptTables = ['context_sections', 'behavior_rules', 'scope_rules', 'headline_examples', 'prompt_versions'];
  report.prompt_registry = {};
  for (const t of promptTables) {
    if (!(await tableExists(t))) { report.prompt_registry[t] = 'MISSING'; continue; }
    report.prompt_registry[t] = await fetchAll(t, '*', undefined, 500);
  }

  // -- 3. uploads coverage --------------------------------------------------
  log('\n[3/8] Upload coverage…');
  const uploads = await fetchAll<any>('uploads', 'id, app_id, week_start, city, hub_id, status, row_count, created_at, file_storage_path');
  const weeks = [...new Set(uploads.map((u) => u.week_start))].sort();
  const byAppWeek: Record<string, Record<string, { files: number; rows: number; statuses: string[] }>> = {};
  for (const u of uploads) {
    const a = (byAppWeek[u.app_id] ??= {});
    const w = (a[u.week_start] ??= { files: 0, rows: 0, statuses: [] });
    w.files++;
    w.rows += u.row_count ?? 0;
    if (!w.statuses.includes(u.status)) w.statuses.push(u.status);
  }
  report.uploads = {
    total_uploads: uploads.length,
    total_rows_declared: uploads.reduce((a, u) => a + (u.row_count ?? 0), 0),
    weeks_present: weeks,
    first_week: weeks[0],
    last_week: weeks[weeks.length - 1],
    week_count: weeks.length,
    status_breakdown: uploads.reduce((acc: any, u) => { acc[u.status] = (acc[u.status] ?? 0) + 1; return acc; }, {}),
    by_app_week: byAppWeek,
    by_app_totals: Object.fromEntries(
      Object.entries(byAppWeek).map(([app, ws]) => [app, {
        weeks: Object.keys(ws).length,
        files: Object.values(ws).reduce((a, w) => a + w.files, 0),
        rows: Object.values(ws).reduce((a, w) => a + w.rows, 0),
        first_week: Object.keys(ws).sort()[0],
        last_week: Object.keys(ws).sort().pop(),
      }])
    ),
  };
  log(`   ${uploads.length} uploads across ${weeks.length} weeks (${weeks[0]} → ${weeks[weeks.length - 1]})`);

  // -- 4. upload_rows volume + column profiling -----------------------------
  log(`\n[4/8] Profiling upload_rows (last ${PROFILE_WEEKS} weeks per app, cap ${PROFILE_ROW_CAP})…`);
  report.upload_rows = { total: await countOf('upload_rows'), by_app: {} as any };
  log(`   upload_rows total = ${report.upload_rows.total}`);

  const recentWeeks = weeks.slice(-PROFILE_WEEKS);
  for (const app of apps) {
    const ids = uploads
      .filter((u) => u.app_id === app.id && recentWeeks.includes(u.week_start))
      .map((u) => u.id);
    if (ids.length === 0) {
      report.upload_rows.by_app[app.id] = { profiled_rows: 0, note: 'no uploads in profile window' };
      continue;
    }
    const rows = await fetchAll<any>(
      'upload_rows',
      'data, is_excluded',
      (q) => q.in('upload_id', ids),
      PROFILE_ROW_CAP
    );
    const excluded = rows.filter((r) => r.is_excluded).length;
    const stats = profileRows(rows);
    // declared schema for this app
    const declared = appColumns.filter((c: any) => c.app_id === app.id);
    const declaredNames = new Set(declared.map((c: any) => c.name));
    const seenNames = new Set(Object.keys(stats));
    report.upload_rows.by_app[app.id] = {
      profiled_weeks: recentWeeks,
      profiled_rows: rows.length,
      excluded_rows: excluded,
      hit_cap: rows.length >= PROFILE_ROW_CAP,
      declared_columns: declared.length,
      columns_seen_in_data: seenNames.size,
      declared_but_never_present: [...declaredNames].filter((n) => !seenNames.has(n)),
      present_but_not_declared: [...seenNames].filter((n) => !declaredNames.has(n)),
      column_stats: stats,
    };
    log(`   ${app.id}: ${rows.length} rows, ${seenNames.size}/${declared.length} declared cols seen`);
  }

  // -- 5. kpi_snapshots -----------------------------------------------------
  log('\n[5/8] KPI snapshots…');
  const snaps = await fetchAll<any>(
    'kpi_snapshots',
    'kpi_id, week_start, scope_level, scope_key, value, numerator, denominator, prev_week_value, rolling_mean_4w'
  );
  const snapByKpi: Record<string, any> = {};
  for (const s of snaps) {
    const k = (snapByKpi[s.kpi_id] ??= {
      rows: 0, weeks: new Set<string>(), scopes: {} as any, nullValue: 0,
      nullPrev: 0, nullRolling: 0, nullNumerator: 0, min: Infinity, max: -Infinity,
    });
    k.rows++;
    k.weeks.add(s.week_start);
    k.scopes[s.scope_level] = (k.scopes[s.scope_level] ?? 0) + 1;
    if (s.value == null) k.nullValue++;
    else { k.min = Math.min(k.min, s.value); k.max = Math.max(k.max, s.value); }
    if (s.prev_week_value == null) k.nullPrev++;
    if (s.rolling_mean_4w == null) k.nullRolling++;
    if (s.numerator == null) k.nullNumerator++;
  }
  report.kpi_snapshots = {
    total: snaps.length,
    by_kpi: Object.fromEntries(Object.entries(snapByKpi).map(([id, k]: any) => {
      const ws = [...k.weeks].sort();
      return [id, {
        rows: k.rows,
        week_count: ws.length,
        first_week: ws[0],
        last_week: ws[ws.length - 1],
        missing_weeks: weeks.filter((w) => !k.weeks.has(w)),
        scopes: k.scopes,
        null_value_pct: Number(((k.nullValue / k.rows) * 100).toFixed(1)),
        null_prev_week_pct: Number(((k.nullPrev / k.rows) * 100).toFixed(1)),
        null_rolling_4w_pct: Number(((k.nullRolling / k.rows) * 100).toFixed(1)),
        null_numerator_pct: Number(((k.nullNumerator / k.rows) * 100).toFixed(1)),
        value_min: k.min === Infinity ? null : Number(k.min.toFixed(5)),
        value_max: k.max === -Infinity ? null : Number(k.max.toFixed(5)),
      }];
    })),
    kpis_registered_with_no_snapshots: kpis.filter((k: any) => !snapByKpi[k.id]).map((k: any) => ({ id: k.id, active: k.active })),
  };
  log(`   ${snaps.length} snapshot rows across ${Object.keys(snapByKpi).length} KPIs`);

  // -- 6. peer_comparisons --------------------------------------------------
  log('\n[6/8] Peer comparisons…');
  const pcTotal = await countOf('peer_comparisons');
  const pcRecent = await fetchAll<any>(
    'peer_comparisons',
    'kpi_id, week_start, entity_type, entity_key, scope_type, scope_key, value, peer_mean, z_score, rank, rank_total',
    (q) => q.in('week_start', recentWeeks),
    40000
  );
  const pcByKpi: Record<string, any> = {};
  for (const p of pcRecent) {
    const k = (pcByKpi[p.kpi_id] ??= { rows: 0, entities: new Set(), types: {} as any, nullZ: 0 });
    k.rows++; k.entities.add(p.entity_key);
    k.types[p.entity_type] = (k.types[p.entity_type] ?? 0) + 1;
    if (p.z_score == null) k.nullZ++;
  }
  report.peer_comparisons = {
    total_all_time: pcTotal,
    profiled_weeks: recentWeeks,
    profiled_rows: pcRecent.length,
    by_kpi: Object.fromEntries(Object.entries(pcByKpi).map(([id, k]: any) => [id, {
      rows: k.rows, distinct_entities: k.entities.size, entity_types: k.types,
      null_z_score_pct: Number(((k.nullZ / k.rows) * 100).toFixed(1)),
    }])),
  };

  // -- 7. AI insights + feedback + everything else --------------------------
  log('\n[7/8] Insights, feedback, annotations, tenure…');
  const misc: any = {};
  for (const t of ['ai_insights', 'insight_feedback', 'annotations', 'saved_views', 'person_tenure', 'kpi_ramp_targets', 'audit_log', 'desempeño_repartidores']) {
    if (!(await tableExists(t))) { misc[t] = 'MISSING'; continue; }
    misc[t] = { count: await countOf(t) };
  }
  const insights = await fetchAll<any>('ai_insights', 'week_start, mode, view, view_key, rank, kpi_id, headline_es, created_at', undefined, 3000);
  misc.ai_insights_detail = {
    weeks: [...new Set(insights.map((i) => i.week_start))].sort(),
    by_mode: insights.reduce((a: any, i) => { a[i.mode] = (a[i.mode] ?? 0) + 1; return a; }, {}),
    by_view: insights.reduce((a: any, i) => { a[String(i.view)] = (a[String(i.view)] ?? 0) + 1; return a; }, {}),
    recent_headlines: insights.slice(-40).map((i) => `${i.week_start} [${i.view}/${i.view_key ?? '-'}] #${i.rank} ${i.headline_es}`),
  };
  const fb = await fetchAll<any>('insight_feedback', '*', undefined, 2000);
  misc.insight_feedback_detail = fb.slice(0, 200);
  report.misc = misc;

  // -- 8. free-text inventory ----------------------------------------------
  log('\n[8/8] Free-text inventory…');
  const freeTextCols = appColumns.filter((c: any) => c.role === 'free_text');
  const ft: any[] = [];
  for (const c of freeTextCols) {
    const st = report.upload_rows.by_app?.[c.app_id]?.column_stats?.[c.name];
    ft.push({
      app_id: c.app_id,
      column: c.name,
      type: c.type,
      profiled_rows: report.upload_rows.by_app?.[c.app_id]?.profiled_rows ?? 0,
      non_empty: st?.nonEmpty ?? 0,
      fill_pct: st ? Number(((st.nonEmpty / Math.max(st.present, 1)) * 100).toFixed(1)) : null,
      avg_chars: st?.textLen?.mean ?? null,
      avg_list_len: st?.listLen?.mean ?? null,
      samples: st?.samples ?? [],
    });
  }
  report.free_text_inventory = ft;

  // -- write ---------------------------------------------------------------
  const json = JSON.stringify(report, null, 1);
  writeFileSync('data-audit-report.json', json);

  const lines: string[] = [];
  lines.push(`CALII OPS — DATA AUDIT  ${report.generated_at}`);
  lines.push(`\nWeeks of history: ${report.uploads.week_count}  (${report.uploads.first_week} → ${report.uploads.last_week})`);
  lines.push(`Uploads: ${report.uploads.total_uploads}   upload_rows: ${report.upload_rows.total}   kpi_snapshots: ${report.kpi_snapshots.total}   peer_comparisons: ${report.peer_comparisons.total_all_time}`);
  lines.push(`\nPER APP`);
  for (const [app, t] of Object.entries<any>(report.uploads.by_app_totals)) {
    const p = report.upload_rows.by_app[app];
    lines.push(`  ${app.padEnd(26)} ${String(t.rows).padStart(8)} rows  ${String(t.weeks).padStart(3)} wk  cols seen ${p?.columns_seen_in_data ?? '?'}/${p?.declared_columns ?? '?'}`);
  }
  lines.push(`\nKPIs with no snapshots: ${report.kpi_snapshots.kpis_registered_with_no_snapshots.map((k: any) => k.id).join(', ') || '(none)'}`);
  lines.push(`\nFREE TEXT`);
  for (const f of ft) lines.push(`  ${f.app_id}.${f.column.padEnd(24)} fill ${String(f.fill_pct).padStart(5)}%  avg ${f.avg_chars ?? f.avg_list_len ?? '-'} `);
  lines.push(`\nai_insights=${misc.ai_insights?.count}  feedback=${misc.insight_feedback?.count}  annotations=${misc.annotations?.count}`);
  writeFileSync('data-audit-summary.txt', lines.join('\n'));

  log(`\n✅ Wrote data-audit-report.json (${(json.length / 1024).toFixed(0)} KB) and data-audit-summary.txt`);
  log('   Both are in the project root. Tell Claude when it is done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
