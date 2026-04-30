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
}
export interface Hub { id: string; display_name: string; city: string }
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
  hub_id: string | null;   // canonical hub slug from geofence — added session 3
  scope_type: string;
  scope_key: string | null;
  value: number | null;
  peer_mean: number | null;
  z_score: number | null;
  rank: number | null;
  rank_total: number | null;
}
export function formatValue(v: number | null | undefined, unit: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (unit === 'pct') return `${(v * 100).toFixed(1)}%`;
  if (unit === 'currency') return `$${v.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
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
