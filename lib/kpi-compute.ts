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
import { classifyMnaProduct } from './sku-classifier';
import type { MnaCategory } from './sku-classifier';
import type { Kpi, City } from './types';
import { resolveHubId } from './hub-aliases';

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

  // Fetch all rows for this week's uploads, one upload at a time.
  //
  // Why not a single paginated query with ORDER BY id?
  //   ORDER BY id on rows filtered by IN (N upload_ids) forces PostgreSQL to
  //   collect and sort ALL matching rows before paginating. This cost grows with
  //   the total size of upload_rows and eventually hits the statement timeout.
  //
  // Why not a single unordered query for all uploads?
  //   PostgREST caps unranged responses at max_rows (default 1 000). Without
  //   an explicit range we silently get only the first 1 000 rows across all
  //   uploads — wrong for weeks with many CSVs.
  //
  // Solution: one query per upload_id. Each query is a single-value index scan
  //   on upload_rows(upload_id) — O(rows for that upload), no sort, no cap
  //   (limit is generous at 10 000 which is far above any realistic single-file
  //   row count). 25 uploads × ~50–200 ms each stays comfortably within budget.
  const rowsByApp = new Map<string, { upload: UploadRef; data: Record<string, unknown> }[]>();
  for (const u of uploads) {
    const { data: rows, error } = await sb
      .from('upload_rows')
      .select('upload_id, data')
      .eq('upload_id', u.id)
      .eq('is_excluded', false)
      .limit(10_000);
    if (error) throw error;
    for (const r of (rows ?? []) as RawRow[]) {
      if (!rowsByApp.has(u.app_id)) rowsByApp.set(u.app_id, []);
      rowsByApp.get(u.app_id)!.push({ upload: u, data: r.data });
    }
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

      // faltantes_armador_pct: hub snapshots come from the Retool hub % export;
      //   peer_comparisons still use per-assembler data from desempeno_operadores
      //   so the tile flip continues to show the assembler ranking.
      //
      // faltantes_fyv/carnes/graneles_pct: hub snapshots from their respective
      //   Retool exports; no peer_comparisons — tile flip shows top SKUs from
      //   the breakdown upload, aggregated in page.tsx (same pattern as MNA).
      const peerValues =
        kpi.id === 'faltantes_armador_pct'
          ? computeFaltantesArmadorPeerValues(rowsByApp, hubCity)
          : FALTANTES_SKU_KPI_IDS.has(kpi.id)
          ? []
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

  // Deduplicate both arrays on their respective conflict keys before upserting.
  //
  // Duplicates can arise from:
  //   a) Multiple upload records for the same (app, week, hub) slot — a known
  //      edge case that the upload route now prevents but may exist in older data.
  //   b) Same-named drivers across different hubs colliding on the global scope
  //      (entity_key × scope_type='global' × scope_key=null).
  //
  // PostgreSQL raises "ON CONFLICT DO UPDATE command cannot affect row a second
  // time" when two rows in the same batch share the same conflict key.
  function dedupByKey<T extends Record<string, unknown>>(rows: T[], key: (r: T) => string): T[] {
    const seen = new Set<string>();
    return rows.filter((r) => {
      const k = key(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  const dedupedSnapshots = dedupByKey(
    enriched,
    (r) => `${r.kpi_id}|${r.week_start}|${r.scope_level}|${r.scope_key ?? '__null__'}`
  );
  const dedupedPeers = dedupByKey(
    allPeers,
    (r) => `${r.kpi_id}|${r.week_start}|${r.entity_type}|${r.entity_key}|${r.scope_type}|${r.scope_key ?? '__null__'}`
  );

  // Upsert tables sequentially to avoid concurrent write pressure that can
  // trigger Supabase statement timeouts when batch counts are large.
  const snapshotsWritten = await parallelUpsert(sb, 'kpi_snapshots', dedupedSnapshots, 'kpi_id,week_start,scope_level,scope_key');
  const peersWritten     = await parallelUpsert(sb, 'peer_comparisons', dedupedPeers, 'kpi_id,week_start,entity_type,entity_key,scope_type,scope_key');

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
  // Hub-level faltantes % KPIs — value is read directly from the Retool hub %
  // export rather than computed. The source_app_id on the KPI registry row tells
  // us which upload to read for each variant (general / fyv / carnes / graneles).
  if (FALTANTES_HUB_PCT_KPI_IDS.has(kpi.id)) {
    return extractFaltantesHubPctDirect(kpi.source_app_id ?? '', rowsByApp, hubCity);
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
      return extractIncidentesValues(rows, rowsByApp, hubCity);
    case 'discrepancia':
      return extractDiscrepanciaValues(rows, hubCity);
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
    const opId   = String(r.data['operator_id'] ?? '');
    // Use human-readable name for entity_key; fall back to operator_id if missing.
    const opName = String(r.data['assembler'] ?? '').trim() || opId;
    const hubName = String(r.data['geofence'] ?? '').trim();
    const hubId   = hubNameToId(hubName);
    const numField = kpi.numerator_field ?? '';
    const denField = kpi.denominator_field;
    const rawNumerator   = numField ? toNum(r.data[numField]) : NaN;
    const rawDenominator = denField ? toNum(r.data[denField]) : 1;
    if (!Number.isFinite(rawNumerator)) continue;
    const denominator = Number.isFinite(rawDenominator) && rawDenominator > 0 ? rawDenominator : 1;
    // CSV stores pre-computed percentages (0–100) for pct KPIs that have no
    // separate denominator field. Normalise to 0–1 so the display layer's
    // ×100 produces the correct value.
    const numerator = (kpi.unit === 'pct' && !kpi.denominator_field)
      ? rawNumerator / 100
      : rawNumerator;
    out.push({
      entity_type: 'operator',
      entity_key: opName,
      city: r.upload.city ?? null,
      hub_id: hubId ?? r.upload.hub_id ?? null,
      numerator,
      denominator,
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
    const drvId   = String(r.data['driver_id'] ?? '');
    // Use human-readable name; prefer driver_name, then driver_nickname, then driver_id.
    const drvName =
      String(r.data['driver_name']     ?? '').trim() ||
      String(r.data['driver_nickname'] ?? '').trim() ||
      drvId;
    const hubName = String(r.data['hub'] ?? '').trim();
    const hubId   = hubNameToId(hubName);
    if (!hubId) continue; // CH or excluded driver
    const numField = kpi.numerator_field ?? '';
    const denField = kpi.denominator_field;
    const rawNumerator   = numField ? toNum(r.data[numField]) : NaN;
    const rawDenominator = denField ? toNum(r.data[denField]) : 1;
    if (!Number.isFinite(rawNumerator)) continue;
    const denominator = Number.isFinite(rawDenominator) && rawDenominator > 0 ? rawDenominator : 1;
    // Same pct normalisation as extractOperatorValues.
    const numerator = (kpi.unit === 'pct' && !kpi.denominator_field)
      ? rawNumerator / 100
      : rawNumerator;
    out.push({
      entity_type: 'driver',
      entity_key: drvName,
      city: r.upload.city ?? null,
      hub_id: hubId,
      numerator,
      denominator,
    });
  }
  return out;
}

function extractMnaValues(
  rows: { upload: UploadRef; data: Record<string, unknown> }[],
  kpi: Kpi,
  hubCity: Map<string, City>
): EntityValue[] {
  // Category filter for subdivision KPIs.
  //
  // NOTE: "carnes" in Calii's taxonomy means REFRIGERATED/COLD-CHAIN (not just
  // meat). "abarrotes" is shelf-stable / dry goods and corresponds to the
  // mna_graneles_pct KPI. Classification is supplier-first via classifyMnaProduct.
  const catFilter: MnaCategory | null =
    kpi.id === 'mna_fyv_pct'      ? 'fyv'       :
    kpi.id === 'mna_carnes_pct'   ? 'carnes'    :
    kpi.id === 'mna_graneles_pct' ? 'abarrotes' :
    null; // mna_pct: all rows, no filter

  const out: EntityValue[] = [];

  for (const r of rows) {
    const producto  = String(r.data['Producto']  ?? '').trim();
    const proveedor = String(r.data['Proveedor'] ?? '').trim();

    // Hub resolution: prefer upload.hub_id; fall back to row-level Hub/geofence column.
    // Mirrors page.tsx logic — MNA uploads uploaded at city level have hub_id = null
    // on the uploads row, so the hub must be read from the row data instead.
    const rawHubRef =
      r.upload.hub_id ||
      String(r.data['Hub'] ?? r.data['geofence'] ?? r.data['Geofence'] ?? '').trim() ||
      null;
    const hubId = rawHubRef ? (hubNameToId(rawHubRef) ?? null) : null;
    if (!producto || !hubId) continue;

    // Apply category filter for subdivision KPIs.
    if (catFilter !== null) {
      const category = classifyMnaProduct(producto, proveedor);
      if (category !== catFilter) continue;
    }

    // Monetary formula: MNA($) / (MNA($) + Recibido × Source price)
    //
    // Aggregation identity: sum(MNA$_i) / sum(MNA$_i + Rev_i)
    //                     = sum(MNA$_i) / (sum(MNA$_i) + sum(Rev_i))
    //
    // Write-off rows (Recibido=0, MNA$>0): revenue=0, so their waste is
    // fully counted in both numerator and denominator — correct behaviour.
    // Inactive rows (MNA$=0, Recibido=0): throughput=0, skipped below.
    const mna$      = Number.isFinite(toNum(r.data['MNA ($)']))      ? toNum(r.data['MNA ($)'])      : 0;
    const rec       = Number.isFinite(toNum(r.data['Recibido']))      ? toNum(r.data['Recibido'])      : 0;
    const sp        = Number.isFinite(toNum(r.data['Source price']))  ? toNum(r.data['Source price'])  : 0;
    const revenue    = rec * sp;
    const throughput = mna$ + revenue; // denominator

    // Skip rows with zero monetary throughput (no waste, no sales)
    if (throughput <= 0) continue;

    out.push({
      entity_type: 'sku',
      entity_key:  producto,
      city:        hubCity.get(hubId) ?? null,
      hub_id:      hubId,
      numerator:   mna$,        // monetary waste: MNA($)
      denominator: throughput,  // monetary throughput: MNA($) + Recibido × Source price
    });
  }
  return out;
}

/**
 * Incidentes — DRIVER-LEVEL incident count.
 *
 * Counts delivery-related incidents per driver, excluding entries registered
 * by the ops monitor account (robertott@calii.com). A row is considered
 * delivery-related when its Notas column contains an order-reference code
 * (e.g. "79-E6-2") or the words "entrega" / "entregado".
 *
 * Because the incidentes CSV has no geofence column, driver hub/city
 * assignments are resolved by cross-referencing the Operador name against
 * the desempeno_repartidores rows already in memory.
 */
function extractIncidentesValues(
  rows: { upload: UploadRef; data: Record<string, unknown> }[],
  rowsByApp: Map<string, { upload: UploadRef; data: Record<string, unknown> }[]>,
  hubCity: Map<string, City>
): EntityValue[] {
  // Build driver name (lowercase) → { hub_id, city, originalName } from repartidores rows.
  // originalName is stored so we can add zero-incident entries for roster drivers
  // who don't appear in the incidentes file at all.
  const driverHub = new Map<string, { hub_id: string; city: City | null; originalName: string }>();
  for (const r of rowsByApp.get('desempeno_repartidores') ?? []) {
    const originalName = (
      String(r.data['driver_name']     ?? '').trim() ||
      String(r.data['driver_nickname'] ?? '').trim()
    );
    const name = originalName.toLowerCase();
    const hubName = String(r.data['hub'] ?? '').trim();
    const hubId   = hubNameToId(hubName);
    if (name && hubId) {
      driverHub.set(name, { hub_id: hubId, city: r.upload.city ?? null, originalName });
    }
  }

  // Order-reference codes like "79-E6-2" (at least two hyphen/en-dash separators).
  const ORDER_CODE_RE = /\d[\w]*[-–]\w+[-–]\w+/;
  // Words "entrega" or "entregado/a" (whole-word, case-insensitive).
  const DELIVERY_RE   = /\bentregad?[ao]?\b/i;

  // Accumulate one entry per driver (keyed by canonical name) so that a driver
  // with multiple qualifying incidents contributes a single EntityValue with
  // numerator = their total count. Without this, the same driver appears N
  // times in computePeersForKpi and aggregateAllScopes, producing wrong z-scores
  // and hub totals.
  const byDriver = new Map<string, EntityValue>();

  for (const r of rows) {
    // Exclude entries logged by the ops monitor account.
    const responsable = String(r.data['Responsable'] ?? '').trim().toLowerCase();
    if (responsable === 'robertott@calii.com') continue;

    // Only count delivery-related incidents.
    const notas = String(r.data['Notas'] ?? '');
    if (!ORDER_CODE_RE.test(notas) && !DELIVERY_RE.test(notas)) continue;

    const opName = String(r.data['Operador'] ?? '').trim();
    if (!opName) continue;

    // Resolve hub via repartidores cross-reference.
    const info = driverHub.get(opName.toLowerCase());
    if (!info) continue; // driver not in this week's repartidores upload

    const existing = byDriver.get(opName);
    if (existing) {
      existing.numerator += 1;
    } else {
      byDriver.set(opName, {
        entity_type: 'driver',
        entity_key: opName,
        city: info.city,
        hub_id: info.hub_id,
        numerator: 1,
        denominator: 1,
      });
    }
  }

  // Fill in zero-incident entries for every driver on this week's repartidores
  // roster who had no qualifying incidents. This ensures the WoW chart shows all
  // active drivers, not only those who had errors — matching the user expectation
  // that the roster defines who is graphed, incidents just determine their count.
  for (const [, info] of driverHub) {
    if (!byDriver.has(info.originalName)) {
      byDriver.set(info.originalName, {
        entity_type: 'driver',
        entity_key:  info.originalName,
        city:        info.city,
        hub_id:      info.hub_id,
        numerator:   0,
        denominator: 1,
      });
    }
  }

  return Array.from(byDriver.values());
}

/**
 * Discrepancia — DRIVER-LEVEL cash reconciliation shortfall.
 *
 * CSV columns expected:
 *   Repartidor                  → driver display name
 *   Hub                         → hub name (resolved via hubNameToId)
 *   Cálculo digital efectivo    → expected amount (order totals)
 *   Conciliación manual         → actual amount deposited
 *
 * shortfall = expected − deposited  (positive = driver is short, owes money)
 *
 * Hub-level KPI value = Σ shortfalls across all drivers in the hub.
 * KPI direction: lower_is_better (minimise shortfall).
 */
function extractDiscrepanciaValues(
  rows: { upload: UploadRef; data: Record<string, unknown> }[],
  hubCity: Map<string, City>
): EntityValue[] {
  // Accumulate one entry per (driver, hub) pair so a driver with multiple CSV
  // rows (e.g. multiple cash entries in the same hub) contributes a single
  // EntityValue with numerator = their total shortfall. Without this, the same
  // driver appears N times in computePeersForKpi and aggregateAllScopes,
  // producing wrong z-scores and inflated hub totals on the tile flip.
  // Keying by drvName+hubId also handles the rare cross-hub driver correctly:
  // their shortfall is accumulated separately per hub, not merged into one entry.
  const byDriverHub = new Map<string, EntityValue>();

  for (const r of rows) {
    const drvName = String(r.data['Repartidor'] ?? '').trim();
    const hubName = String(r.data['Hub']         ?? '').trim();
    // Hub from row takes precedence; fall back to upload-level hub_id.
    const hubId   = hubNameToId(hubName) ?? r.upload.hub_id ?? null;
    if (!drvName || !hubId) continue;

    // Accept both accented and unaccented variants in case encoding varies.
    const expected  = toNum(
      r.data['Cálculo digital efectivo'] ??
      r.data['Calculo digital efectivo']
    );
    const deposited = toNum(
      r.data['Conciliación manual'] ??
      r.data['Conciliacion manual']
    );
    if (!Number.isFinite(expected) || !Number.isFinite(deposited)) continue;

    // Positive shortfall = driver deposited less than expected.
    const shortfall = expected - deposited;

    const key = `${drvName}|${hubId}`;
    const existing = byDriverHub.get(key);
    if (existing) {
      existing.numerator += shortfall;
    } else {
      byDriverHub.set(key, {
        entity_type: 'driver',
        entity_key:  drvName,
        city:        hubCity.get(hubId) ?? null,
        hub_id:      hubId,
        numerator:   shortfall,
        denominator: 1, // currency KPI — ratio() returns numerator directly
      });
    }
  }

  return Array.from(byDriverHub.values());
}

// KPI IDs that read hub % directly from a Retool export file.
const FALTANTES_HUB_PCT_KPI_IDS = new Set([
  'faltantes_armador_pct',
  'faltantes_fyv_pct',
  'faltantes_carnes_pct',
  'faltantes_graneles_pct',
]);

// Subcategory KPI IDs whose tile flip shows SKU rankings from upload_rows
// (aggregated in page.tsx) rather than peer_comparisons.
const FALTANTES_SKU_KPI_IDS = new Set([
  'faltantes_fyv_pct',
  'faltantes_carnes_pct',
  'faltantes_graneles_pct',
]);

/**
 * Faltantes armador % — HUB-LEVEL snapshot values (direct read).
 *
 * Reads the `Faltante armador (%)` value already computed by Retool from the
 * corresponding hub % upload file. One EntityValue per hub row.
 * numerator = pct value (0–1), denominator = 1 → ratio() returns pct directly.
 *
 * Used for: faltantes_armador_pct, faltantes_fyv_pct,
 *           faltantes_carnes_pct, faltantes_graneles_pct.
 */
function extractFaltantesHubPctDirect(
  appId: string,
  rowsByApp: Map<string, { upload: UploadRef; data: Record<string, unknown> }[]>,
  hubCity: Map<string, City>
): EntityValue[] {
  const rows = rowsByApp.get(appId) ?? [];
  const out: EntityValue[] = [];
  for (const r of rows) {
    const hubName = String(r.data['Hub'] ?? '').trim();
    const hubId   = hubNameToId(hubName);
    if (!hubId) continue;
    const pct = toNum(r.data['Faltante armador (%)']);
    if (!Number.isFinite(pct) || pct < 0) continue;
    out.push({
      entity_type: 'hub',
      entity_key:  hubId,
      city:        hubCity.get(hubId) ?? null,
      hub_id:      hubId,
      numerator:   pct, // already a ratio, e.g. 0.1046 = 10.46 %
      denominator: 1,
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
    const opName  = String(o.data['assembler'] ?? '').trim();
    const hubName = String(o.data['geofence']  ?? '').trim();
    const hubId   = hubNameToId(hubName);
    if (!opName || !hubId) continue;
    const numerator   = toNum(o.data['num_orders_with_faltante_armador']);
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
      const scopeKey   = v.entity_key;
      const dedupeKey  = `${scopeLevel}|${scopeKey}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      snapshots.push({
        kpi_id:      kpi.id,
        week_start:  weekStart,
        scope_level: scopeLevel,
        scope_key:   scopeKey,
        value:       ratio(v.numerator, v.denominator, kpi),
        numerator:   v.numerator,
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
      kpi_id:      kpi.id,
      week_start:  weekStart,
      scope_level: 'hub',
      scope_key:   hubId,
      value:       ratio(num, den, kpi),
      numerator:   num,
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
      kpi_id:      kpi.id,
      week_start:  weekStart,
      scope_level: 'city',
      scope_key:   city,
      value:       ratio(num, den, kpi),
      numerator:   num,
      denominator: den,
    });
  }

  // Global
  //
  // For currency and count KPIs, use the mean of hub totals rather than the
  // raw sum of all entity values:
  //   - currency: sum of all driver shortfalls per hub, then mean across hubs.
  //               Sum-of-all-drivers would be ~N× any individual hub value.
  //   - count:    same problem — sum of all driver error counts globally dwarfs
  //               a single hub's count, making the reference line useless.
  //               Mean-of-hub-totals keeps the global line in the same range as
  //               individual hub lines so the comparison is meaningful.
  //
  // For pct and rate KPIs, keep the standard weighted-sum formula:
  //   global pct  = sum(all numerators) / sum(all denominators)  — correct weighted mean
  //   global rate = sum(orders) / sum(time)                      — correct weighted rate
  if (kpi.unit === 'currency' || kpi.unit === 'count') {
    const hubTotals = [...byHub.entries()]
      .filter(([hubId]) => hubId !== '_unassigned')
      .map(([, vs]) => sum(vs, (v) => v.numerator));
    const globalVal = hubTotals.length > 0
      ? sum(hubTotals, (x) => x) / hubTotals.length
      : null;
    snapshots.push({
      kpi_id:      kpi.id,
      week_start:  weekStart,
      scope_level: 'global',
      scope_key:   null,
      value:       globalVal,
      numerator:   globalVal ?? 0,
      denominator: 1,
    });
  } else {
    const num = sum(values, (v) => v.numerator);
    const den = sum(values, (v) => v.denominator);
    snapshots.push({
      kpi_id:      kpi.id,
      week_start:  weekStart,
      scope_level: 'global',
      scope_key:   null,
      value:       ratio(num, den, kpi),
      numerator:   num,
      denominator: den,
    });
  }

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
    const k    = `${s.kpi_id}|${s.scope_level}|${s.scope_key ?? ''}`;
    const past = (histMap.get(k) ?? []).sort((a, b) => b.week_start.localeCompare(a.week_start));
    const prevWeek    = past[0]?.value ?? null;
    const last4       = past.slice(0, 4).map((p) => p.value).filter((v): v is number => typeof v === 'number');
    const rollingMean = last4.length > 0 ? sum(last4, (x) => x) / last4.length : null;
    const rollingStd  =
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

  // SKU entities (MNA) do NOT produce peer_comparisons rows.
  // Product-level rankings for the tile flip are read directly from upload_rows
  // in page.tsx (MnaProduct[]) — no need to materialise them here.
  if (values[0]?.entity_type === 'sku') return [];

  const points = values
    .map((v) => ({ ...v, value: ratio(v.numerator, v.denominator, kpi) }))
    .filter((p): p is EntityValue & { value: number } => typeof p.value === 'number');

  if (points.length === 0) return [];

  const entityType = points[0].entity_type;

  type Scope = { type: 'within_hub' | 'within_city' | 'global'; getKey: (p: typeof points[number]) => string | null };
  const scopes: Scope[] = [];

  if (entityType === 'hub') {
    scopes.push({ type: 'within_city', getKey: (p) => p.city ?? null });
    scopes.push({ type: 'global',      getKey: () => 'global' });
  } else {
    // operator | driver
    scopes.push({ type: 'within_hub',  getKey: (p) => p.hub_id ?? null });
    scopes.push({ type: 'within_city', getKey: (p) => p.city   ?? null });
    scopes.push({ type: 'global',      getKey: () => 'global' });
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
      if (group.length === 0) continue;
      const vals = group.map((g) => g.value);
      // z-scores require at least 2 entities; single-entity buckets still get
      // a row (rank=1, rank_total=1, z_score=null) so the tile flip shows the
      // driver even when they're the only incident in that hub/city.
      const canRank  = group.length >= 2;
      const mean     = canRank ? sum(vals, (x) => x) / vals.length : null;
      const variance = canRank
        ? sum(vals, (x) => Math.pow(x - mean!, 2)) / (vals.length - 1)
        : null;
      const std      = variance !== null ? Math.sqrt(variance) : null;
      const sorted   = [...vals].sort((a, b) => a - b);
      const p50      = sorted[Math.floor(sorted.length / 2)];
      const p90      = sorted[Math.floor(sorted.length * 0.9)];
      const dir      = kpi.direction;
      const ranked   = [...group].sort((a, b) =>
        dir === 'lower_is_better' ? a.value - b.value : b.value - a.value
      );
      const rankByKey = new Map<string, number>();
      ranked.forEach((g, i) => rankByKey.set(g.entity_key, i + 1));

      for (const g of group) {
        out.push({
          kpi_id:      kpi.id,
          week_start:  weekStart,
          entity_type: entityType,
          entity_key:  g.entity_key,
          hub_id:      g.hub_id ?? null,
          scope_type:  scope.type,
          scope_key:   scope.type === 'global' ? null : scopeKey,
          value:       g.value,
          peer_mean:   mean,
          peer_p50:    p50,
          peer_p90:    p90,
          z_score:     std !== null && std > 0 ? (g.value - mean!) / std : null,
          rank:        rankByKey.get(g.entity_key) ?? null,
          rank_total:  group.length,
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
 * Upsert `rows` into `table` in 200-row sequential batches.
 *
 * Fully sequential (one batch at a time, one table at a time) to keep DB load
 * predictable and avoid statement timeouts caused by concurrent lock contention.
 * 200-row batches stay comfortably under PostgREST's max_rows cap.
 */
async function parallelUpsert(
  sb: SB,
  table: 'kpi_snapshots' | 'peer_comparisons',
  rows: any[],
  onConflict: string
): Promise<number> {
  if (rows.length === 0) return 0;
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await sb.from(table).upsert(batch, { onConflict });
    if (error) throw error;
  }
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
 * Resolve a hub label from any CSV column to the canonical hub_id slug.
 * Delegates to the shared lib/hub-aliases.ts so kpi-compute and page.tsx
 * always use the same map — add new aliases there, not here.
 */
function hubNameToId(name: string): string | null {
  return resolveHubId(name);
}
