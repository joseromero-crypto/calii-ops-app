# Feature Spec — Configurable KPI Targets (global + per-hub)

**For:** Claude Code, working in `~/Desktop/calii-ops-app`
**Author:** Jose Romero
**Related:** `HANDOFF.md` (read §12 Known Footguns, §13 Weekly Report Generator, §7–8 dashboard tiles before starting)

---

## 1. Goal

Add the ability, from the **`/config`** page, to set KPI **targets** (a.k.a. thresholds / umbrales):

- **Globally** — one target for a KPI that applies to every hub.
- **Per hub** — an override for one or more specific hubs that beats the global value.

These targets must:

1. Drive the **AI report** (`Generar reporte`) — replace the hardcoded thresholds so the `UMBRAL:` lines and flagging use the configured value for the hub being reported.
2. Show on the **dashboard** — as a target reference line on tiles/charts, and as an optional target-based coloring mode on the KPI tiles.

**Motivating example:** `tasa_armado` target was `90`. We want to raise it to `95`, then eventually `100`, and let one or two hubs run a different number — all editable from `/config` without a code change or redeploy.

**Scope confirmed:** all KPIs get a configurable target (including the driver KPIs that today use "outlier > 2× hub mean" — those get an *optional* fixed target that, when set, overrides the 2× rule).

---

## 2. Core design decisions (read before coding)

### 2.1 Precedence
When resolving the target for a given `(kpi_id, hub_id)`:

```
hub-specific target  >  global target  >  code default (existing hardcoded constant)
```

The code default must remain as a final fallback so nothing breaks if a target row is missing. Never hard-fail on a missing target.

### 2.2 Units — store in DISPLAY units, not fractions
The DB stores pct KPIs as **0–1 fractions** and `tasa_armado`/rate as raw, currency as raw MXN (HANDOFF §3, §12). This has caused repeated bugs.

**Store targets in the units a human types in `/config`** (e.g. `95` for tasa_armado, `6` for a 6% threshold, `50000` for a currency target). Do the ×100 / ÷100 conversion at the point of comparison, in exactly one helper, and document it. Do **not** store fractions in the targets table — it will drift out of sync with the display layer.

Add a `unit` snapshot column on the target row (copy of `kpis.unit`) so the comparison helper knows how to convert without a join.

### 2.3 Direction / "good" side
Each KPI already has a direction (`higher_is_better` / `lower_is_better`), but note the **`tasa_armado` override footgun** (HANDOFF §12): the DB `direction` may be wrong and is overridden in code to `higherIsBetter: true`. The target comparison must use the **effective** direction (the code override), not raw `kpis.direction`. Reuse the existing `effectiveHigherIsBetter` logic — do not reintroduce a second source of truth.

Store on each target a `comparator` so the report's `UMBRAL` label is unambiguous: `gte` / `lte` / `gt` / `lt`. Default it from the effective direction but let it be explicit.

### 2.4 Optional targets for "2× hub mean" KPIs
Driver KPIs `pct_tardias_reparto` and `pct_undelivered` currently flag on `> 2× hub mean` (HANDOFF §13). Make the fixed target **nullable**:
- target set → use fixed threshold.
- target null → keep existing 2× hub-mean behavior.

Expose this in `/config` as an optional field ("leave blank to use 2× hub average").

---

## 3. Data model

New table. Add a migration under `supabase/migrations/` (follow the existing naming, e.g. `20260718000001_kpi_targets.sql`).

```sql
create table if not exists kpi_targets (
  id           uuid primary key default gen_random_uuid(),
  kpi_id       text not null references kpis(id) on delete cascade,
  scope_level  text not null check (scope_level in ('global','hub')),
  scope_key    text,                       -- null when global; hub_id when hub
  target_value numeric not null,           -- stored in DISPLAY units (see §2.2)
  comparator   text not null check (comparator in ('gte','lte','gt','lt')),
  unit         text not null,              -- snapshot of kpis.unit
  active       boolean not null default true,
  updated_by   text,                       -- email
  updated_at   timestamptz not null default now(),
  unique (kpi_id, scope_level, scope_key)
);

-- NULL scope_key on the global row: Postgres treats NULL as distinct in UNIQUE,
-- so the (kpi_id,'global',NULL) uniqueness is NOT enforced by the constraint above.
-- Guard it with a partial unique index:
create unique index if not exists kpi_targets_global_uniq
  on kpi_targets (kpi_id) where scope_level = 'global';

create unique index if not exists kpi_targets_hub_uniq
  on kpi_targets (kpi_id, scope_key) where scope_level = 'hub';
```

> ⚠️ **NULL-in-UNIQUE footgun** (same class as the upload dedup bug, HANDOFF §5/§12): a plain `unique(kpi_id, scope_level, scope_key)` will **not** prevent duplicate global rows because `scope_key` is NULL for global. Use the partial unique indexes above (or store a sentinel like `'__global__'` in `scope_key` instead of NULL — pick one and be consistent everywhere).

**Seed** the table from the current hardcoded constants so behavior is unchanged on day one: one `global` row per KPI (`tasa_armado` → 90 gte-corrected to lte... use the *effective* comparator, i.e. `tasa_armado` bad when `< 90` so comparator describes the target as `>=90` good / flag when `lt`; keep it consistent with how `buildTextBundle` prints `UMBRAL: <90`). Put the seed in the same migration.

---

## 4. Files to touch

Inspect first — the handoff does not detail `/config` internals:

- `app/(app)/config/page.tsx` and any client component it renders — **read these first** to match the existing UI pattern (server fetch → client component, same as `/historicos`).
- `lib/hub-aliases.ts` — canonical hub list for the per-hub editor (HANDOFF §8). Use `HUB_ALIAS_MAP` / the resolved hub ids as the source of truth for which hubs exist. Do not hardcode a hub list.
- `lib/kpis` registry / wherever `kpis` are read.

Report path (HANDOFF §13):
- `components/GenerarReporte.tsx` — `ASSEMBLER_KPI_DEFS`, `DRIVER_KPI_DEFS`, `buildBundle()`, `effectiveHigherIsBetter`. This is where thresholds are applied client-side.
- `app/api/generar-reporte/route.ts` — `ReportBundle`/`KpiPeerGroup` types, `buildTextBundle()` (the `UMBRAL:` line), `SYSTEM_PROMPT`.

Dashboard path (HANDOFF §7–8):
- `app/(app)/historicos/PorHubTab.tsx` — KPI tiles (front-face reference line, color logic), WoW charts.
- `app/(app)/historicos/PorKpiTab.tsx` — main trend chart (add target line), heatmap (optional target coloring).
- `app/(app)/historicos/page.tsx` — server fetch: add a `kpi_targets` query to the parallel fetch batch and pass the array down through `HistoricosClient`.
- `app/(app)/historicos/_shared.ts` — add a `resolveTarget(kpiId, hubId, targets)` helper + `KpiTarget` type + the unit-conversion comparison helper (single source of truth).

---

## 5. Implementation steps

### Step 1 — Migration + seed
Create the table and partial indexes (§3). Seed one global row per KPI from the current constants so nothing visibly changes. Apply to the Supabase project (`nxwpsvvfgygafjnhwccc`). Verify with a quick select.

### Step 2 — Shared resolver (`_shared.ts`)
Add:

```ts
export type KpiTarget = {
  kpiId: string;
  scopeLevel: 'global' | 'hub';
  scopeKey: string | null;   // hub_id or null
  value: number;             // DISPLAY units
  comparator: 'gte' | 'lte' | 'gt' | 'lt';
  unit: string;
};

// hub override > global > undefined (caller falls back to code default)
export function resolveTarget(
  kpiId: string, hubId: string | null, targets: KpiTarget[]
): KpiTarget | undefined { /* ... */ }

// compares a DB value (fraction for pct) against a DISPLAY-unit target.
// Handles pct ×100, currency/rate pass-through. ONE place only.
export function isBelowTarget(dbValue: number, t: KpiTarget): boolean { /* ... */ }
export function meetsTarget(dbValue: number, t: KpiTarget): boolean { /* ... */ }
```

Write a couple of unit tests for the conversion (pct fraction 0.93 vs target 95 → below; tasa_armado 88 vs 90 → below).

### Step 3 — `/config` UI
In the config client component, add a **"Metas / Targets"** section:

- A row per KPI showing the **global** target (editable number input + comparator, or read the comparator from KPI direction and just show the number for simplicity — but keep comparator in the write).
- An expandable **per-hub override** area per KPI: list hubs (from `hub-aliases`), each with an optional number input. Blank = "usa la meta global"; for the 2× KPIs, blank = "usa 2× promedio del hub" (§2.4).
- Save writes to `kpi_targets` via an API route (see Step 4). Set `updated_by` = current user email (`APP_OWNER_EMAIL` / session), `updated_at` = now.
- Show the effective/global value as a placeholder in each hub input so it's obvious what a blank inherits.

Keep it consistent with the existing `/config` styling. Add optimistic UI or a simple save-and-refetch; do not block on a full page reload.

### Step 4 — Write API route
`app/api/kpi-targets/route.ts`:
- `GET` → return all active targets (also usable by other pages if needed).
- `PUT`/`POST` → upsert a target. **Use the delete-then-insert or explicit `onConflict` matching the partial unique index** — plain `upsert(onConflict: 'kpi_id,scope_level,scope_key')` will misbehave on the NULL global scope_key (same NULL-conflict class as HANDOFF §5). Simplest safe path: if `scope_level='global'`, match on `kpi_id` + `scope_level`; if `hub`, match on `kpi_id`+`scope_key`. Delete matching row(s) then insert, or use the sentinel-scope_key approach.
- A blank/cleared hub input should **DELETE** that hub's row (so it falls back to global), not write a null value.
- Auth-check like the other write routes (`/api/upload`).

### Step 5 — Wire targets into the AI report
1. `page.tsx` (or wherever GenerarReporte gets its data) already loads everything for `PorHubTab`. Fetch `kpi_targets` and pass the array into `GenerarReporte`.
2. In `buildBundle()` / `ASSEMBLER_KPI_DEFS` / `DRIVER_KPI_DEFS`: replace the hardcoded threshold used for flagging with `resolveTarget(kpiId, hub.id, targets)?.value ?? <existing constant>`. Use `effectiveHigherIsBetter` for the direction (do **not** touch the `tasa_armado` override — HANDOFF §12).
3. Add `target` (+ `comparator`) to the `KpiPeerGroup` type in `route.ts` and set it in the bundle.
4. `buildTextBundle()`: generate the `UMBRAL:` line from the bundle's `target`/`comparator` instead of the constant. So raising `tasa_armado` to 95 makes the line read `UMBRAL: <95` automatically. Keep the `tasa_armado` pre-filter-to-flagged-only behavior.
5. `SYSTEM_PROMPT`: it should already just consume the pre-resolved lists/UMBRAL text. Confirm it does not restate a numeric threshold anywhere hardcoded; if it does, make it reference the value from the bundle.

> ⚠️ Keep `ORDER_CODE_RE` / responsables sync (HANDOFF §9/§12) untouched — unrelated, but don't let a refactor drift them.

### Step 6 — Wire targets into the dashboard
1. `page.tsx`: add `kpi_targets` to the parallel fetch batch; thread through `HistoricosClient` → `PorHubTab` / `PorKpiTab`.
2. **PorHubTab tiles:** add a target **reference line** on the tile sparkline (in display units — remember pct ×100). Add a **target-based color mode**: tile green/red by `meetsTarget` vs the resolved target. Decide whether this replaces or coexists with the existing σ-vs-own-history coloring — recommend a small toggle ("vs meta" / "vs histórico") defaulting to the current σ behavior so you don't surprise existing users. The 4w-avg reference line stays.
3. **PorKpiTab main chart:** add a horizontal target line per selected KPI. If per-hub targets differ, either draw the global target line + note overrides, or draw one line per hub target — start with the global line to keep it readable.
4. Respect the derived-state / no-`useEffect`-on-hub-switch pattern (HANDOFF §8/§12) if target state interacts with hub switching. Never call `router.push` inside historicos (HANDOFF §4a/§12) — targets change nothing about that rule.

### Step 7 — Verify (do not skip)
- Change `tasa_armado` global target 90 → 95 in `/config`, save, reload. Confirm: (a) tile target line + coloring reflect 95, (b) generate a report for a hub and confirm `UMBRAL: <95` and that flagging changed accordingly.
- Set a **per-hub** override for one hub (e.g. Contry → 100), leave others global. Confirm only that hub's report/tile uses 100; others still 95.
- Clear the override → confirm it falls back to global.
- Test a pct KPI (e.g. an incidentes threshold) to confirm the ×100 conversion is right (a target of `6` should flag a stored `0.07`).
- Test a 2× KPI: blank → still 2×-mean behavior; set a number → fixed threshold used.
- Run `npm run build` / typecheck. Spot-check no other consumer of the old constants was missed (grep for the constant names).

---

## 6. Footguns to respect (from HANDOFF)

- **pct fraction vs display** (§12): DB pct = 0–1. Targets = display units. Convert in ONE helper.
- **`tasa_armado` direction override** (§12): use `effectiveHigherIsBetter`, keep the code override; the target's comparator must match it (`UMBRAL: <90/<95`).
- **NULL-in-UNIQUE** (§5/§12): global rows have NULL `scope_key` — use partial unique indexes or a sentinel; never plain `upsert onConflict` across a nullable key.
- **No `router.push` in historicos** (§4a): pass targets as props, sync via state only.
- **`rolling_mean_4w` / prev_week null** (§12): unrelated to targets, but the tile already computes fallbacks — don't tie target coloring to those null-prone DB fields.
- **Hub list source of truth** (§8): read hubs from `lib/hub-aliases.ts`, never hardcode.
- **Keep report constants as fallback**: don't delete `ASSEMBLER_KPI_DEFS` numbers — they become the final default when a target row is absent.

---

## 7. Suggested commit sequence

```
feat(config): kpi_targets table + migration/seed + write API route
feat(config): Metas UI — global + per-hub target editor
feat(report): report uses configured targets for UMBRAL + flagging
feat(historicos): target reference line + vs-meta tile coloring
test: target resolver + unit conversion; manual verification notes
```

Ship `git push` only after Step 7 passes (push triggers the Netlify deploy — HANDOFF §15).
