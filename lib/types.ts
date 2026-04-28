/**
 * Shared TypeScript types — mirror the Supabase schema.
 * Regenerate with `supabase gen types typescript` once the project is hosted;
 * for now these are hand-written to match migrations 001 and 002.
 */

export type City = 'Monterrey' | 'Saltillo' | 'Guadalajara' | 'CDMX';
export type AppScope = 'total' | 'per_city' | 'per_hub';
export type ColumnType = 'string' | 'int' | 'float' | 'bool' | 'datetime' | 'json' | 'list';
export type ColumnRole = 'dimension' | 'metric' | 'free_text' | 'id' | 'ignored';
export type KpiUnit = 'pct' | 'count' | 'currency' | 'rate' | 'minutes' | 'days';
export type KpiDirection = 'lower_is_better' | 'higher_is_better';
export type UploadStatus = 'pending' | 'validated' | 'rejected';
export type SnapshotScope = 'global' | 'city' | 'hub' | 'operator' | 'driver' | 'sku';
export type EntityType = 'operator' | 'driver' | 'hub' | 'sku' | 'city';
export type PeerScope = 'within_hub' | 'within_city' | 'within_subdivision' | 'global';
export type InsightMode = 'weekly_priorities' | 'focus_plan' | 'reformulation';
export type InsightView = 'global' | 'per_hub' | 'per_category';
export type FeedbackAction =
  | 'thumbs_up' | 'thumbs_down' | 'fuera_de_scope' | 'reformular' | 'editar' | 'ya_resuelto';

export interface Hub {
  id: string;                 // 'mh_contry'
  display_name: string;       // 'MH Contry'
  city: City;
  active: boolean;
  created_at: string;
}

export interface Subdivision {
  id: string;                 // 'graneles_abarrotes' | 'carnes' | 'frutas_verduras'
  name_es: string;
  description: string | null;
  active: boolean;
}

export interface AppRecord {
  id: string;
  name_es: string;
  scope: AppScope;
  expected_files_per_week: number;
  description: string | null;
  active: boolean;
  created_at: string;
}

export interface AppColumn {
  id: string;
  app_id: string;
  position: number;
  name: string;
  type: ColumnType;
  role: ColumnRole;
  required: boolean;
  notes: string | null;
}

export interface Kpi {
  id: string;
  name_es: string;
  source_app_id: string | null;
  parent_kpi_id: string | null;
  formula_sql: string | null;
  numerator_field: string | null;
  denominator_field: string | null;
  unit: KpiUnit;
  direction: KpiDirection;
  category: string;
  owner_role_id: string | null;
  watched_globally: boolean;
  weight: number;
  active: boolean;
  display_order: number;
}

export interface Upload {
  id: string;
  app_id: string;
  week_start: string;         // ISO date — always a Friday
  city: City | null;
  hub_id: string | null;
  uploaded_at: string;
  uploaded_by: string;
  file_storage_path: string;
  file_size_bytes: number | null;
  row_count: number | null;
  status: UploadStatus;
  validation_report: ValidationReport | null;
  prompt_version: number | null;
  created_at: string;
}

export interface ValidationReport {
  warnings: ValidationIssue[];
  errors: ValidationIssue[];
  schema_match: 'exact' | 'partial' | 'mismatch';
  rolling_distribution_check?: {
    column: string;
    z_score: number;
    rolling_mean: number;
    current_value: number;
    flag: 'ok' | 'shift';
  }[];
}

export interface ValidationIssue {
  code: string;               // 'missing_required_column' | 'type_mismatch' | 'distribution_shift' ...
  field?: string;
  message: string;
  sample_row_index?: number;
}

export interface UploadRow {
  id: number;
  upload_id: string;
  row_index: number;
  data: Record<string, unknown>;
  labels: Record<string, unknown> | null;
  is_excluded: boolean;
  exclusion_reason: string | null;
}

export interface KpiSnapshot {
  id: string;
  kpi_id: string;
  week_start: string;
  scope_level: SnapshotScope;
  scope_key: string | null;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  prev_week_value: number | null;
  rolling_mean_4w: number | null;
  rolling_std_4w: number | null;
  computed_at: string;
}

export interface PeerComparison {
  id: number;
  kpi_id: string;
  week_start: string;
  entity_type: EntityType;
  entity_key: string;
  scope_type: PeerScope;
  scope_key: string | null;
  value: number | null;
  peer_mean: number | null;
  peer_p50: number | null;
  peer_p90: number | null;
  z_score: number | null;
  rank: number | null;
  rank_total: number | null;
}

export interface AiInsight {
  id: string;
  week_start: string;
  generated_at: string;
  mode: InsightMode;
  focus_areas: string[] | null;
  view: InsightView | null;
  view_key: string | null;
  rank: number | null;
  kpi_id: string | null;
  scope_type: PeerScope | null;
  scope_key: string | null;
  headline_es: string;
  evidence_md: string;
  recommended_actions_md: string | null;
  flag_actions_md: string | null;
  linked_entities: Record<string, string[]> | null;
  why_now_es: string | null;
  source_files: SourceFileRef[] | null;
  model_used: string;
  prompt_version: number;
  cost_usd: number | null;
  user_feedback: string | null;
}

export interface SourceFileRef {
  file: string;               // 'MNA_zapopan.csv'
  rows: string;               // 'sem 17 (4891)' or 'sem 14-17 (12 sem)'
  notes?: string;             // 'clasificación Haiku 91% conf'
}

/** Friday of the Fri–Thu week containing date d (mirrors SQL `week_start_friday`). */
export function weekStartFriday(d: Date): Date {
  const date = new Date(d);
  const isoDow = ((date.getDay() + 6) % 7) + 1; // Mon=1 ... Fri=5 ... Sun=7
  const daysBack = (isoDow - 5 + 7) % 7;
  date.setDate(date.getDate() - daysBack);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * The week_start of the most-recently-COMPLETED Fri–Thu window as of date d.
 * This is what the upload page and dashboards show as "this week" — Jose uploads
 * on Friday morning for the just-completed Fri–Thu, so on most days the displayed
 * week is the one ending yesterday-or-earlier, not the in-progress one.
 *
 * Examples (today = Mon Apr 27, 2026):
 *   weekStartFriday(today)              → Fri Apr 24 (in-progress week's start)
 *   lastCompletedWeekStart(today)       → Fri Apr 17 (the just-finished Fri–Thu's start)
 */
export function lastCompletedWeekStart(d: Date): Date {
  const fri = weekStartFriday(d);
  fri.setDate(fri.getDate() - 7);
  return fri;
}

export function formatWeekRange(weekStartFri: Date): string {
  const end = new Date(weekStartFri);
  end.setDate(end.getDate() + 6);
  const fmt = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short' });
  return `vie ${fmt.format(weekStartFri)} — jue ${fmt.format(end)}, ${weekStartFri.getFullYear()}`;
}
