/**
 * Report-facing KPI labels.
 *
 * The DB `kpis.name_es` for the incidentes parent KPI is "Incidentes manuales
 * (%)" — an internal name that must never reach the coordinator report. When a
 * LISTA 1 entry has no flagged sub-metric to name, Haiku reaches for the
 * nearest available noun and writes "— incidentes manuales" as if it were an
 * incident *type*. The dashboard already relabels this KPI ("Incidentes
 * general" in PorHubTab's KPI_META); this map is the same relabelling applied
 * to everything that feeds the report prompt, so the word never enters the
 * context in the first place.
 *
 * Single source of truth — same pattern as lib/kpi-direction.ts and
 * lib/hub-aliases.ts. Never re-derive a report label inline (HANDOFF §12's
 * hub-alias-map divergence footgun).
 */
export const REPORT_KPI_LABELS: Record<string, string> = {
  incidentes_manuales_pct: 'Incidentes armado',
};

/** Report label for a KPI, falling back to the DB `name_es`. */
export function reportKpiLabel(kpiId: string, fallback: string): string {
  return REPORT_KPI_LABELS[kpiId] ?? fallback;
}
