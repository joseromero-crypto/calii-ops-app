# Feature Spec — Modo Entrenamiento (tenure-aware targets for new pickers)

**For:** Claude Code, working in `~/Desktop/calii-ops-app`
**Author:** Jose Romero
**Date:** 2026-08-19
**Related reading before you start:** `HANDOFF.md` §3 (tables), §5 (upload pipeline), §9 (kpi-compute extractors), §12 (footguns), §13 (report generator), §14 (configurable targets), §22 (identity safety net) · `CONFIGURABLE_KPI_TARGETS.md` (the target resolver this feature extends)

---

## 0. TL;DR

New armadores should not be judged against the veteran `tasa_armado` target (100 SKUs/hr). They get a **ramped goal that rises week by week for their first 10 weeks**, then they graduate to the normal target. New repartidores get a **label only, for 4 weeks** — no ramped goal.

There is **no hire-date field anywhere in the data**. Tenure is therefore *derived* from upload history: the first week a person's ID appears is week 1 (`S1`); every subsequent Fri–Thu week increments to `S2`, `S3` … `S10`; from `S11` on they're a veteran and carry no badge.

Two things make this robust rather than fragile:

1. **Never diff consecutive weeks.** A person is new iff their ID has *never* appeared in *any* prior week we have. Absence last week — vacation, sick, a glitched upload — cannot make a veteran look new, because we look at the whole history, not the previous file. This is the direct answer to "the comparison needs to be vs more than 1 previous week".
2. **Identify by `operator_id` / `driver_id`, not by name.** Both source CSVs already carry them (see `extractOperatorValues` / `extractDriverValues` in `lib/kpi-compute.ts`). Names get retyped, accented, nicknamed, and reordered; IDs don't. Names remain the *display* key (that's what `peer_comparisons.entity_key` stores), but identity and tenure hang off the ID.

Three badge states, in precedence order:

| Badge | Meaning | Applies to |
|---|---|---|
| `(RI)` | Reingreso — returned after ≥ 10 calendar weeks away. Shown for 2 weeks. Veteran target — label only. | both roles |
| `(S1)`–`(S10)` | Training week N | armadores (10 wks), repartidores (4 wks → `S1`–`S4`) |
| *(none)* | Veteran | both |

---

## 1. Design decisions already made (do not re-litigate)

| Decision | Choice | Why |
|---|---|---|
| Week counting | **Calendar weeks since first seen.** `week_number = weeksBetween(first_seen_week, current_week) + 1`. Absences do not pause it. | Matches how a coordinator says "he's been here 6 weeks". No state to maintain, fully recomputable from `first_seen_week` alone. |
| Backfill | **Derive from existing upload history** — walk every validated upload chronologically and take each id's earliest week. | Some current pickers really are mid-ramp; a blanket "everyone is a veteran" seed would miss them. See §4 for the horizon guard. |
| Ramp length | **Armadores 10 weeks** (with goals), **repartidores 4 weeks** (label only). | Per request: "after week 10, no need to specify his week"; "repartidores get 4 weeks of labeling, there's no need to track them more time". |
| Flagging goal | **`mínimo`**, not `esperado`. `esperado` is displayed as context only. | Per request: "Use the mínimo as their individual goal (that's their metric for the weekly report, not the hub standard)". |
| Re-entry | Gap of **≥ 10 consecutive calendar weeks** absent → `(RI)` badge for **2 weeks** on return. **Label only — no target, by design.** | Per request. Confirmed rationale: "they've done it before, we expect they get on with it quicker, but not since day one — that's why the RI label works." A returning person gets the veteran target and a flag on the coordinator's attention, which is precisely the middle ground between `S1` and nothing. |
| Surface | **A badge next to the name, everywhere the name appears.** | Per request. |
| KPI scope | `tasa_armado` only. Table is keyed by `kpi_id` so more can be added from `/config` later without code. | Keeps blast radius small. |
| Peer means / z-scores | **Unchanged.** Trainees still count toward the hub mean. | Confirmed. |

---

## 2. Data model

Two new tables. Two migrations, following the existing naming convention.

### 2.1 `person_tenure` — the derived ledger

`supabase/migrations/20260819000001_person_tenure.sql`

```sql
create table if not exists person_tenure (
  person_key        text not null,          -- operator_id / driver_id — the stable identity
  role              text not null check (role in ('armador','repartidor')),
  first_seen_week   date not null,          -- Friday week_start of first appearance
  last_seen_week    date not null,
  weeks_seen        int  not null default 1,-- distinct weeks they actually appear (diagnostic)
  seen_weeks        date[] not null default '{}',  -- every week they appear — drives re-entry detection (§5.2)
  display_names     text[] not null default '{}',  -- every distinct name seen for this id, most recent first
  hub_id_first      text,
  hub_id_last       text,
  city_last         text,
  confidence        text not null default 'high'
                    check (confidence in ('high','low')),
  confidence_reason text,                   -- 'data_horizon' | 'missing_prior_week' | null
  source            text not null default 'derived'
                    check (source in ('derived','manual')),
  updated_at        timestamptz not null default now(),
  primary key (person_key, role)
);

create index if not exists person_tenure_role_first_seen
  on person_tenure (role, first_seen_week desc);
```

**Notes**

- `first_seen_week` is the ONLY field the S-number is computed from. `seen_weeks` is the only field the `(RI)` badge is computed from. Everything else is diagnostic or display.
- `seen_weeks` is bounded by the number of weeks in the dataset (~52+) — a small array per row, cheap to store and to scan client-side. Keep it sorted ascending.
- `confidence = 'low'` means "we cannot trust that this was really their first week" — such people are treated as **graduated veterans**, never as `S1`. See §4.
- `source = 'manual'` rows are never overwritten by the refresh job. That's the escape hatch for a wrong derivation or a rehire under a new id.
- No `week_number` column. Storing it would go stale the moment a week passes. Derive it at read time.

### 2.2 `kpi_ramp_targets` — the ramp table

`supabase/migrations/20260819000002_kpi_ramp_targets.sql`

```sql
create table if not exists kpi_ramp_targets (
  id            uuid primary key default gen_random_uuid(),
  kpi_id        text not null references kpis(id) on delete cascade,
  role          text not null check (role in ('armador','repartidor')),
  week_number   int  not null check (week_number between 1 and 52),
  target_value  numeric not null,      -- "mínimo" — DISPLAY units. THIS is what flags.
  stretch_value numeric,               -- "esperado" — DISPLAY units. Display only, never flags.
  comparator    text not null check (comparator in ('gte','lte','gt','lt')),
  unit          text not null,          -- snapshot of kpis.unit
  active        boolean not null default true,
  updated_by    text,
  updated_at    timestamptz not null default now(),
  unique (kpi_id, role, week_number)
);
```

`unique (kpi_id, role, week_number)` is safe here — **no nullable column participates**, so the `NULL != NULL` footgun from `kpi_targets` (HANDOFF §12) does not apply. Do not add a nullable scope column to this table; if per-hub ramps are ever wanted, that's a separate design conversation.

**`target_value` and `stretch_value` are in DISPLAY units**, exactly like `kpi_targets` — `65` means 65 SKUs/hr. Reuse `toDisplayUnits` inside `_shared.ts`; do not add a second conversion site.

> ⚠️ **`stretch_value` must never reach `meetsTarget`.** Only `target_value` (mínimo) decides whether someone is flagged. `esperado` exists purely so the coordinator sees where the person is *heading*. If a future refactor makes `stretch_value` participate in flagging, trainees get flagged for missing an aspirational number — the exact false-alarm problem this whole feature exists to remove.

### 2.3 Seed — the ramp table

```sql
insert into kpi_ramp_targets (kpi_id, role, week_number, target_value, stretch_value, comparator, unit)
values
  ('tasa_armado','armador', 1,  50,  55, 'gte', 'rate'),
  ('tasa_armado','armador', 2,  60,  65, 'gte', 'rate'),
  ('tasa_armado','armador', 3,  65,  70, 'gte', 'rate'),
  ('tasa_armado','armador', 4,  70,  75, 'gte', 'rate'),
  ('tasa_armado','armador', 5,  75,  80, 'gte', 'rate'),
  ('tasa_armado','armador', 6,  80,  85, 'gte', 'rate'),
  ('tasa_armado','armador', 7,  85,  90, 'gte', 'rate'),
  ('tasa_armado','armador', 8,  90,  95, 'gte', 'rate'),
  ('tasa_armado','armador', 9,  95, 100, 'gte', 'rate'),
  ('tasa_armado','armador',10, 100, 100, 'gte', 'rate');
```

Notes on the seed:

- Week 10's mínimo (100) equals the veteran target, so week 10 is functionally graduation — the row exists so the `(S10)` badge and the "meta S10: 100" line still render. `esperado` for week 10 is "100+", which is not a number; store `100` and let the UI render `100+` when `week_number === 10`. Do not invent a value above 100.
- `comparator = 'gte'` because `tasa_armado` is **higher_is_better** via the code override in `lib/kpi-direction.ts` — the DB `kpis.direction` may say `lower_is_better` and must be ignored (HANDOFF §12). Derive the comparator from `effectiveDirection('tasa_armado', kpi.direction)` in application code; the literal above is only the seed.
- **No rows for `repartidor`.** Drivers are label-only in this build. `resolvePersonTarget` finding no ramp row for a role is a normal, expected path — it must fall through to the hub/global target without warning.

---

## 3. `lib/tenure.ts` — the new module

Single source of truth for tenure, mirroring the `lib/hub-aliases.ts` / `lib/kpi-direction.ts` pattern. Nothing else in the codebase may derive a week number or a badge string.

```ts
export const RAMP_WEEKS: Record<Role, number> = { armador: 10, repartidor: 4 };
export const REENTRY_GAP_WEEKS = 10;   // absent this many consecutive CALENDAR weeks → reingreso on return
export const REENTRY_LABEL_WEEKS = 2;  // how long the (RI) badge shows

export type Role = 'armador' | 'repartidor';

export interface TenureRow {
  person_key: string;
  role: Role;
  first_seen_week: string;      // ISO Friday
  last_seen_week: string;
  seen_weeks: string[];         // sorted ascending
  display_names: string[];
  confidence: 'high' | 'low';
  source: 'derived' | 'manual';
}

export type TenureStatus =
  | { kind: 'trainee';  week: number }   // 1..RAMP_WEEKS[role]
  | { kind: 'reentry';  week: number }   // 1..REENTRY_LABEL_WEEKS
  | { kind: 'veteran' };

/** Fri–Thu weeks between two week_start Fridays. */
export function weeksBetween(fromIso: string, toIso: string): number;

/**
 * Full status for a person in a given week. Precedence: reentry > trainee > veteran.
 * Returns 'veteran' when: no ledger row, confidence==='low', past the ramp,
 * or the displayed week predates first_seen_week.
 */
export function tenureStatus(row: TenureRow | undefined, weekStart: string): TenureStatus;

/** ' (S4)' | ' (RI)' | '' — the ONLY place a badge string is formatted. */
export function tenureLabel(status: TenureStatus): string;

/** Name-keyed lookup for joining to peer_comparisons.entity_key. */
export function buildTenureNameIndex(rows: TenureRow[]): Map<string, TenureRow>;

/** Idempotent rebuild of person_tenure from upload history. See §4. */
export async function refreshTenureLedger(opts?: { role?: Role; dryRun?: boolean }): Promise<TenureRefreshResult>;
```

`buildTenureNameIndex` normalizes with the **same** normalizer as `lib/validate-identity.ts` (`normalizeName`: NFD accent strip → lowercase → trim → collapse whitespace). **Extract that function into a shared place** (`lib/normalize.ts`, or export it from `validate-identity.ts` and import it in both) rather than copy-pasting it — the hub-alias-map divergence in HANDOFF §12 is exactly what a second copy causes.

---

## 4. `refreshTenureLedger()` — the derivation algorithm

This is the heart of the feature. Get it right and everything downstream is trivial.

```
For each role → source app:
    armador     → app_id 'desempeno_operadores',   id field 'operator_id',  name field 'assembler'
    repartidor  → app_id 'desempeno_repartidores', id field 'driver_id',    name fields 'driver_name' || 'driver_nickname'

1. Load every validated upload for the app, ordered by week_start ascending.
   → weeksWithData: Set<weekStartIso>   (weeks we actually have a file for)
   → dataHorizon  = min(weeksWithData)

2. For each upload, fetch its rows ONE UPLOAD AT A TIME
   (eq('upload_id', id).limit(10_000) — never ORDER BY id, never IN(...) with range
    pagination; see HANDOFF §9 for why both of those time out).

3. For each row:
     person_key = String(data[idField]).trim()
     name       = first non-empty of the name fields
     skip the row if person_key is empty  →  count into result.skipped_no_id
   Build per person_key:
     first_seen_week = min(week_start)
     last_seen_week  = max(week_start)
     seen_weeks      = sorted distinct week_starts
     display_names   = distinct names, most recent first

4. Confidence guard — decide whether first_seen_week is really a hire:
     a) first_seen_week === dataHorizon
          → confidence 'low', reason 'data_horizon'
            (everyone present in the earliest week we have looks "new" but isn't)
     b) the Friday immediately preceding first_seen_week is NOT in weeksWithData
          → confidence 'low', reason 'missing_prior_week'
            (a skipped upload week makes returning veterans look brand new)
     c) otherwise → 'high'

5. Upsert into person_tenure, keyed on (person_key, role).
   NEVER touch rows where source='manual'.
   Deduplicate the batch on the conflict key before upserting and write in
   sequential 200-row batches — same pattern as parallelUpsert in kpi-compute.ts.

6. Warn (do not fail) when two distinct person_keys of the same role share a
   normalized display name — the name index will collide. See §11 footguns.
```

**Why step 4 matters.** Without (a), the very first week of data in the DB would mark every armador in the company as `S1` and hand them all a 50-SKU/hr goal — a spectacular and very visible wrong answer. Without (b), any week where the operators file was never uploaded turns the following week into a mass "new hire" event. `confidence='low'` people are treated as veterans, which is the safe failure direction: the cost of a wrong "veteran" is a missing badge; the cost of a wrong `S1` is a 10-year veteran being graded against 50 SKUs/hr.

**Where it runs.** Call `refreshTenureLedger()` from:

- `app/api/recompute/route.ts`, before `computeSnapshotsForWeek` — so a recompute always refreshes tenure.
- `app/api/upload/route.ts`, after a successful `desempeno_operadores` / `desempeno_repartidores` insert (fire-and-forget is fine; a failure here must not fail the upload).

Do **not** derive tenure at page-render time by scanning `upload_rows`. `/historicos` already runs 6 parallel paginated fetch batches; adding a full history scan there would blow the load budget. The ledger is a few hundred rows and is read with one flat `select`.

---

## 5. Status resolution

### 5.1 S-number

```
weekNumber = weeksBetween(first_seen_week, displayedWeek) + 1
trainee if 1 <= weekNumber <= RAMP_WEEKS[role]   (10 armador / 4 repartidor)
```

Guard rails, all of which return `veteran`:

- no ledger row for the name
- `confidence === 'low'`
- `weekNumber > RAMP_WEEKS[role]`
- `weekNumber < 1` (the displayed week predates their first appearance — happens constantly when browsing historical weeks; never render `S0` or a negative)

### 5.2 Reingreso `(RI)`

**Gap is measured in calendar weeks.** Decided deliberately: 10 weeks is far too long to be an upload glitch. If someone is missing for 10 straight weeks it's because they're actually gone, or because the tool wasn't being used at all — and in the second case the whole dashboard is stale anyway, so an `(RI)` badge is the least of the problems.

```
returnWeeks(person) = every week W in seen_weeks such that
                      weeksBetween(previousAppearance, W) >= REENTRY_GAP_WEEKS   // calendar
                      (the person's first-ever appearance is NOT a return)

status = reentry  ⟺  ∃ R in returnWeeks(person) with
                     0 <= weeksBetween(R, displayedWeek) < REENTRY_LABEL_WEEKS
```

Precompute `returnWeeks` per person once when building the name index; don't rescan `seen_weeks` on every render.

#### The one guard to keep (this is not "data weeks", it's an evidence check)

Calendar counting has exactly one failure mode worth code: **a gap window in which the app has no uploads at all.** That isn't someone being absent — it's us having no data. It'll happen at least once for real, when `desempeno_repartidores` history starts later than `desempeno_operadores`, or across any stretch where a whole app went un-uploaded. Without a guard, the first week after such a stretch stamps `(RI)` on the **entire roster** simultaneously.

```
Suppress the reentry status when the gap window [previousAppearance, R)
contains ZERO validated uploads for that app.
```

Note the asymmetry, and keep it: a window with *some* uploads where the person simply didn't show → `(RI)`, exactly as intended. A window with *no* uploads at all → no claim either way, so no badge. `weeksWithData` from §4 is already computed there; pass it through. This costs nothing in the normal case and only fires in the "I wasn't using the tool" case Jose already named.

A mass-`(RI)` event in the dry run is the symptom that this guard is missing or wrong — see §10.

#### `(RI)` never changes a target

Confirmed design intent, not an assumption: a returning person gets the **veteran target**. The point of the label is that they've done the job before, so they should pick it back up faster than a day-one hire — but not instantly. `(RI)` buys them the coordinator's attention, not a lower bar. There is deliberately no `kpi_ramp_targets` row, and no ramp week, associated with reingreso.

Interaction with an unfinished ramp: someone who left at `S3` and returns 11 weeks later is at calendar `S14` — a veteran by the counting rule, so veteran target, `(RI)` badge. The badge wins the label; the target is unchanged. This is the intended behavior, not an edge case to "fix".

### 5.3 Target — extending `_shared.ts`

Today: `resolveTarget(kpiId, hubId, targets)` → hub row > global row > undefined (caller falls back to its own code default).

Add **one** function; do not change `resolveTarget`'s behavior or signature.

```ts
export interface RampTarget {
  kpi_id: string;
  role: 'armador' | 'repartidor';
  week_number: number;
  target_value: number;          // mínimo — DISPLAY units — the flagging threshold
  stretch_value: number | null;  // esperado — DISPLAY units — display only
  comparator: 'gte' | 'lte' | 'gt' | 'lt';
  unit: string;
  active: boolean;
}

/**
 * Effective target for ONE PERSON.
 * Precedence: ramp row (only when status.kind === 'trainee') > hub target > global target > undefined.
 * Returns a KpiTarget-shaped object built from target_value (mínimo) so
 * meetsTarget() works unchanged. stretch_value is returned alongside, never inside.
 */
export function resolvePersonTarget(
  kpiId: string,
  hubId: string | null,
  status: TenureStatus,
  role: 'armador' | 'repartidor',
  targets: KpiTarget[],
  ramps: RampTarget[],
): { target: KpiTarget | undefined; stretch: number | null };
```

#### The single most important rule in this section

> **`resolvePersonTarget` is for entity-level comparisons only.** Hub tiles, the `PorKpiTab` main chart's `meta` reference line, and every `kpi_snapshots`-derived number keep calling plain `resolveTarget`. A hub's target is the veteran target regardless of who works there. If a ramp value ever leaks into a hub-scope calculation, the hub goal silently drops whenever a trainee is hired — a bug that would be very hard to spot from the dashboard.

Also: `meetsTarget` and `TARGET_EPS` are reused as-is. The strict (non-inclusive) boundary from HANDOFF §12 applies to ramp targets too — hitting exactly the mínimo does not clear it. Do not "fix" that.

---

## 6. Threading the data to the UI

`app/(app)/historicos/page.tsx` already fetches `kpi_targets` in its parallel batch. Add two more small flat selects to the same batch:

```ts
sb.from('person_tenure').select('*'),
sb.from('kpi_ramp_targets').select('*').eq('active', true),
```

Both are small (hundreds / tens of rows) — no pagination needed, but keep them inside the existing `Promise.all` so they cost no extra round-trip latency.

Pass down through `HistoricosClient` → `PorHubTab` / `GenerarReporte` as props, exactly like `targets`. Build the name index **once** in `HistoricosClient` with `useMemo` (two indexes: one per role) and pass the `Map`s down, not the raw array — every consumer does name lookups and rebuilding the map per tile flip is wasteful.

### Badge placement checklist

The badge renders anywhere a person's name is shown:

- `PorHubTab.tsx` — KPI tile **back face** ranked lists (assembler **and** driver KPIs).
- `PorHubTab.tsx` — `AssemblerWowSection` **and** `DriverWowSection`: `<MultiSelectDropdown>` option labels, chart legend, `WowTooltip` rows.
- `PorHubTab.tsx` — anywhere else an `entity_key` is printed for `entity_type` `operator` or `driver`.
- `components/GenerarReporte.tsx` / `app/api/generar-reporte/route.ts` — every assembler and driver line in the report text (§7).
- `PorKpiTab.tsx` — no person names are rendered there today; nothing to do.

Implementation: one helper, used everywhere, never an inline template string.

```ts
const status = tenureStatus(tenureByName.get(normalizeName(entity_key)), weekStart);
const label  = tenureLabel(status);   // ' (S4)' | ' (RI)' | ''
```

Render it as muted/secondary text (`text-[var(--muted)]`) so it reads as an annotation, not part of the name.

⚠️ The badge must be computed **for the week being displayed**, not for today. `/historicos` shows historical weeks; a picker who is `S9` today was `S4` five weeks ago and the tooltip for that week should say `S4`. `tenureStatus(row, weekStart)` already takes the week — make sure every call site passes the *displayed* week, never `new Date()`.

---

## 7. Report wiring (`GenerarReporte.tsx` + `api/generar-reporte/route.ts`)

This is where the feature earns its keep: a trainee at 62 SKU/hr in week 3 (mínimo 65) should appear on a **supervision** list, not on the coordinator's slow-assembler list; a trainee at 68 in week 3 should appear on neither.

1. **Type change** — `PeerEntity` in `route.ts` gains three optional fields:
   ```ts
   PeerEntity {
     name, value, flagged, numOrders?,
     tenureBadge?: string,      // 'S3' | 'RI'
     personalTarget?: number,   // mínimo, display units
     personalStretch?: number,  // esperado, display units
   }
   ```
   Keep them optional so every other KPI group is unaffected.

2. **`buildBundle()`** — for the `tasa_armado` group only, flag per entity with
   `meetsTarget(entity.value, resolvePersonTarget(...).target)` instead of the single group-level target.
   Set the three new fields on trainee entities. `resolveEffectiveTarget()`'s existing `defaultThreshold` fallback stays as the final fallback for veterans — do not delete it.
   For driver KPI groups, set `tenureBadge` only (no ramp rows exist for repartidores, so their targets are unchanged).

3. **`buildTextBundle()`** — keep the existing "pre-resolve the list, Claude just copies it" pattern (HANDOFF §13). Emit trainees as their **own block** so the coordinator reads them as a supervision item, not a performance problem:

   ```
   Armadores lentos (meta general <100):
   - Nombre: 78.4 SKUs/hr

   Armadores en entrenamiento por debajo de su mínimo:
   - Nombre (S3): 62.1 SKUs/hr — mínimo S3: 65 (esperado 70)
   ```

   Rules for that block:
   - A trainee at or above their mínimo appears in **neither** list.
   - A trainee below their mínimo appears **only** in the training block — never in "Armadores lentos", even though they're below 100.
   - A veteran below 100 stays in "Armadores lentos" exactly as today.
   - `(RI)` people are veterans for flagging purposes; the badge just rides along on whatever line they'd normally appear on.

4. **`SYSTEM_PROMPT`** — add one rule, worded in the same imperative style as the existing `escribir esta línea exacta` rules:
   > `Armadores en entrenamiento por debajo de su mínimo:` es un encabezado literal. Copia las líneas tal cual, con el `(Sx)`, el mínimo y el esperado. No mezcles esta lista con la de armadores lentos. Si el bloque viene vacío, omite el encabezado por completo. `(RI)` significa reingreso — cópialo junto al nombre, no lo expliques.

   ⚠️ The prompt is load-bearing and fragile (HANDOFF §13). Change only this — do not restructure the four main section headers.

5. **`UMBRAL:` line** — unchanged for the group (still the veteran target). The per-trainee mínimo is carried inline on each line, so the group header stays honest.

---

## 8. `/config` — "Entrenamiento / Rampa" section

New component `app/(app)/config/RampTargetsSection.tsx`, matching `KpiTargetsSection.tsx`'s conventions (auto-save on blur, per-input saving/saved/error state, no Guardar button).

- A 10-row table for `tasa_armado` / `armador`: week number → **mínimo** input → **esperado** input. Placeholder on each row shows the veteran target so it's obvious what week 11 inherits. Label the columns exactly `Mínimo (meta individual)` and `Esperado (referencia)` so nobody later assumes esperado flags.
- Below it, **"En entrenamiento"** — read-only list of everyone currently badged: name, role, hub, badge (`S3` / `RI`), first-seen week, confidence. This is the supervision view, and it's also how Jose sanity-checks the derivation.
- A small **override** control per person: set `first_seen_week` by hand (writes `source='manual'`) or "Graduar" (marks them a veteran). Needed because a rehire under a new id, or a bad derivation, has no other fix. Manual rows are excluded from refresh overwrites (§4 step 5).

API: `app/api/ramp-targets/route.ts` — `GET` / `PUT` / `DELETE`, auth-checked like `/api/kpi-targets`. A plain `upsert(onConflict: 'kpi_id,role,week_number')` **is** safe here (no nullable key) — unlike `kpi_targets`. Say so in a comment so a future reader doesn't "fix" it into delete-then-insert.

A second small route `app/api/person-tenure/route.ts` handles the manual overrides (`PUT` one person, `DELETE` to revert to derived).

---

## 9. Build order

Ship in slices, each independently verifiable. Push to git (→ Netlify deploy) only at the marked points.

| # | Slice | Verify before moving on |
|---|---|---|
| 1 | `lib/tenure.ts` + `refreshTenureLedger()` **as a read-only dry-run script**, no migration, no writes | Run against production data; print the derived ledger to console for both roles. Jose eyeballs it: do the people it badges match reality? Are the `low`-confidence counts sane? Are the `(RI)` hits real returnees? **Do not proceed until this passes.** |
| 2 | Migration 1 (`person_tenure`) + real backfill run + refresh hooks in `/api/recompute` and `/api/upload` | `select role, confidence, count(*) from person_tenure group by 1,2;` Re-run the refresh twice — row count and `first_seen_week` values must be byte-identical (idempotency). |
| 3 | Migration 2 (`kpi_ramp_targets`) + seed (§2.3) + `/config` ramp editor + `/api/ramp-targets` | Edit a week's mínimo in `/config`, reload, confirm it round-trips and that esperado is stored separately. |
| 4 | `resolvePersonTarget` + `tenureStatus` in `lib/tenure.ts` / `_shared.ts` + unit tests | Test cases in §10. |
| 5 | Badges everywhere (§6), both roles | Visual pass on one hub with at least one trainee; check the badge on a *historical* week shows the lower S-number. |
| 6 | Report wiring (§7) | Generate a real report for a hub with a trainee; confirm the trainee is in the training block, not the slow block, and that a veteran below 100 is still flagged. |
| 7 | `/config` supervision list + manual overrides | Set an override, re-run refresh, confirm it survives. |

Suggested commits:

```
feat(tenure): lib/tenure.ts — derived tenure ledger + dry-run script
feat(tenure): person_tenure migration + backfill + refresh hooks
feat(config): kpi_ramp_targets migration/seed + Rampa editor + API
feat(tenure): tenureStatus + resolvePersonTarget + unit tests
feat(historicos): (Sx)/(RI) badges on person names across tiles, charts, tooltips
feat(report): trainees flagged against their mínimo, separate report block
feat(config): supervision list + manual tenure overrides
```

Type-check between slices with `npx tsc --noEmit`, **not** `npm run build` — running a production build while `npm run dev` is live corrupts `.next` (HANDOFF §12).

---

## 10. Verification — required test cases

Unit tests for `tenureStatus` + `resolvePersonTarget`:

| Case | Expectation |
|---|---|
| No ledger row for the name | `veteran`; resolves to hub/global target |
| `confidence='low'` row | `veteran` (never a trainee) |
| `first_seen_week` == displayed week | `S1`, target 50, stretch 55 |
| `first_seen_week` 2 weeks before displayed week | `S3`, target 65, stretch 70 |
| `first_seen_week` 9 weeks before | `S10`, target 100, stretch rendered as `100+` |
| `first_seen_week` 10 weeks before | veteran, no badge, veteran target |
| Displayed week **before** `first_seen_week` | veteran, no badge (never `S0` or negative) |
| Repartidor, `first_seen_week` 3 weeks before | `S4`; **no** ramp row exists → hub/global target unchanged |
| Repartidor, `first_seen_week` 4 weeks before | veteran (4-week cap) |
| Absent 10 calendar weeks, present this week | `RI`, veteran target |
| Absent 10 calendar weeks, 3 weeks after return | veteran (RI label expired after 2 weeks) |
| Absent 10 calendar weeks, **some** uploads exist in the window | `RI` — they were genuinely absent |
| Absent 10 calendar weeks, **zero** uploads in the whole window | **not** `RI` — no evidence either way (§5.2 guard) |
| Person's very first appearance | `S1`, never `RI` — a first appearance is not a return |
| Trainee at `S3` who left and returned 11 weeks later | `RI` badge, **veteran** target (calendar puts them at S14) |
| Trainee at `S3`, hub override exists for `tasa_armado` | Ramp mínimo wins over the hub override |
| Veteran, hub override exists | Hub override wins (unchanged behavior) |
| Value exactly equal to the mínimo | **Not** met — strict boundary (HANDOFF §12) |

Integration checks against production data (read-only where possible):

- A picker known to be new appears as the expected `S`-number.
- A picker who was **absent last week but present the week before** is **not** `S1`. This is the specific glitch case that motivated the feature — find such a person in the history and test it explicitly.
- Total badged count for the current week is plausible (single digits per role, not "every armador in the company").
- `(RI)` hits are cross-checked against reality. A handful is expected. **A mass-`(RI)` event — dozens at once, all returning the same week — means the §5.2 zero-uploads guard is missing or wrong.** Print the gap window and the upload count in that window for every `(RI)` hit in the dry run so this is obvious at a glance.

---

## 11. Footguns and open questions

### Footguns to write into `HANDOFF.md` §12 when this ships

| Issue | Detail |
|---|---|
| Never diff consecutive weeks for "new person" | A person is new iff their id appears in **no** prior week. Diffing week N vs N−1 breaks on vacations, sick weeks, and missed uploads. |
| Tenure identity is `operator_id` / `driver_id`, display is name | `peer_comparisons.entity_key` stores the **name**. Join through the normalized-name index; never assume the name is stable across weeks. |
| `confidence='low'` ⇒ veteran, not `S1` | Anyone first seen in the earliest week of data, or right after a week with no upload, cannot be assumed new. Failing toward "veteran" is the safe direction. |
| `mínimo` flags, `esperado` never does | `target_value` is the only field `meetsTarget` sees. `stretch_value` is display-only context. Wiring esperado into flagging reintroduces exactly the false alarms this feature removes. |
| Re-entry gaps are **calendar** weeks, with one evidence guard | 10 weeks is too long to be a glitch, so calendar counting is correct. The single exception: if the gap window contains **zero** validated uploads for that app, suppress `(RI)` — that's missing data, not an absent person, and without the guard the first week after such a stretch badges the entire roster at once. |
| `(RI)` never changes a target | It is a supervision label. Returning people get the veteran target — they've done the job before, so they should ramp back fast, but the badge is what buys them attention, not a lower bar. Never attach a ramp row to reingreso. |
| `resolvePersonTarget` is entity-scope only | Hub tiles and chart reference lines must keep using `resolveTarget`. A ramp value in a hub-scope calculation silently lowers the hub's goal whenever someone is hired. |
| Badge uses the **displayed** week | `tenureStatus(row, weekStart)` — never `new Date()`. Historical views must show the badge as of that week. |
| Repartidores have no ramp rows | Label-only, 4 weeks. `resolvePersonTarget` finding no ramp row is a normal path, not an error — do not log or warn on it. |
| `kpi_ramp_targets` unique is safe; `kpi_targets` is not | No nullable column in the ramp table's unique key, so a plain upsert is fine here. Don't cargo-cult the delete-then-insert pattern from `/api/kpi-targets`. |
| Two people, same name | Tenure is keyed by id, so the ledger is correct — but the *name index* used for display collides. Warn during `refreshTenureLedger`, and show both badges rather than guessing. |
| `refreshTenureLedger` must be idempotent | It is a full rebuild from history, not an incremental diff. Running it twice must produce identical rows. Never overwrite `source='manual'`. |

### Open questions

None blocking. Every design question raised during planning has been answered:

- Ramp table → §2.3 (mínimo flags, esperado is context)
- Re-entry → §5.2 (calendar gap, 2-week label, no target change)
- Trainees in hub means → yes, unchanged
- Repartidores → 4 weeks, label only

The only thing that can still change the shape of this build is the **slice-1 dry run** (§9). If the derived ledger doesn't match reality — wrong people badged, implausible counts, a mass-`(RI)` event — stop and fix the derivation before writing a single migration. Everything downstream assumes the ledger is right.

---

## 12. What this feature deliberately does NOT do

- It does not add a hire-date field or ask anyone to maintain one. The whole point is that tenure falls out of data that already arrives every week.
- It does not change any stored `kpi_snapshots` or `peer_comparisons` value. No recompute is needed to adopt it, and nothing historical is rewritten.
- It does not exclude trainees from any aggregate — they still count toward the hub mean and their own z-scores (confirmed decision).
- It does not give repartidores a ramped goal — 4 weeks of labeling only.
- It does not apply to MNA, faltantes, or incidentes.

**Rollback:** `update kpi_ramp_targets set active = false;` — every trainee immediately falls back to the veteran target and the report reverts to its current behavior. Badges keep rendering (they read from `person_tenure`, which is inert data); to drop those too, guard the badge render on `ramps.length > 0`.
