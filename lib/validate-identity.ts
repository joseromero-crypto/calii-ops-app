/**
 * Identity safety net — session 13.
 *
 * The 3-layer validateUpload() check (header / type / distribution) only
 * looks at the CSV in isolation. It cannot catch the highest-blast-radius
 * mistake: uploading the right *shape* of file into the wrong city slot
 * (e.g. Saltillo's operators file dropped into the Monterrey slot). This
 * module adds two checks that look at the file's *content* against what we
 * already know:
 *
 *   1. Hub-column check (deterministic) — for apps whose rows carry a
 *      hub/geofence column, resolve it via resolveHubId and compare the
 *      resolved city against the declared upload city. No fuzzy matching —
 *      a hub either belongs to the declared city or it doesn't.
 *
 *   2. Roster-overlap check (fuzzy, vs. history) — for apps with a person
 *      name column, compare this week's names against last week's SAME
 *      slot (soft warning on low retention — turnover is real) and against
 *      last week's OTHER slots for the same app (error if this file's
 *      roster matches a different city's history better than its own).
 *
 * Deliberately NOT applied to `mna` (per-hub, but the product catalog is
 * shared across all hubs — no discriminating identity) or the
 * `faltantes_hub_*_pct` apps (scope='total' — a single file already covers
 * every hub, so there's no slot to swap). See PLAN_RESUMEN_OPERATIVO.md-era
 * HANDOFF §21 sibling section for the same reasoning pattern.
 *
 * Every issue this module raises uses a code prefixed `identity_` — that
 * prefix is exactly what /api/upload/route.ts uses to decide which errors
 * are override-able with force_identity=true and which (header/type) never
 * are.
 */
import type { ValidationIssue } from './types';
import { resolveHubId } from './hub-aliases';
import { normalizeName } from './normalize';

type SB = ReturnType<typeof import('./supabase-server').createAdminSupabase>;

const CITIES = ['Monterrey', 'Saltillo', 'Guadalajara', 'CDMX'] as const;

interface IdentityConfig {
  /** Column holding a hub/geofence label per row (checked deterministically). */
  hubField?: string;
  /** Column(s) holding a person's name per row — first non-empty wins. */
  nameFields?: string[];
}

const IDENTITY_CONFIG: Record<string, IdentityConfig> = {
  desempeno_operadores:   { hubField: 'geofence', nameFields: ['assembler'] },
  desempeno_repartidores: { hubField: 'hub',       nameFields: ['driver_name', 'driver_nickname'] },
  resumen_operativo:      { hubField: 'Hub' },
  incidentes:             { nameFields: ['Operador'] },
  discrepancia:           { hubField: 'Hub', nameFields: ['Repartidor'] },
};

// Below this many resolvable hub rows, confidence is too low to block —
// warn instead. A 1-2 row stray file could be a legitimately tiny hub.
const MIN_ROWS_FOR_HUB_ERROR = 3;

// Same-slot retention below this ratio triggers a soft warning (real
// turnover is expected — this is a "does this look right?" nudge, not proof).
const ROSTER_WARN_RETENTION = 0.30;

// A sibling slot's overlap must clear this floor AND beat the intended
// slot's own retention before we escalate to a hard, denied error.
const ROSTER_CROSS_MATCH_FLOOR = 0.50;

function firstNonEmpty(row: Record<string, unknown>, fields: string[]): string {
  for (const f of fields) {
    const v = String(row[f] ?? '').trim();
    if (v) return v;
  }
  return '';
}

export interface IdentityCheckResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export async function computeIdentityChecks(params: {
  sb: SB;
  appId: string;
  weekStart: string;
  city: string | null;
  hubId: string | null;
  rows: Record<string, unknown>[];
}): Promise<IdentityCheckResult> {
  const { sb, appId, weekStart, city, rows } = params;
  const config = IDENTITY_CONFIG[appId];
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  if (!config || rows.length === 0) return { errors, warnings };

  // ── Check 1: hub-column vs. declared city (deterministic) ────────────────
  if (config.hubField && city) {
    const { data: hubs } = await sb.from('hubs').select('id, city');
    const hubCity = new Map<string, string>((hubs ?? []).map((h: any) => [h.id, h.city as string]));

    const cityCounts = new Map<string, number>();
    let resolvedTotal = 0;
    for (const row of rows) {
      const raw = String(row[config.hubField] ?? '').trim();
      if (!raw) continue;
      const hubId = resolveHubId(raw);
      if (!hubId) continue;
      const hCity = hubCity.get(hubId);
      if (!hCity) continue;
      resolvedTotal += 1;
      cityCounts.set(hCity, (cityCounts.get(hCity) ?? 0) + 1);
    }

    if (resolvedTotal > 0) {
      const declaredCount = cityCounts.get(city) ?? 0;
      let bestOtherCity: string | null = null;
      let bestOtherCount = 0;
      for (const [c, n] of cityCounts) {
        if (c !== city && n > bestOtherCount) { bestOtherCity = c; bestOtherCount = n; }
      }

      if (bestOtherCity && bestOtherCount > declaredCount) {
        const issue: ValidationIssue = {
          code: 'identity_hub_city_mismatch',
          message: `Este archivo parece ser de ${bestOtherCity} (${bestOtherCount}/${resolvedTotal} filas resuelven a hubs de ${bestOtherCity}), no ${city} (${declaredCount}/${resolvedTotal}).`,
        };
        if (resolvedTotal >= MIN_ROWS_FOR_HUB_ERROR) {
          errors.push(issue);
        } else {
          warnings.push({ ...issue, code: 'identity_hub_city_mismatch_low_confidence' });
        }
      } else if (declaredCount < resolvedTotal) {
        // Some stray rows point elsewhere but the declared city still wins —
        // informational only, doesn't block.
        const strayCities = [...cityCounts.entries()].filter(([c]) => c !== city);
        if (strayCities.length > 0) {
          warnings.push({
            code: 'identity_hub_stray_rows',
            message: `${resolvedTotal - declaredCount} de ${resolvedTotal} filas resuelven a hubs fuera de ${city} (${strayCities.map(([c, n]) => `${c}: ${n}`).join(', ')}).`,
          });
        }
      }
    }
  }

  // ── Check 2: roster overlap vs. history (fuzzy) ───────────────────────────
  if (config.nameFields) {
    const thisNames = new Set(
      rows.map((r) => firstNonEmpty(r, config.nameFields!)).filter(Boolean).map(normalizeName)
    );
    if (thisNames.size > 0) {
      const fetchSlotNames = async (slotCity: string | null, slotHubId: string | null): Promise<Set<string> | null> => {
        let q = sb.from('uploads').select('id, week_start')
          .eq('app_id', appId)
          .eq('status', 'validated')
          .lt('week_start', weekStart)
          .order('week_start', { ascending: false })
          .limit(1);
        q = slotCity ? q.eq('city', slotCity) : q.is('city', null);
        q = slotHubId ? q.eq('hub_id', slotHubId) : q.is('hub_id', null);
        const { data: prior } = await q;
        const priorUpload = prior?.[0];
        if (!priorUpload) return null;
        const { data: priorRows } = await sb.from('upload_rows').select('data').eq('upload_id', priorUpload.id).limit(10_000);
        if (!priorRows || priorRows.length === 0) return null;
        const names = new Set(
          priorRows
            .map((r: any) => firstNonEmpty(r.data ?? {}, config.nameFields!))
            .filter(Boolean)
            .map(normalizeName)
        );
        return names.size > 0 ? names : null;
      };

      const retention = (current: Set<string>, prior: Set<string>): number => {
        let matched = 0;
        for (const n of prior) if (current.has(n)) matched += 1;
        return matched / prior.size;
      };

      const ownSlotNames = await fetchSlotNames(city, params.hubId);
      const ownRetention = ownSlotNames ? retention(thisNames, ownSlotNames) : null;

      if (ownRetention !== null && ownRetention < ROSTER_WARN_RETENTION) {
        warnings.push({
          code: 'identity_roster_low_retention',
          message: `Solo ${(ownRetention * 100).toFixed(0)}% de los nombres de la semana pasada (${city ?? 'este slot'}) aparecen en este archivo. Puede ser rotación normal — confirma que es el archivo correcto.`,
        });
      }

      // Cross-slot comparison only makes sense for per_city apps — a
      // single-slot app (discrepancia, scope='total') has no siblings.
      if (city) {
        let bestCrossCity: string | null = null;
        let bestCrossRetention = 0;
        for (const otherCity of CITIES) {
          if (otherCity === city) continue;
          const otherNames = await fetchSlotNames(otherCity, null);
          if (!otherNames) continue;
          const r = retention(thisNames, otherNames);
          if (r > bestCrossRetention) { bestCrossRetention = r; bestCrossCity = otherCity; }
        }
        const ownForCompare = ownRetention ?? 0;
        if (bestCrossCity && bestCrossRetention >= ROSTER_CROSS_MATCH_FLOOR && bestCrossRetention > ownForCompare) {
          errors.push({
            code: 'identity_roster_mismatch',
            message: `Este archivo coincide más con el roster de ${bestCrossCity} de la semana pasada (${(bestCrossRetention * 100).toFixed(0)}%) que con ${city} (${(ownForCompare * 100).toFixed(0)}%). ¿Archivo equivocado?`,
          });
        }
      }
    }
  }

  return { errors, warnings };
}
