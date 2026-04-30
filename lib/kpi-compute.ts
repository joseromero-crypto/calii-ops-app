/**
 * KPI snapshot + peer comparison computation.
 *
 * Reads upload_rows for a given Fri-Thu week, evaluates every active KPI at
 * every relevant scope (entity → hub → city → global), and writes:
 *   - kpi_snapshots         (one row per kpi × week × scope)
 *   - peer_comparisons      (entity-level z-scores within hub / city / global)
 *
 * Trigger: `POST /api/recompute` after uploads finalize for a week,
 * or on a Friday-evening cron.
 */
import { createAdminSupabase } from './supabase-server';
import type { Kpi, City } from './types';
type SB = ReturnType<typeof createAdminSupabase>;
interface UploadRef {
  id: string;
  app_id: string;
  city: City | null;
  hub_id: string | null;
}
interface RawRow {
  upload_id: string;
  data: Record<string, unknown>;
}
interface EntityValue {
  entity_type: 'operator' | 'driver' | 'hub' | 'sku' | 'city';
  entity_key: string;
  city: City | null;
  hub_id: string | null;
  numerator: number;
  denominator: number; // 1 for absolute / rate metrics that don't divide
}
interface Snapshot {
  kpi_id: string;
  week_start: string;
  scope_level: 'global' | 'city' | 'hub' | 'operator' | 'driver' | 'sku';
  scope_key: string | null;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
}
interface ComputeResult {
  week_start: string;
  snapshots_written: number;
  peers_written: number;
  kpis_processed: number;
  warnings: string[];
}
// ----------------------------------------------------------------------------
// Public entry point
// ----------------------------------------------------------------------------
export async function computeSnapshotsForWeek(weekStart: string): Promise<ComputeResult> {
  const sb = createAdminSupabase();
  const warnings: string[] = [];
  // Load registry
  const [{ data: kpis }, { data: hubs }] = await Promise.all([
    sb.from('kpis').select('*').eq('active', true).order('display_order'),
    sb.from('hubs').select('id, city').eq('active', true),
  ]);
  if (!kpis || !hubs) throw new Error('Failed to load registry');
  const hubCity = new Map<string, City>();
  for (const h of hubs) hubCity.set(h.id, h.city as City);
  // Load validated uploads + rows for this week
  const { data: uploads, error: upErr } = await sb
    .from('uploads')
    .select('id, app_id, city, hub_id')
    .eq('week_start', weekStart)
    .eq('status', 'validated');
  if (upErr) throw upErr;
  if (!uploads || uploads.length === 0) {
    return { week_start: weekStart, snapshots_written: 0, peers_written: 0, kpis_processed: 0, warnings: ['no_validated_uploads'] };
  }
  const uploadById = new Map<string, UploadRef>();
  uploads.forEach((u) => uploadById.set(u.id, u as UploadRef));
  // Stream rows in pages
  const rowsByApp = new Map<string, { upload: UploadRef; data: Record<string, unknown> }[]>();
  let from = 0;
  const CHUNK = 1000;
  while (true) {
    const { data: page, error } = await sb
      .from('upload_rows')
      .select('upload_id, data')
      .in('upload_id', uploads.map((u) => u.id))
      .eq('is_excluded', false)
      .order('id', { ascending: true })
      .range(from, from + CHUNK - 1);
    if (error) throw error;
    if (!page || page.length === 0) break;
    for (const r of page as RawRow[]) {
      const u = uploadById.get(r.upload_id);
      if (!u) continue;
      if (!rowsByApp.has(u.app_id)) rowsByApp.set(u.app_id, []);
      rowsByApp.get(u.app_id)!.push({ upload: u, data: r.data });
    }
    from += page.length;
    if (page.length < CHUNK) break;
  }
  // Compute per KPI
  const allSnapshots: Snapshot[] = [];
  const allPeers: any[] = [];
  let kpisProcessed = 0;
  for (const kpi of kpis as Kpi[]) {
    try {
      const entityValues = computeEntityValues(kpi, rowsByApp, hubCity);
      if (entityValues.length === 0) {
        warnings.push(`kpi:${kpi.id} no_entity_values`);
        continue;
      }
      const snaps = aggregateAllScopes(kpi, entityValues, weekStart);
      allSnapshots.push(...snaps);

      // Some KPIs use different entity granularities for snapshots vs peers.
      // faltantes_armador_pct: hub-level values drive kpi_snapshots (event-log
      // numerator, total assembled denominator); operator-level values drive
      // peer_comparisons (per-assembler num_orders_with_faltante_armador /
      // num_assembled from desempeno_operadores).
      const peerValues =
        kpi.id === 'faltantes_armador_pct'
          ? computeFaltantesArmadorPeerValues(rowsByApp, hubCity)
          : entityValues;

      const peers = computePeersForKpi(kpi, peerValues, weekStart, hubCity);
      allPeers.push(...peers);
      kpisProcessed += 1;
    } catch (e: any) {
      warnings.push(`kpi:${kpi.id} error:${e.message}`);
    }
  }
  // Enrich with prev_week_value + rolling stats
  const enriched = await enrichWithHistory(sb, allSnapshots, weekStart);
  // Upsert both tables in parallel — each table's own batches run concurrently,
  // and the two tables are written simultaneously to maximise throughput and
  // stay well within the 60 s Netlify maxDuration.
  const [snapshotsWritten, peersWritten] = await Promise.all([
    parallelUpsert(sb, 'kpi_snapshots', enriched, 'kpi_id,week_start,scope_level,scope_key'),
    parallelUpsert(sb, 'peer_comparisons', allPeers, 'kpi_id,week_start,entity_type,entity_key,scope_type,scope_key'),
  ]);
  return { week_start: weekStart, snapshots_written: snapshotsWritten, peers_written: peersWritten, kpis_processed: kpisProcessed, warnings };
}
// ----------------------------------------------------------------------------
// Per-KPI: derive entity-level values from raw rows
// ----------------------------------------------------------------------------
function computeEntityValues(
  kpi: Kpi,
  rowsByApp: Map<string, { upload: UploadRef; data: Record<string, unknown> }[]>,
  hubCity: Map<string, City>
): EntityValue[] {
  if (kpi.id === 'faltantes_armador_pct') {
    return computeFaltantesArmadorPct(rowsByApp, hubCity);
  }
  if (!kpi.source_app_id) return [];
  const rows = rowsByApp.get(kpi.source_app_id) ?? [];
  switch (kpi.source_app_id) {
    case 'desempeno_operadores':
      return extractOperatorValues(rows, kpi);
    case 'desempeno_repartidores':
      return extractDriverValues(rows, kpi);
    case 'mna':
      return extractMnaValues(rows, kpi, hubCity);
    case 'incidentes':
      return [];
    default:
      return [];
  }
}
function extractOperatorValues(
  rows: { upload: UploadRef; data: Record<string, unknown> }[],
  kpi: Kpi
): EntityValue[] {
  const out: EntityValue[] = [];
  for (const r of rows) {
    const opId = String(r.data['operator_id'] ?? '');
    // Use human-readable name for entity_key; fall back to operator_id if missing.
    const opName = String(r.data['assembler'] ?? '').trim() || opId;
    const hubName = String(r.data['geofence'] ?? '').trim();
    const hubId = hubNameToId(hubName);
    const numField = kpi.numerator_field ?? '';
    const denField = kpi.denominator_field;
    const numerator = numField ? toNum(r.data[numField]) : NaN;
    const denominator = denField ? toNum(r.data[denField]) : 1;
    if (!Number.isFinite(numerator)) continue;
    out.push({
      entity_type: 'operator',
      entity_key: opName,
      city: r.upload.city ?? null,
      hub_id: hubId ?? r.upload.hub_id ?? null,
      numerator,
      denominator: Number.isFinite(denominator) && denominator > 0 ? denominator : 1,
    });
  }
  return out;
}
function extractDriverValues(
  rows: { upload: UploadRef; data: Record<string, unknown> }[],
  kpi: Kpi
): EntityValue[] {
  const out: EntityValue[] = [];
  for (const r of rows) {
    const drvId = String(r.data['driver_id'] ?? '');
    // Use human-readable name; prefer driver_name, then driver_nickname, then driver_id.
    const drvName =
      String(r.data['driver_name'] ?? '').trim() ||
      String(r.data['driver_nickname'] ?? '').trim() ||
      drvId;
    const hubName = String(r.data['hub'] ?? '').trim();
    const hubId = hubNameToId(hubName);
    if (!hubId) continue; // CH or excluded driver
    const numField = kpi.numerator_field ?? '';
    const denField = kpi.denominator_field;
    const numerator = numField ? toNum(r.data[numField]) : NaN;
    const denominator = denField ? toNum(r.data[denField]) : 1;
    if (!Number.isFinite(numerator)) continue;
    out.push({
      entity_type: 'driver',
      entity_key: drvName,
      city: r.upload.city ?? null,
      hub_id: hubId,
      numerator,
      denominator: Number.isFinite(denominator) && denominator > 0 ? denominator : 1,
    });
  }
  return out;
}
function extractMnaValues(
  rows: { upload: UploadRef; data: Record<string, unknown> }[],
  kpi: Kpi,
  hubCity: Map<string, City>
): EntityValue[] {
  // Child MNA KPI (e.g. mna_monto) — compute absolute $ amount per SKU.
  // The parent_kpi_id guard that was here previously returned [] for all children;
  // we now route child MNA KPIs to their own extractor.
  if (kpi.parent_kpi_id) {
    return extractMnaAmountValues(rows, hubCity);
  }
  // Parent MNA % KPI — compute weighted-average MNA % per product.
  const out: EntityValue[] = [];
  for (const r of rows) {
    const producto = String(r.data['Producto'] ?? '').trim();
    const hubId = r.upload.hub_id;
    if (!producto || !hubId) continue;
    const mnaPct  = toNum(r.data['MNA (%)']);
    const recibido = toNum(r.data['Recibido']);
    if (!Number.isFinite(mnaPct) || !Number.isFinite(recibido) || recibido <= 0) continue;
    out.push({
      entity_type: 'sku',
      entity_key: producto,
      city: hubCity.get(hubId) ?? null,
      hub_id: hubId,
      numerator: mnaPct * recibido,
      denominator: recibido,
    });
  }
  return out;
}

/**
 * MNA $ per product — used by child MNA KPIs (e.g. mna_monto).
 *
 * Stores the raw peso amount lost per product. entity_key = 'Producto'
 * (same as the parent % KPI so the two lists on the tile flip are aligned
 * by product name).  denominator=1 so ratio() returns the amount directly.
 */
function extractMnaAmountValues(
  rows: { upload: UploadRef; data: Record<string, unknown> }[],
  hubCity: Map<string, City>
): EntityValue[] {
  const out: EntityValue[] = [];
  for (const r of rows) {
    const producto = String(r.data['Producto'] ?? '').trim();
    const hubId = r.upload.hub_id;
    if (!producto || !hubId) continue;
    const amount = toNum(r.data['MNA ($)']);
    if (!Number.isFinite(amount) || amount < 0) continue;
    out.push({
      entity_type: 'sku',
      entity_key: producto,
      city: hubCity.get(hubId) ?? null,
      hub_id: hubId,
      numerator: amount,
      denominator: 1,
    });
  }
  return out;
}

/**
 * Faltantes armador % — HUB-LEVEL snapshot values.
 *
 * Used by aggregateAllScopes to produce kpi_snapshots at hub/city/global scope,
 * which drives the KPI tile front face (value, sparkline, WoW delta).
 *
 * Numerator:   count of faltante events from the faltantes_armador event log
 * Denominator: total num_assembled across all operators for that hub
 *              (from desempeno_operadores)
 */
function computeFaltantesArmadorPct(
  rowsByApp: Map<string, { upload: UploadRef; data: Record<string, unknown> }[]>,
  hubCity: Map<string, City>
): EntityValue[] {
  const events    = rowsByApp.get('faltantes_armador') ?? [];
  const operadores = rowsByApp.get('desempeno_operadores') ?? [];
  const numByHub = new Map<string, number>();
  for (const e of events) {
    const hubName = String(e.data['Hub'] ?? '').trim();
    const hubId = hubNameToId(hubName);
    if (!hubId) continue;
    numByHub.set(hubId, (numByHub.get(hubId) ?? 0) + 1);
  }
  const denByHub = new Map<string, number>();
  for (const o of operadores) {
    const hubName = String(o.data['geofence'] ?? '').trim();
    const hubId = hubNameToId(hubName);
    if (!hubId) continue;
    const assembled = toNum(o.data['num_assembled']);
    if (!Number.isFinite(assembled)) continue;
    denByHub.set(hubId, (denByHub.get(hubId) ?? 0) + assembled);
  }
  const out: EntityValue[] = [];
  for (const [hubId, denominator] of denByHub) {
    const numerator = numByHub.get(hubId) ?? 0;
    out.push({
      entity_type: 'hub',
      entity_key: hubId,
      city: hubCity.get(hubId) ?? null,
      hub_id: hubId,
      numerator,
      denominator: denominator > 0 ? denominator : 1,
    });
  }
  return out;
}

/**
 * Faltantes armador % — OPERATOR-LEVEL peer values.
 *
 * Used by computePeersForKpi to produce peer_comparisons at within_hub /
 * within_city / global scope, which drives the KPI tile flip (per-assembler
 * ranking, worst → best).
 *
 * Numerator:   num_orders_with_faltante_armador per assembler row
 * Denominator: num_assembled per assembler row
 *
 * Operators with num_assembled = 0 are skipped (no exposure this week).
 */
function computeFaltantesArmadorPeerValues(
  rowsByApp: Map<string, { upload: UploadRef; data: Record<string, unknown> }[]>,
  hubCity: Map<string, City>
): EntityValue[] {
  const operadores = rowsByApp.get('desempeno_operadores') ?? [];
  const out: EntityValue[] = [];
  for (const o of operadores) {
    const opName = String(o.data['assembler'] ?? '').trim();
    const hubName = String(o.data['geofence'] ?? '').trim();
    const hubId = hubNameToId(hubName);
    if (!opName || !hubId) continue;
    const numerator  = toNum(o.data['num_orders_with_faltante_armador']);
    const denominator = toNum(o.data['num_assembled']);
    // Skip operators with no assembled orders — rate is undefined.
    if (!Number.isFinite(denominator) || denominator <= 0) continue;
    // numerator=0 is valid (zero faltantes = best possible score).
    if (!Number.isFinite(numerator)) continue;
    out.push({
      entity_type: 'operator',
      entity_key: opName,
      city: o.upload.city ?? null,
      hub_id: hubId,
      numerator,
      denominator,
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Aggregation: entity → hub → city → global
// ----------------------------------------------------------------------------
function aggregateAllScopes(kpi: Kpi, values: EntityValue[], weekStart: string): Snapshot[] {
  const snapshots: Snapshot[] = [];
  const isAlreadyHubLevel = values.length > 0 && values[0].entity_type === 'hub';
  if (!isAlreadyHubLevel) {
    const seen = new Set<string>();
    for (const v of values) {
      if (v.entity_type === 'sku') continue;
      const scopeLevel = v.entity_type === 'driver' ? 'driver' : 'operator';
      const scopeKey = v.entity_key;
      const dedupeKey = `${scopeLevel}|${scopeKey}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      snapshots.push({
        kpi_id: kpi.id,
        week_start: weekStart,
        scope_level: scopeLevel,
        scope_key: scopeKey,
        value: ratio(v.numerator, v.denominator, kpi),
        numerator: v.numerator,
        denominator: v.denominator,
      });
    }
  }
  // Hub-level
  const byHub = groupBy(values, (v) => v.hub_id ?? '_unassigned');
  for (const [hubId, vs] of byHub) {
    if (hubId === '_unassigned') continue;
    const num = sum(vs, (v) => v.numerator);
    const den = sum(vs, (v) => v.denominator);
    snapshots.push({
      kpi_id: kpi.id,
      week_start: weekStart,
      scope_level: 'hub',
      scope_key: hubId,
      value: ratio(num, den, kpi),
      numerator: num,
      denominator: den,
    });
  }
  // City-level
  const byCity = groupBy(values, (v) => v.city ?? '_unassigned');
  for (const [city, vs] of byCity) {
    if (city === '_unassigned') continue;
    const num = sum(vs, (v) => v.numerator);
    const den = sum(vs, (v) => v.denominator);
    snapshots.push({
      kpi_id: kpi.id,
      week_start: weekStart,
      scope_level: 'city',
      scope_key: city,
      value: ratio(num, den, kpi),
      numerator: num,
      denominator: den,
    });
  }
  // Global
  const num = sum(values, (v) => v.numerator);
  const den = sum(values, (v) => v.denominator);
  snapshots.push({
    kpi_id: kpi.id,
    week_start: weekStart,
    scope_level: 'global',
    scope_key: null,
    value: ratio(num, den, kpi),
    numerator: num,
    denominator: den,
  });
  return snapshots;
}
function ratio(numerator: number, denominator: number, kpi: Kpi): number | null {
  if (kpi.unit === 'count' || kpi.unit === 'currency') {
    return numerator;
  }
  if (kpi.unit === 'rate') {
    if (denominator <= 0) return null;
    return numerator / denominator;
  }
  if (denominator <= 0) return null;
  return numerator / denominator;
}
// ----------------------------------------------------------------------------
// Enrichment: prev_week_value + rolling 4-week mean/std
// ----------------------------------------------------------------------------
async function enrichWithHistory(sb: SB, snapshots: Snapshot[], weekStart: string): Promise<any[]> {
  if (snapshots.length === 0) return [];
  const since = new Date(weekStart);
  since.setDate(since.getDate() - 7 * 5);
  const sinceIso = since.toISOString().slice(0, 10);
  const kpiIds = [...new Set(snapshots.map((s) => s.kpi_id))];
  const { data: history } = await sb
    .from('kpi_snapshots')
    .select('kpi_id, week_start, scope_level, scope_key, value')
    .in('kpi_id', kpiIds)
    .gte('week_start', sinceIso)
    .lt('week_start', weekStart);
  const histMap = new Map<string, { week_start: string; value: number | null }[]>();
  for (const h of history ?? []) {
    const k = `${h.kpi_id}|${h.scope_level}|${h.scope_key ?? ''}`;
    if (!histMap.has(k)) histMap.set(k, []);
    histMap.get(k)!.push({ week_start: h.week_start as string, value: h.value as number | null });
  }
  return snapshots.map((s) => {
    const k = `${s.kpi_id}|${s.scope_level}|${s.scope_key ?? ''}`;
    const past = (histMap.get(k) ?? []).sort((a, b) => b.week_start.localeCompare(a.week_start));
    const prevWeek = past[0]?.value ?? null;
    const last4 = past.slice(0, 4).map((p) => p.value).filter((v): v is number => typeof v === 'number');
    const rollingMean = last4.length > 0 ? sum(last4, (x) => x) / last4.length : null;
    const rollingStd =
      last4.length > 1
        ? Math.sqrt(sum(last4, (x) => Math.pow(x - (rollingMean ?? 0), 2)) / (last4.length - 1))
        : null;
    return { ...s, prev_week_value: prevWeek, rolling_mean_4w: rollingMean, rolling_std_4w: rollingStd };
  });
}
// ----------------------------------------------------------------------------
// Peer comparisons (z-scores)
// ----------------------------------------------------------------------------
function computePeersForKpi(
  kpi: Kpi,
  values: EntityValue[],
  weekStart: string,
  hubCity: Map<string, City>
): any[] {
  if (values.length === 0) return [];
  // NOTE: SKU entity types ARE now included — they generate within_hub peer
  // rows that power the MNA tile flip. The early-return guard that was here
  // previously was a bug; the SKU scope logic below was always correct.
  const points = values
    .map((v) => ({ ...v, value: ratio(v.numerator, v.denominator, kpi) }))
    .filter((p): p is EntityValue & { value: number } => typeof p.value === 'number');
  if (points.length < 2) return [];
  const entityType = points[0].entity_type;
  type Scope = { type: 'within_hub' | 'within_city' | 'global'; getKey: (p: typeof points[number]) => string | null };
  const scopes: Scope[] = [];
  if (entityType === 'hub') {
    scopes.push({ type: 'within_city', getKey: (p) => p.city ?? null });
    scopes.push({ type: 'global', getKey: () => 'global' });
  } else if (entityType === 'sku') {
    // SKUs are ranked within each hub only.
    // Global scope is intentionally excluded: the same SKU can appear in
    // multiple hubs, creating duplicate (entity_key, scope_type=global, scope_key=null)
    // rows that would collide on upsert.
    scopes.push({ type: 'within_hub', getKey: (p) => p.hub_id ?? null });
  } else {
    // operator | driver
    scopes.push({ type: 'within_hub', getKey: (p) => p.hub_id ?? null });
    scopes.push({ type: 'within_city', getKey: (p) => p.city ?? null });
    scopes.push({ type: 'global', getKey: () => 'global' });
  }
  const out: any[] = [];
  for (const scope of scopes) {
    const buckets = new Map<string, typeof points>();
    for (const p of points) {
      const k = scope.getKey(p);
      if (!k) continue;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(p);
    }
    for (const [scopeKey, group] of buckets) {
      if (group.length < 2) continue;
      const vals = group.map((g) => g.value);
      const mean = sum(vals, (x) => x) / vals.length;
      const std = Math.sqrt(sum(vals, (x) => Math.pow(x - mean, 2)) / (vals.length - 1));
      const sorted = [...vals].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length / 2)];
      const p90 = sorted[Math.floor(sorted.length * 0.9)];
      const dir = kpi.direction;
      const ranked = [...group].sort((a, b) =>
        dir === 'lower_is_better' ? a.value - b.value : b.value - a.value
      );
      const rankByKey = new Map<string, number>();
      ranked.forEach((g, i) => rankByKey.set(g.entity_key, i + 1));
      for (const g of group) {
        out.push({
          kpi_id: kpi.id,
          week_start: weekStart,
          entity_type: entityType,
          entity_key: g.entity_key,
          hub_id: g.hub_id ?? null,
          scope_type: scope.type,
          scope_key: scope.type === 'global' ? null : scopeKey,
          value: g.value,
          peer_mean: mean,
          peer_p50: p50,
          peer_p90: p90,
          z_score: std > 0 ? (g.value - mean) / std : null,
          rank: rankByKey.get(g.entity_key) ?? null,
          rank_total: group.length,
        });
      }
    }
  }
  return out;
}
// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Upsert `rows` into `table` in parallel 1 000-row batches.
 * All batches are dispatched at once via Promise.all; if any batch errors
 * the whole call rejects immediately.  Returns total rows written.
 */
async function parallelUpsert(
  sb: SB,
  table: 'kpi_snapshots' | 'peer_comparisons',
  rows: any[],
  onConflict: string
): Promise<number> {
  if (rows.length === 0) return 0;
  const BATCH = 1000;
  const batches: any[][] = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    batches.push(rows.slice(i, i + BATCH));
  }
  await Promise.all(
    batches.map(async (batch) => {
      const { error } = await sb.from(table).upsert(batch, { onConflict });
      if (error) throw error;
    })
  );
  return rows.length;
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return NaN;
}
function sum<T>(arr: T[], f: (t: T) => number): number {
  let s = 0;
  for (const x of arr) s += f(x);
  return s;
}
function groupBy<T, K>(arr: T[], f: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of arr) {
    const k = f(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
}
/**
 * Map a geofence/hub string from any CSV to a canonical hub slug.
 *
 * Handles both prefixed ("MH Avícola") and bare ("Avícola") forms — the
 * per_city CSVs for single-hub cities (Saltillo, GDL, CDMX) often omit the
 * "MH " prefix since there is only one hub in that city.
 * CH Guadalupe is always excluded (returns null).
 */
const HUB_ALIAS_MAP: Record<string, string> = {
  // Monterrey
  'mh_contry':      'mh_contry',
  'contry':         'mh_contry',
  'mh_cumbres':     'mh_cumbres',
  'cumbres':        'mh_cumbres',
  'mh_san_nicolas': 'mh_san_nicolas',
  'san_nicolas':    'mh_san_nicolas',
  'mh_guadalupe':   'mh_guadalupe',
  'guadalupe':      'mh_guadalupe',
  // Saltillo — Retool labels by city name since there's only one hub
  'mh_avicola':     'mh_avicola',
  'avicola':        'mh_avicola',
  'mh_saltillo':    'mh_avicola',
  'saltillo':       'mh_avicola',
  // Guadalajara
  'mh_zapopan':     'mh_zapopan',
  'zapopan':        'mh_zapopan',
  // CDMX
  'mh_condesa':     'mh_condesa',
  'condesa':        'mh_condesa',
};
function hubNameToId(name: string): string | null {
  if (!name) return null;
  const cleaned = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_');
  if (cleaned.startsWith('ch_')) return null; // CH Guadalupe excluded
  return HUB_ALIAS_MAP[cleaned] ?? null;
}
