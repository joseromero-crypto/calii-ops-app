/**
 * BUILD.md Phase 1 — flatten `desempeno_repartidores.orders_data` (a JSON
 * blob per driver-week, role='ignored' in app_columns) into `order_deliveries`,
 * one row per delivered order. Field spec: DATA_DICTIONARY.md
 * `desempeno_repartidores` → `orders_data`.
 *
 * Called per upload_id (never across uploads — HANDOFF §12: one upload_id at
 * a time, sequential batches) from app/api/upload/route.ts after validation,
 * and from scripts/backfill-order-deliveries.ts for existing weeks.
 */
import { createAdminSupabase } from '../supabase-server';
import { resolveHubId } from '../hub-aliases';

type SB = ReturnType<typeof createAdminSupabase>;

interface OrderDeliveryRow {
  upload_id: string;
  week_start: string;
  hub_id: string;
  driver_name: string;
  user_name: string | null;
  delivered_at: string | null;
  window_start: string;
  window_label: string;
  minutes_late: number | null;
}

export interface FlattenResult {
  upload_id: string;
  driver_week_rows: number;     // desempeno_repartidores rows read
  orders_seen: number;          // total orders_data[] entries across those rows
  rows_written: number;         // order_deliveries rows actually inserted
  skipped_no_hub: number;       // orders belonging to a row whose `hub` didn't resolve
  skipped_bad_entry: number;    // individual orders_data entries missing window fields
}

const toIsoOrNull = (raw: unknown): string | null => {
  if (raw == null || raw === '') return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const toNumOrNull = (raw: unknown): number | null => {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * Flatten one desempeno_repartidores upload's orders_data into
 * order_deliveries. Idempotent — deletes any existing rows for this
 * upload_id first, so it's safe to re-run (backfill re-runs, retries).
 */
export async function flattenOrderDeliveries(sb: SB, uploadId: string): Promise<FlattenResult> {
  const { data: upload, error: upErr } = await sb
    .from('uploads')
    .select('id, app_id, week_start')
    .eq('id', uploadId)
    .single();
  if (upErr) throw upErr;
  if (!upload) throw new Error(`order-deliveries: upload ${uploadId} not found`);
  if (upload.app_id !== 'desempeno_repartidores') {
    throw new Error(`order-deliveries: upload ${uploadId} is app_id=${upload.app_id}, expected desempeno_repartidores`);
  }

  // One upload_id at a time — a single-value index scan, no ORDER BY, no cap
  // risk (HANDOFF §12 / kpi-compute.ts's own comment on the same pattern).
  const { data: rawRows, error: rowsErr } = await sb
    .from('upload_rows')
    .select('data')
    .eq('upload_id', uploadId)
    .eq('is_excluded', false)
    .limit(10_000);
  if (rowsErr) throw rowsErr;

  const out: OrderDeliveryRow[] = [];
  let ordersSeen = 0;
  let skippedNoHub = 0;
  let skippedBadEntry = 0;

  for (const r of rawRows ?? []) {
    const d = (r as { data: Record<string, unknown> }).data ?? {};
    const driverName = String(d['driver_name'] ?? '').trim();
    const orders = Array.isArray(d['orders_data']) ? (d['orders_data'] as Record<string, unknown>[]) : [];
    if (!driverName || orders.length === 0) continue;

    // hub_id comes from the parent row's `hub` column, never from the blob
    // (DATA_DICTIONARY.md / BUILD.md "Watch for").
    const hubId = resolveHubId(String(d['hub'] ?? ''));
    ordersSeen += orders.length;
    if (!hubId) {
      skippedNoHub += orders.length;
      continue;
    }

    for (const entry of orders) {
      if (!entry || typeof entry !== 'object') { skippedBadEntry++; continue; }

      const windowStart = toIsoOrNull(entry['delivery_window_start_date_time']);
      const windowLabel = entry['delivery_window_time'] != null ? String(entry['delivery_window_time']) : null;
      // window_start/window_label are 100% filled per the audit — an entry
      // missing either is malformed, not a legitimate "no window" case.
      if (!windowStart || !windowLabel) { skippedBadEntry++; continue; }

      out.push({
        upload_id: uploadId,
        week_start: upload.week_start,
        hub_id: hubId,
        driver_name: driverName,
        user_name: entry['user_name'] != null ? String(entry['user_name']) : null,
        // delivered_at is 98% filled — 2% null is expected, never assumed present.
        delivered_at: toIsoOrNull(entry['delivered_at']),
        window_start: windowStart,
        window_label: windowLabel,
        // signed — negative is early. ignore delivery_date_str (Spanish
        // display string, e.g. "Ago-7") entirely; it's not parsed anywhere.
        minutes_late: toNumOrNull(entry['minutes_delivered_late_or_early']),
      });
    }
  }

  const { error: delErr } = await sb.from('order_deliveries').delete().eq('upload_id', uploadId);
  if (delErr) throw delErr;

  const BATCH = 200;
  let written = 0;
  for (let i = 0; i < out.length; i += BATCH) {
    const batch = out.slice(i, i + BATCH);
    const { error } = await sb.from('order_deliveries').insert(batch);
    if (error) throw error;
    written += batch.length;
  }

  return {
    upload_id: uploadId,
    driver_week_rows: (rawRows ?? []).length,
    orders_seen: ordersSeen,
    rows_written: written,
    skipped_no_hub: skippedNoHub,
    skipped_bad_entry: skippedBadEntry,
  };
}
