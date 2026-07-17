/**
 * Effective KPI direction — single source of truth for the tasa_armado
 * footgun (HANDOFF §12): the DB `kpis.direction` may say lower_is_better
 * even though higher is actually better for this KPI. GenerarReporte.tsx's
 * ASSEMBLER_KPI_DEFS carries this override for report flagging; anything
 * else that needs to know "is higher good for this KPI" (e.g. the /config
 * target editor's default comparator) must read it from here instead of
 * re-deriving its own copy.
 */
export const KPI_DIRECTION_OVERRIDES: Record<string, 'higher_is_better' | 'lower_is_better'> = {
  tasa_armado: 'higher_is_better',
};

export function effectiveDirection(kpiId: string, dbDirection: string): 'higher_is_better' | 'lower_is_better' {
  return KPI_DIRECTION_OVERRIDES[kpiId] ?? (dbDirection === 'higher_is_better' ? 'higher_is_better' : 'lower_is_better');
}

/** Default "meets target" comparator for a KPI's effective direction. */
export function defaultComparator(kpiId: string, dbDirection: string): 'gte' | 'lte' {
  return effectiveDirection(kpiId, dbDirection) === 'higher_is_better' ? 'gte' : 'lte';
}
