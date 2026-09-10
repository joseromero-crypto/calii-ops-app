/**
 * BUILD.md Phase 2 — deliveryLateness, built on Phase 1's `order_deliveries`
 * (the flattened `orders_data` blob, ~97k rows). Exposes BOTH the protocol's
 * own targets (>30 min ≤5%, >60 min ≤1% — Reparto de pedidos, 2025-12-27)
 * AND the newly-discovered fact that the source system's own `num_late_orders`
 * uses a >10-minute cutoff (DATA_DICTIONARY.md, confirmed 7/7 driver-weeks,
 * Phase 1 backfill) — these answer different questions, never collapse them.
 */
import type { SB } from './shared';
import { PAGE_ROWS } from './shared';
import { listWeeks } from './registry';
import type { AnalysisResult, Provenance, Claim } from './types';
import { confirmed, assumed } from './types';

const ROW_CAP = 50_000;

export interface OrderDeliveryRow {
  hub_id: string;
  driver_name: string;
  delivered_at: string | null;
  window_label: string;
  minutes_late: number | null;
}

/** Shared row-fetcher — also used by evidence.ts. Bounded by (hub_id, week_start) index, paginated up to ROW_CAP. */
export async function fetchOrderDeliveries(sb: SB, hub: string | undefined, weeksBack: number): Promise<{ rows: OrderDeliveryRow[]; capped: boolean }> {
  const weeks = await listWeeks(sb, { appId: 'desempeno_repartidores' });
  const window = weeks.slice(-weeksBack);
  if (window.length === 0) return { rows: [], capped: false };

  const rows: OrderDeliveryRow[] = [];
  for (let from = 0; from < ROW_CAP; from += PAGE_ROWS) {
    let q = sb.from('order_deliveries')
      .select('hub_id, driver_name, delivered_at, window_label, minutes_late')
      .gte('week_start', window[0]).lte('week_start', window[window.length - 1]);
    if (hub) q = q.eq('hub_id', hub);
    const { data, error } = await q.range(from, Math.min(from + PAGE_ROWS, ROW_CAP) - 1);
    if (error) throw error;
    const page = (data ?? []) as OrderDeliveryRow[];
    rows.push(...page);
    if (page.length < PAGE_ROWS) break;
  }
  return { rows, capped: rows.length >= ROW_CAP };
}

export interface WindowBucket {
  window_label: string;
  total: number;
  late_gt30: number;
  pct_late_gt30: number;
}

export interface DeliveryLatenessData {
  hub: string | 'network';
  weeks_back: number;
  total_orders: number;
  missing_delivered_at: number;
  early: number;
  late_gt10: number;
  pct_late_gt10: number;
  late_gt30: number;
  pct_late_gt30: number;
  late_gt60: number;
  pct_late_gt60: number;
  by_window: WindowBucket[];
}

export async function deliveryLateness(sb: SB, hub: string | undefined, weeksBack = 12): Promise<AnalysisResult<DeliveryLatenessData>> {
  const { rows, capped } = await fetchOrderDeliveries(sb, hub, weeksBack);
  const total = rows.length;
  const missing = rows.filter((r) => r.delivered_at === null).length;
  const withMinutes = rows.filter((r) => r.minutes_late !== null);
  const early = withMinutes.filter((r) => (r.minutes_late as number) < 0).length;
  const gt10 = withMinutes.filter((r) => (r.minutes_late as number) > 10).length;
  const gt30 = withMinutes.filter((r) => (r.minutes_late as number) > 30).length;
  const gt60 = withMinutes.filter((r) => (r.minutes_late as number) > 60).length;

  const byWindowMap = new Map<string, { total: number; late30: number }>();
  for (const r of rows) {
    const k = r.window_label || '(sin ventana)';
    const b = byWindowMap.get(k) ?? { total: 0, late30: 0 };
    b.total++;
    if (r.minutes_late !== null && r.minutes_late > 30) b.late30++;
    byWindowMap.set(k, b);
  }
  const byWindow: WindowBucket[] = [...byWindowMap.entries()]
    .map(([window_label, b]) => ({ window_label, total: b.total, late_gt30: b.late30, pct_late_gt30: b.total > 0 ? b.late30 / b.total : 0 }))
    .filter((b) => b.total >= 10)
    .sort((a, b) => b.pct_late_gt30 - a.pct_late_gt30);

  const provenance: Provenance = {
    tool: 'deliveryLateness',
    args: { hub, weeksBack },
    source: [{ file: 'order_deliveries', columns: ['minutes_late', 'delivered_at', 'window_label'] }],
    rows_in: total,
    rows_out: total,
    filters: [hub ? `hub_id = ${hub}` : 'all hubs', `last ${weeksBack} weeks`],
  };

  const claims: Claim[] = [];
  if (total > 0) {
    claims.push({
      id: 'c1',
      text: `${gt30} of ${total} orders (${(gt30 / total * 100).toFixed(1)}%) delivered >30 min late — protocol target ≤5%`,
      evidence: { kind: 'rows', refetch: { tool: 'deliveryLateness', args: { hub, weeksBack }, predicate: { minutesLateGreaterThan: 30 } }, highlight: ['minutes_late'] },
    });
    claims.push({
      id: 'c2',
      text: `${gt60} of ${total} orders (${(gt60 / total * 100).toFixed(1)}%) delivered >60 min late — protocol target ≤1%`,
      evidence: { kind: 'rows', refetch: { tool: 'deliveryLateness', args: { hub, weeksBack }, predicate: { minutesLateGreaterThan: 60 } }, highlight: ['minutes_late'] },
    });
    if (byWindow.length) {
      const worst = byWindow[0];
      claims.push({
        id: 'c3',
        text: `Window "${worst.window_label}" runs ${(worst.pct_late_gt30 * 100).toFixed(1)}% >30-min-late, the highest of any window (n=${worst.total})`,
        evidence: { kind: 'rows', refetch: { tool: 'deliveryLateness', args: { hub, weeksBack }, predicate: { windowLabel: worst.window_label, minutesLateGreaterThan: 30 } }, highlight: ['window_label', 'minutes_late'] },
      });
    }
  }

  return {
    data: {
      hub: hub ?? 'network', weeks_back: weeksBack, total_orders: total,
      missing_delivered_at: missing, early,
      late_gt10: gt10, pct_late_gt10: total > 0 ? gt10 / total : 0,
      late_gt30: gt30, pct_late_gt30: total > 0 ? gt30 / total : 0,
      late_gt60: gt60, pct_late_gt60: total > 0 ? gt60 / total : 0,
      by_window: byWindow,
    },
    confidence: {
      coverage: total === 0 ? assumed('no order_deliveries rows in this window')
        : (missing / total < 0.05
          ? confirmed(`delivered_at missing on ${missing}/${total} (${(missing / total * 100).toFixed(1)}%) — matches the documented ~2%`)
          : assumed(`delivered_at missing on ${missing}/${total} (${(missing / total * 100).toFixed(1)}%) — above the documented ~2%, worth a second look`)),
      meaning: confirmed(
        '>10 min matches num_late_orders exactly across 7 spot-checked driver-weeks (DATA_DICTIONARY.md, Phase 1). ' +
        '>30/>60 are the protocol\'s own thresholds (Reparto de pedidos, 2025-12-27) — a different, and newer, definition of "late".'
      ),
      statistical: total >= 100 ? confirmed(`n=${total} orders`) : assumed(`n=${total} orders — thin sample`),
      causal: assumed('lateness is measured here, not explained — window/hub patterns are leads for discriminate(), not a traced cause'),
    },
    caveats: [
      'Express (sub-60-min SLA, no Calii driver) and marketplace (Uber Eats/Rappi/Didi) orders generate no ' +
      'desempeno_repartidores row at all (OPS_CONTEXT.md §5c) — they are structurally absent here, not filtered out.',
      ...(capped ? [`Row cap (${ROW_CAP}) reached — results are a prefix of the window, not the full history.`] : []),
    ],
    provenance,
    claims,
  };
}
