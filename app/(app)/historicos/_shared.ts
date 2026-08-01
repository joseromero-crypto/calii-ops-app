'use client';

export const HUB_COLORS: Record<string, string> = {
  mh_contry:      '#0ea5e9',
  mh_cumbres:     '#22c55e',
  mh_san_nicolas: '#a855f7',
  mh_guadalupe:   '#ef4444',
  mh_avicola:     '#f59e0b',
  mh_zapopan:     '#06b6d4',
  mh_condesa:     '#ec4899',
};

export interface Kpi {
  id: string;
  name_es: string;
  unit: string;
  direction: string;
  category: string;
  watched_globally: boolean;
  parent_kpi_id: string | null;
  display_order: number;
  owner_role_id: string | null;
  source_app_id: string | null;
}

/**
 * Pre-aggregated MNA product row, built from upload_rows in page.tsx.
 *
 * category: assembly category from classifyMnaProduct().
 *   'fyv'       → Frutas y Verduras
 *   'carnes'    → Refrigerated / cold-chain (dairy, meats, frozen, deli)
 *   'abarrotes' → Shelf-stable / dry goods (corresponds to mna_graneles_pct)
 */
export interface MnaProduct {
  hub_id: string;
  producto: string;
  /** Weighted MNA % using monetary formula: MNA($) / (MNA($) + Recibido × Source price). */
  pct: number;
  /** Sum of MNA $ for the week. */
  amount: number;
  /** Assembly category — used by subdivision tile flips to filter per-category products. */
  category: 'carnes' | 'fyv' | 'abarrotes';
}

/**
 * Pre-aggregated faltantes armador SKU row, built from the breakdown upload
 * in page.tsx. Category is resolved by cross-referencing the product name
 * against MNA rows (which carry supplier data for accurate classification).
 *
 * Used by subcategory tile flips (faltantes_fyv_pct, faltantes_carnes_pct,
 * faltantes_graneles_pct) to show the top offending SKUs per hub.
 */
export interface FaltantesSku {
  hub_id:   string;
  producto: string;
  /** Number of faltante events (rows in the breakdown upload) for this SKU. */
  count:    number;
  category: 'carnes' | 'fyv' | 'abarrotes';
}

export interface Hub { id: string; display_name: string; city: string }

/**
 * KPIs sourced from the hub-level Retool "Resumen operativo" export —
 * rendered in the Resumen tab only. Single source of truth for the
 * exclusion applied everywhere else (PorHubTab tiles, PorKpiTab top movers,
 * ComparativaTab, GenerarReporte's kpiSummary) — same pattern as
 * lib/hub-aliases.ts.
 */
export const RESUMEN_CATEGORY = 'operacion';
export const isResumenKpi = (k: { category: string }) => k.category === RESUMEN_CATEGORY;

export interface Snapshot {
  kpi_id: string;
  week_start: string;
  scope_level: string;
  scope_key: string | null;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  prev_week_value: number | null;
  rolling_mean_4w: number | null;
}

export interface Peer {
  kpi_id: string;
  week_start: string;
  entity_type: string;
  entity_key: string;
  hub_id?: string | null;  // not a DB column in peer_comparisons — omitted from SELECT
  scope_type: string;
  scope_key: string | null;
  value: number | null;
  peer_mean: number | null;
  z_score: number | null;
  rank: number | null;
  rank_total: number | null;
}

/**
 * Configurable KPI target row (kpi_targets table). target_value is stored
 * in DISPLAY units (e.g. 90 for tasa_armado, 6 for a 6% threshold) — not
 * the 0-1 fraction used in Snapshot/Peer `value`. See resolveTarget /
 * meetsTarget / isBelowTarget below for the one place that converts.
 */
export interface KpiTarget {
  kpi_id: string;
  scope_level: 'global' | 'hub';
  scope_key: string | null;   // hub_id when scope_level='hub', else null
  target_value: number;
  comparator: 'gte' | 'lte' | 'gt' | 'lt';  // the "meets target" (good) condition
  unit: string;                              // snapshot of kpis.unit
  active: boolean;
}

/**
 * Resolves the effective target for a (kpi, hub) pair.
 * Precedence: hub-specific row > global row > undefined (caller falls back
 * to its own code default — never hard-fail on a missing target).
 */
export function resolveTarget(
  kpiId: string,
  hubId: string | null | undefined,
  targets: KpiTarget[],
): KpiTarget | undefined {
  if (hubId) {
    const hubTarget = targets.find(
      (t) => t.active && t.kpi_id === kpiId && t.scope_level === 'hub' && t.scope_key === hubId,
    );
    if (hubTarget) return hubTarget;
  }
  return targets.find((t) => t.active && t.kpi_id === kpiId && t.scope_level === 'global');
}

/**
 * Converts a raw DB value (Snapshot/Peer `value`) to the DISPLAY units a
 * target is stored in. pct is the only unit stored as a 0-1 fraction in the
 * DB (HANDOFF §3/§12) — rate/count/currency pass through unchanged.
 * This is the ONLY place this conversion should happen for targets.
 */
function toDisplayUnits(dbValue: number, unit: string): number {
  return unit === 'pct' ? dbValue * 100 : dbValue;
}

// Landing exactly on the target does not count as meeting it — you have to
// clear it, not tie it. TARGET_EPS exists only so float noise (e.g. a value
// that's conceptually 90 but stored as 89.99999999999997) doesn't get
// treated as "on the line" when it should read as exactly met. gte/lte are
// therefore effectively strict (same boundary as gt/lt) — the distinction
// between gte/gt and lte/lt is a hair's width, not a meaningful inclusive
// threshold.
const TARGET_EPS = 1e-9;

/** True if the value (converted to display units) satisfies the target's comparator. */
export function meetsTarget(dbValue: number, t: KpiTarget): boolean {
  const display = toDisplayUnits(dbValue, t.unit);
  switch (t.comparator) {
    case 'gte': return display >= t.target_value + TARGET_EPS;
    case 'lte': return display <= t.target_value - TARGET_EPS;
    case 'gt':  return display > t.target_value;
    case 'lt':  return display < t.target_value;
  }
}

/**
 * True if the value (converted to display units) is numerically below the
 * target — direction-agnostic, unlike meetsTarget. Used for chart/tile
 * geometry (e.g. is this point above or below the reference line) where
 * "below the line" and "good" aren't always the same thing.
 */
export function isBelowTarget(dbValue: number, t: KpiTarget): boolean {
  return toDisplayUnits(dbValue, t.unit) < t.target_value;
}

export function formatValue(v: number | null | undefined, unit: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (unit === 'pct') return `${(v * 100).toFixed(1)}%`;
  if (unit === 'currency' || unit === 'currency_avg') return `$${v.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  if (unit === 'rate') return v.toFixed(1);
  if (unit === 'count') return v.toFixed(0);
  return String(v);
}

export function formatDelta(curr: number | null, prev: number | null, unit: string): { text: string; isUp: boolean | null } {
  if (curr === null || prev === null || !Number.isFinite(curr) || !Number.isFinite(prev) || prev === 0) {
    return { text: '—', isUp: null };
  }
  const pctDelta = ((curr - prev) / Math.abs(prev)) * 100;
  if (unit === 'pct') {
    const ppDelta = (curr - prev) * 100;
    return { text: `${ppDelta > 0 ? '+' : ''}${ppDelta.toFixed(1)}pp`, isUp: ppDelta > 0 };
  }
  return { text: `${pctDelta > 0 ? '+' : ''}${pctDelta.toFixed(1)}%`, isUp: pctDelta > 0 };
}

/** Returns the Thursday end-of-week label given a Friday week_start. */
export function weekEndLabel(weekStartIso: string): string {
  const d = new Date(weekStartIso + 'T00:00:00');
  d.setDate(d.getDate() + 6);
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short' }).format(d);
}

/** Same but with the year for tooltips. */
export function weekEndLabelLong(weekStartIso: string): string {
  const d = new Date(weekStartIso + 'T00:00:00');
  d.setDate(d.getDate() + 6);
  return `vie ${new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short' }).format(new Date(weekStartIso + 'T00:00:00'))} — jue ${new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short' }).format(d)}`;
}

export function deltaClassForDirection(isUp: boolean | null, direction: string): string {
  if (isUp === null) return 'text-[var(--muted)]';
  const wantsUp = direction === 'higher_is_better';
  const good = wantsUp ? isUp : !isUp;
  return good ? 'text-emerald-600' : 'text-red-600';
}

export function groupBy<T, K>(arr: T[], f: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of arr) {
    const k = f(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
}

/** Z-score → background color class for heatmap cells (with KPI direction in mind). */
export function zToHeatmapClass(z: number | null, direction: string): string {
  if (z === null || !Number.isFinite(z)) return 'bg-slate-50';
  const flip = direction === 'higher_is_better' ? -1 : 1;   // for higher_is_better, high z = bad
  const adj = z * flip;
  if (adj <= -1.5) return 'bg-emerald-200 text-emerald-900';
  if (adj <= -0.5) return 'bg-emerald-100 text-emerald-800';
  if (adj <=  0.5) return 'bg-slate-100';
  if (adj <=  1.0) return 'bg-amber-100 text-amber-800';
  if (adj <=  1.5) return 'bg-orange-200 text-orange-900';
  return 'bg-red-200 text-red-900 font-bold';
}
