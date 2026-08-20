/**
 * Tenure ledger — session 14, slices 1–2.
 *
 * Single source of truth for deriving and reading "how long has this person
 * been here" from upload history. Nothing else in the codebase may derive a
 * week number or a badge string. See PLAN_MODO_ENTRENAMIENTO.md for the full
 * design; this file implements §3 (module shape) and §4 (derivation +
 * upsert). `deriveTenureLedger()` is pure/read-only — it never writes.
 * `refreshTenureLedger()` wraps it and upserts into `person_tenure`
 * (migration `20260819000001_person_tenure.sql`, slice 2), skipping any row
 * with `source='manual'`.
 *
 * Identity is `operator_id` / `driver_id` ("person_key"), never a name —
 * names get retyped, accented, nicknamed, reordered. `entity_key` in
 * peer_comparisons is a name, so display-side lookups go through
 * `buildTenureNameIndex`, keyed on the SAME normaliser as
 * `lib/validate-identity.ts` (`normalizeName`, imported from
 * `lib/normalize.ts` — never copy-paste it, see HANDOFF §12's hub-alias-map
 * divergence footgun for why that's dangerous).
 *
 * `deriveTenureLedger` / `refreshTenureLedger` take an `SB` client as an
 * explicit parameter (deviating from the plan's no-arg sketch) rather than
 * constructing one internally via `createAdminSupabase()` — that function's
 * home module statically imports `next/headers`, which breaks when this
 * file is imported from a plain `tsx` script outside the Next.js runtime
 * (see scripts/tenure-dry-run.ts, scripts/tenure-backfill.ts). Route
 * handlers just pass their own `createAdminSupabase()` instance in.
 */
import type { createAdminSupabase } from './supabase-server';
import { resolveHubId } from './hub-aliases';
import { normalizeName } from './normalize';

type SB = ReturnType<typeof createAdminSupabase>;

export type Role = 'armador' | 'repartidor';

export const RAMP_WEEKS: Record<Role, number> = { armador: 10, repartidor: 4 };
export const REENTRY_GAP_WEEKS = 10;   // absent this many consecutive CALENDAR weeks → reingreso on return
export const REENTRY_LABEL_WEEKS = 2;  // how long the (RI) badge shows

export type ConfidenceReason = 'data_horizon' | 'missing_prior_week';

export interface TenureRow {
  person_key: string;
  role: Role;
  first_seen_week: string;      // ISO Friday
  last_seen_week: string;
  seen_weeks: string[];         // sorted ascending
  display_names: string[];      // distinct names, most recent first
  hub_id_first: string | null;
  hub_id_last: string | null;
  city_last: string | null;
  confidence: 'high' | 'low';
  confidence_reason: ConfidenceReason | null;
  source: 'derived' | 'manual';
  /**
   * Weeks (subset of seen_weeks, excluding the first-ever appearance) where
   * this person returned after a >= REENTRY_GAP_WEEKS calendar gap AND the
   * §5.2 zero-uploads-in-window guard did not suppress the claim. Computed
   * once at derivation time (deriveTenureLedger has weeksWithData in scope)
   * and carried on the in-memory row so `tenureStatus` stays a pure
   * (row, weekStart) function per the spec — it never needs weeksWithData
   * itself. NOT a person_tenure DB column (§2.1) — a future reader of a
   * DB-sourced TenureRow must recompute this via `computeReentryWeeks`
   * before calling `tenureStatus`.
   */
  reentry_weeks: string[];
}

export type TenureStatus =
  | { kind: 'trainee'; week: number }   // 1..RAMP_WEEKS[role]
  | { kind: 'reentry'; week: number }   // 1..REENTRY_LABEL_WEEKS
  | { kind: 'veteran' };

// ----------------------------------------------------------------------------
// Calendar week math — all week_start values are Fridays, 7 days apart.
// Local-noon parsing avoids the UTC-midnight-is-Thursday-evening-in-Mexico
// timezone bug documented in HANDOFF §12 (same root cause as the upload
// Friday-validation bug and the incidente fecha off-by-one bug).
// ----------------------------------------------------------------------------

function parseWeekStart(iso: string): Date {
  return new Date(`${iso}T12:00:00`);
}

function formatWeekStart(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Fri–Thu weeks between two week_start Fridays. Negative if toIso precedes fromIso. */
export function weeksBetween(fromIso: string, toIso: string): number {
  const from = parseWeekStart(fromIso);
  const to = parseWeekStart(toIso);
  const diffMs = to.getTime() - from.getTime();
  return Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
}

function addWeeks(iso: string, n: number): string {
  const d = parseWeekStart(iso);
  d.setDate(d.getDate() + n * 7);
  return formatWeekStart(d);
}

// ----------------------------------------------------------------------------
// §5.2 — reentry detection with the zero-uploads-in-window guard
// ----------------------------------------------------------------------------

/**
 * For a person's sorted, distinct seen_weeks, find every week that counts as
 * a return: gap since the previous appearance >= REENTRY_GAP_WEEKS calendar
 * weeks, AND the gap window contains at least one validated upload for the
 * app (otherwise we have no evidence either way — see PLAN §5.2's guard).
 * A person's very first appearance is never a return.
 */
export function computeReentryWeeks(seenWeeks: string[], weeksWithData: Set<string>): string[] {
  const sorted = [...seenWeeks].sort();
  const out: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (weeksBetween(prev, cur) < REENTRY_GAP_WEEKS) continue;
    if (!hasUploadStrictlyBetween(prev, cur, weeksWithData)) continue; // no evidence — suppress
    out.push(cur);
  }
  return out;
}

function hasUploadStrictlyBetween(fromIso: string, toIso: string, weeksWithData: Set<string>): boolean {
  let cursor = addWeeks(fromIso, 1);
  while (cursor < toIso) {
    if (weeksWithData.has(cursor)) return true;
    cursor = addWeeks(cursor, 1);
  }
  return false;
}

// ----------------------------------------------------------------------------
// §5.1 / §5.2 — status resolution
// ----------------------------------------------------------------------------

/**
 * Full status for a person in a given week. Precedence: reentry > trainee >
 * veteran. Returns 'veteran' when: no ledger row, confidence==='low', past
 * the ramp, or the displayed week predates first_seen_week.
 */
export function tenureStatus(row: TenureRow | undefined, weekStart: string): TenureStatus {
  if (!row) return { kind: 'veteran' };

  for (const r of row.reentry_weeks) {
    const sinceReturn = weeksBetween(r, weekStart);
    if (sinceReturn >= 0 && sinceReturn < REENTRY_LABEL_WEEKS) {
      return { kind: 'reentry', week: sinceReturn + 1 };
    }
  }

  if (row.confidence === 'low') return { kind: 'veteran' };

  const weekNumber = weeksBetween(row.first_seen_week, weekStart) + 1;
  const rampLen = RAMP_WEEKS[row.role];
  if (weekNumber >= 1 && weekNumber <= rampLen) return { kind: 'trainee', week: weekNumber };
  return { kind: 'veteran' };
}

/** ' (S4)' | ' (RI)' | '' — the ONLY place a badge string is formatted. */
export function tenureLabel(status: TenureStatus): string {
  if (status.kind === 'trainee') return ` (S${status.week})`;
  if (status.kind === 'reentry') return ' (RI)';
  return '';
}

/**
 * 'S4' | 'RI' | undefined — the bare code, no parens/leading space. For
 * contexts that compose their own punctuation around the badge (the report
 * bundle's PeerEntity.tenureBadge, /config's supervision list) rather than
 * rendering it as trailing annotation text like tenureLabel does.
 */
export function tenureCode(status: TenureStatus): string | undefined {
  if (status.kind === 'trainee') return `S${status.week}`;
  if (status.kind === 'reentry') return 'RI';
  return undefined;
}

/** Name-keyed lookup for joining to peer_comparisons.entity_key. */
export function buildTenureNameIndex(rows: TenureRow[]): Map<string, TenureRow> {
  const map = new Map<string, TenureRow>();
  for (const row of rows) {
    const name = row.display_names[0];
    if (!name) continue;
    map.set(normalizeName(name), row);
  }
  return map;
}

/** Shape of a raw `person_tenure` row as read from Supabase — no reentry_weeks column (§2.1). */
export interface PersonTenureDbRow {
  person_key: string;
  role: Role;
  first_seen_week: string;
  last_seen_week: string;
  seen_weeks: string[];
  display_names: string[];
  hub_id_first: string | null;
  hub_id_last: string | null;
  city_last: string | null;
  confidence: 'high' | 'low';
  confidence_reason: ConfidenceReason | null;
  source: 'derived' | 'manual';
}

/**
 * Turns a raw DB row into a full in-memory TenureRow by recomputing
 * reentry_weeks (not persisted — see the TenureRow doc comment above).
 * `weeksWithData` must be the set of validated-upload weeks for this row's
 * role's app (desempeno_operadores for armador, desempeno_repartidores for
 * repartidor) — callers reading person_tenure for display (e.g.
 * app/(app)/historicos/page.tsx) must fetch that alongside the ledger.
 */
export function hydrateTenureRow(row: PersonTenureDbRow, weeksWithData: Set<string>): TenureRow {
  return {
    ...row,
    reentry_weeks: computeReentryWeeks(row.seen_weeks, weeksWithData),
  };
}

// ----------------------------------------------------------------------------
// §4 — derivation algorithm (read-only; no writes)
// ----------------------------------------------------------------------------

interface RoleConfig {
  appId: string;
  idField: string;
  nameFields: string[];
  hubField: string;
}

const ROLE_CONFIG: Record<Role, RoleConfig> = {
  armador:    { appId: 'desempeno_operadores',   idField: 'operator_id', nameFields: ['assembler'], hubField: 'geofence' },
  repartidor: { appId: 'desempeno_repartidores', idField: 'driver_id',   nameFields: ['driver_name', 'driver_nickname'], hubField: 'hub' },
};

export interface NameCollision {
  normalized_name: string;
  person_keys: string[];
}

export interface TenureDeriveResult {
  role: Role;
  rows: TenureRow[];
  dataHorizon: string | null;
  weeksWithData: string[]; // sorted ascending
  uploadsPerWeek: Map<string, number>;
  skippedNoId: number;
  collisions: NameCollision[];
}

function firstNonEmpty(row: Record<string, unknown>, fields: string[]): string {
  for (const f of fields) {
    const v = String(row[f] ?? '').trim();
    if (v) return v;
  }
  return '';
}

interface PersonAccum {
  weeks: Map<string, { name: string; hubId: string | null; city: string | null }>; // week_start -> latest row seen that week
}

/**
 * Idempotent, read-only rebuild of the tenure ledger from upload history for
 * one role. Implements PLAN_MODO_ENTRENAMIENTO.md §4 steps 1–4 and 6. Step 5
 * (upsert into person_tenure) is NOT implemented here — slice 1 is a dry run
 * only; the upsert ships with the migration in slice 2.
 */
export async function deriveTenureLedger(sb: SB, role: Role): Promise<TenureDeriveResult> {
  const config = ROLE_CONFIG[role];

  // Step 1 — every validated upload for the app, chronological.
  const { data: uploads, error: upErr } = await sb
    .from('uploads')
    .select('id, week_start, city, hub_id')
    .eq('app_id', config.appId)
    .eq('status', 'validated')
    .order('week_start', { ascending: true });
  if (upErr) throw upErr;

  const uploadRows = (uploads ?? []) as { id: string; week_start: string; city: string | null; hub_id: string | null }[];
  const weeksWithData = new Set<string>(uploadRows.map((u) => u.week_start));
  const uploadsPerWeek = new Map<string, number>();
  for (const u of uploadRows) uploadsPerWeek.set(u.week_start, (uploadsPerWeek.get(u.week_start) ?? 0) + 1);
  const sortedWeeks = [...weeksWithData].sort();
  const dataHorizon = sortedWeeks[0] ?? null;

  // Steps 2–3 — fetch rows ONE UPLOAD AT A TIME (eq upload_id, limit 10_000).
  // Never ORDER BY id, never IN(...) with range pagination — see HANDOFF §9:
  // both trigger a full-table sort / non-deterministic pagination on the
  // growing upload_rows table and can time out or silently drop rows.
  const people = new Map<string, PersonAccum>();
  let skippedNoId = 0;

  for (const u of uploadRows) {
    const { data: rows, error } = await sb
      .from('upload_rows')
      .select('data')
      .eq('upload_id', u.id)
      .eq('is_excluded', false)
      .limit(10_000);
    if (error) throw error;

    for (const r of (rows ?? []) as { data: Record<string, unknown> }[]) {
      const personKey = String(r.data[config.idField] ?? '').trim();
      if (!personKey) { skippedNoId += 1; continue; }
      const name = firstNonEmpty(r.data, config.nameFields);
      const hubLabel = String(r.data[config.hubField] ?? '').trim();
      const hubId = resolveHubId(hubLabel) ?? u.hub_id ?? null;

      let acc = people.get(personKey);
      if (!acc) { acc = { weeks: new Map() }; people.set(personKey, acc); }
      // Last row seen for this person in this week wins (rare multi-row-per-
      // week case) — doesn't affect first/last_seen_week or seen_weeks.
      acc.weeks.set(u.week_start, { name: name || personKey, hubId, city: u.city });
    }
  }

  // Step 4 — build rows + confidence guard.
  const rows: TenureRow[] = [];
  for (const [personKey, acc] of people) {
    const weeks = [...acc.weeks.keys()].sort();
    const firstSeenWeek = weeks[0];
    const lastSeenWeek = weeks[weeks.length - 1];

    // display_names: distinct names, most recent first.
    const namesDesc: string[] = [];
    for (let i = weeks.length - 1; i >= 0; i--) {
      const n = acc.weeks.get(weeks[i])!.name;
      if (!namesDesc.includes(n)) namesDesc.push(n);
    }

    let confidence: 'high' | 'low' = 'high';
    let confidenceReason: ConfidenceReason | null = null;
    if (firstSeenWeek === dataHorizon) {
      confidence = 'low';
      confidenceReason = 'data_horizon';
    } else {
      const precedingFriday = addWeeks(firstSeenWeek, -1);
      if (!weeksWithData.has(precedingFriday)) {
        confidence = 'low';
        confidenceReason = 'missing_prior_week';
      }
    }

    const reentryWeeks = computeReentryWeeks(weeks, weeksWithData);

    rows.push({
      person_key: personKey,
      role,
      first_seen_week: firstSeenWeek,
      last_seen_week: lastSeenWeek,
      seen_weeks: weeks,
      display_names: namesDesc,
      hub_id_first: acc.weeks.get(firstSeenWeek)!.hubId,
      hub_id_last: acc.weeks.get(lastSeenWeek)!.hubId,
      city_last: acc.weeks.get(lastSeenWeek)!.city,
      confidence,
      confidence_reason: confidenceReason,
      source: 'derived',
      reentry_weeks: reentryWeeks,
    });
  }

  // Step 6 — warn (return, don't throw) on normalized-name collisions
  // between two distinct person_keys of the same role.
  const byNormName = new Map<string, Set<string>>();
  for (const row of rows) {
    const primaryName = row.display_names[0];
    if (!primaryName) continue;
    const norm = normalizeName(primaryName);
    if (!byNormName.has(norm)) byNormName.set(norm, new Set());
    byNormName.get(norm)!.add(row.person_key);
  }
  const collisions: NameCollision[] = [];
  for (const [norm, keys] of byNormName) {
    if (keys.size > 1) collisions.push({ normalized_name: norm, person_keys: [...keys] });
  }

  return {
    role,
    rows,
    dataHorizon,
    weeksWithData: sortedWeeks,
    uploadsPerWeek,
    skippedNoId,
    collisions,
  };
}

// ----------------------------------------------------------------------------
// §4 step 5 — idempotent upsert into person_tenure (slice 2)
// ----------------------------------------------------------------------------

export interface TenureRefreshResult {
  role: Role;
  rows_considered: number;
  rows_upserted: number;
  manual_rows_skipped: number;
  collisions: NameCollision[];
}

/**
 * Idempotent rebuild of person_tenure from upload history. Full rebuild, not
 * an incremental diff — running it twice must produce byte-identical rows
 * (same first_seen_week, same seen_weeks) for the same input data. Never
 * touches rows where source='manual' — that's the escape hatch for a wrong
 * derivation or a rehire under a new id (see PLAN §8).
 *
 * dryRun computes the ledger but performs no writes — same derivation path
 * `deriveTenureLedger` uses on its own, exposed here so callers that already
 * have refreshTenureLedger wired in (recompute/upload routes) can dry-run
 * without a second code path.
 */
export async function refreshTenureLedger(
  sb: SB,
  opts?: { role?: Role; dryRun?: boolean }
): Promise<TenureRefreshResult[]> {
  const roles: Role[] = opts?.role ? [opts.role] : ['armador', 'repartidor'];
  const results: TenureRefreshResult[] = [];

  for (const role of roles) {
    const derived = await deriveTenureLedger(sb, role);

    if (derived.collisions.length > 0) {
      console.warn(
        `[refreshTenureLedger] ${role}: ${derived.collisions.length} normalized-name collision(s)`,
        derived.collisions
      );
    }

    if (opts?.dryRun) {
      results.push({
        role,
        rows_considered: derived.rows.length,
        rows_upserted: 0,
        manual_rows_skipped: 0,
        collisions: derived.collisions,
      });
      continue;
    }

    const { data: manualRows, error: manualErr } = await sb
      .from('person_tenure')
      .select('person_key')
      .eq('role', role)
      .eq('source', 'manual');
    if (manualErr) throw manualErr;
    const manualKeys = new Set((manualRows ?? []).map((r: { person_key: string }) => r.person_key));

    const upsertRows = derived.rows
      .filter((r) => !manualKeys.has(r.person_key))
      .map((r) => ({
        person_key: r.person_key,
        role: r.role,
        first_seen_week: r.first_seen_week,
        last_seen_week: r.last_seen_week,
        weeks_seen: r.seen_weeks.length,
        seen_weeks: r.seen_weeks,
        display_names: r.display_names,
        hub_id_first: r.hub_id_first,
        hub_id_last: r.hub_id_last,
        city_last: r.city_last,
        confidence: r.confidence,
        confidence_reason: r.confidence_reason,
        source: 'derived' as const,
        updated_at: new Date().toISOString(),
      }));

    // Plain upsert is safe here — (person_key, role) is the primary key and
    // neither column is nullable, so there's no NULL-in-UNIQUE footgun (see
    // HANDOFF §12; kpi_targets needed delete-then-insert, this table doesn't).
    const BATCH = 200;
    for (let i = 0; i < upsertRows.length; i += BATCH) {
      const batch = upsertRows.slice(i, i + BATCH);
      const { error } = await sb.from('person_tenure').upsert(batch, { onConflict: 'person_key,role' });
      if (error) throw error;
    }

    results.push({
      role,
      rows_considered: derived.rows.length,
      rows_upserted: upsertRows.length,
      manual_rows_skipped: manualKeys.size,
      collisions: derived.collisions,
    });
  }

  return results;
}
