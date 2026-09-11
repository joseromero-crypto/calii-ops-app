/**
 * Canonical hub alias map — single source of truth.
 *
 * Maps every known CSV / Retool label variant to the canonical hub_id slug
 * used in the `hubs` table. Keys are pre-normalised (NFD stripped, lowercase,
 * spaces → underscores). Both kpi-compute.ts and page.tsx import from here so
 * adding a new hub or fixing a typo only requires editing this one file.
 *
 * Rules:
 *   - CH Guadalupe is always excluded — resolveHubId() returns null for it.
 *   - Single-hub cities (Saltillo, GDL, CDMX, San Pedro) often omit the "MH "
 *     prefix in their CSVs; both forms are listed.
 *   - Known typos (e.g. "Country" for "Contry") are explicitly included.
 */
export const HUB_ALIAS_MAP: Record<string, string> = {
  // ── Monterrey ───────────────────────────────────────────────────────────
  'mh_contry':        'mh_contry',
  'contry':           'mh_contry',
  'mh_country':       'mh_contry',   // common CSV typo
  'country':          'mh_contry',   // common CSV typo

  'mh_cumbres':       'mh_cumbres',
  'cumbres':          'mh_cumbres',

  'mh_san_nicolas':   'mh_san_nicolas',
  'san_nicolas':      'mh_san_nicolas',

  'mh_guadalupe':     'mh_guadalupe',
  'guadalupe':        'mh_guadalupe',

  // ── Saltillo (single hub — Retool often labels by city name) ────────────
  'mh_avicola':       'mh_avicola',
  'avicola':          'mh_avicola',
  'mh_saltillo':      'mh_avicola',
  'saltillo':         'mh_avicola',

  // ── Guadalajara ─────────────────────────────────────────────────────────
  'mh_zapopan':       'mh_zapopan',
  'zapopan':          'mh_zapopan',
  'guadalajara':      'mh_zapopan',  // city-level label fallback
  'gdl':              'mh_zapopan',  // common CSV abbreviation

  // ── CDMX ────────────────────────────────────────────────────────────────
  'mh_condesa':       'mh_condesa',
  'condesa':          'mh_condesa',
  'cdmx':             'mh_condesa',  // city-level label fallback
  'df':               'mh_condesa',  // old Mexico City abbreviation
  'ciudad_de_mexico': 'mh_condesa',  // full unaccented form
  'mexico':           'mh_condesa',  // short form in some geofence CSVs

  // ── San Pedro ───────────────────────────────────────────────────────────
  'mh_san_pedro':     'mh_san_pedro',
  'san_pedro':        'mh_san_pedro',
};

/**
 * Deliberately NOT in the map (confirmed with José, session 17, 2026-09-11):
 *
 *   "MH Santa Fé"        → mh_santa_fe
 *   "MH Miguel Hidalgo"  → mh_miguel_hidalgo
 *
 * Both are **inactive** CDMX hubs with no operation behind them. They appear
 * as rows in the Retool `resumen_operativo` export, which is why a local
 * recompute logs `[resolveHubId] unrecognised hub label` for them once per
 * resumen KPI. That warning is expected and the rows are correctly dropped —
 * they carry no data, and `extractResumenOperativoValues` would skip them on
 * the `Pedidos (#) <= 0` guard even if they resolved.
 *
 * Do not "fix" this by adding them here. Adding them without rows in the
 * `hubs` table reproduces the MH San Pedro problem documented above: orphan
 * snapshots no UI can render, plus a phantom zero-order hub polluting every
 * weighted KPI. If either hub is ever activated, it needs a `hubs` row, a
 * HUB_COLORS entry and an alias here — all three, in the same change.
 */

/**
 * Normalise an arbitrary hub label from a CSV or Retool export to the
 * canonical hub_id slug, or null if unrecognised / excluded.
 *
 * Handles: accented characters, mixed case, spaces vs underscores, "MH "
 * prefix, CH Guadalupe exclusion.
 */
/** Labels already warned about in this process — see the note in resolveHubId. */
const warnedLabels = new Set<string>();

export function resolveHubId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip diacritic combining marks
    .toLowerCase()
    .trim()
    .replace(/[-\s]+/g, '_');          // hyphens and spaces → underscore
  if (cleaned.startsWith('ch_')) return null;  // CH Guadalupe excluded
  const resolved = HUB_ALIAS_MAP[cleaned] ?? null;
  if (!resolved) {
    // Surface unrecognised labels during development so the alias map stays
    // up to date. Safe to ignore in production — the row is simply skipped.
    //
    // Once per distinct label per process (session 17). Every extractor
    // re-scans the same rows once per KPI, so an unrecognised label used to
    // print once per KPI per week: the 24-week backfill emitted ~400 lines of
    // it, three distinct labels repeated, which buried the per-week result
    // lines the run actually exists to show. Deduplicating loses nothing —
    // the second occurrence carried no information the first did not.
    if (process.env.NODE_ENV !== 'production' && !warnedLabels.has(cleaned)) {
      warnedLabels.add(cleaned);
      console.warn(`[resolveHubId] unrecognised hub label: ${JSON.stringify(raw)} → normalised: ${JSON.stringify(cleaned)}`);
    }
  }
  return resolved;
}
