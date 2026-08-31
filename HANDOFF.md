# Calii Ops App — Engineering Handoff

**Last updated:** 2026-08-20 (session 14 — Modo Entrenamiento / tenure-aware targets)  
**Project:** Calii Ops Weekly Dashboard (Next.js 14 + Supabase, deployed on Netlify)  
**Prepared for:** Jose Romero / next session

> **Session 14 shipped Modo Entrenamiento** — a derived tenure ledger badges new armadores/repartidores by weeks-since-first-seen (`(S1)`–`(S10)` / `(RI)` reingreso) everywhere a person's name appears, and gives new armadores a ramped weekly `tasa_armado` target instead of judging them against the veteran KPI from day one. `PLAN_MODO_ENTRENAMIENTO.md` (project root) is now a historical build doc, not a pending task list — see §23 for what shipped. See §23 also for two RLS-migration footguns this session's own build hit.

> **Session 13 shipped an upload identity safety net** — catches "right file, wrong slot" mistakes (e.g. Saltillo's roster uploaded into the Monterrey slot) that the existing header/type validation can't see. See §22.

> **Session 12 shipped the "Resumen operativo" tab** — fully built, migrated, verified, and deployed. `PLAN_RESUMEN_OPERATIVO.md` (project root) is now a historical build doc, not a pending task list — see §21 for what actually shipped (it differs slightly from the plan: `ingresos_hub`'s numerator and the two open questions in the plan's §9 were resolved during the build, see §21's "Deviations from the plan"). Don't re-plan or re-build this feature from `PLAN_RESUMEN_OPERATIVO.md` without first checking current code/DB state.

> ⚠️ **This document lags the codebase in places.** Sections §1–§20 were last fully verified at session 11 (2026-07-17), with session 12/13 additions layered in for the Resumen operativo work and the upload identity safety net. The repo also contains `lib/generate-insights.ts`, `lib/classify-notes.ts`, `app/api/insights/*` and the `/prioridades` page — **none of which are documented below**. Treat §2's file table as incomplete and read the tree before assuming a file doesn't exist.

---

## 1. Project Overview

Internal ops dashboard for Calii hub operations. Tracks weekly KPIs per hub (MH), including assembler performance, driver performance, MNA (merma / no-apto), faltantes, and cash discrepancy. Data is uploaded weekly via a separate upload flow and computed into two main tables: `kpi_snapshots` and `peer_comparisons`.

The main feature areas:
- **`/historicos`** — historical analytics page with four tabs: Por KPI, Por Hub, Comparativa, Resumen (session 12 — see §21)
- **`/upload`** — weekly CSV upload flow
- **`/prioridades`** — priorities view
- **`/config`** — hub/KPI configuration

---

## 2. Key Files

| File | Role |
|---|---|
| `app/(app)/layout.tsx` | Server component — responsive shell, wires Sidebar (desktop) + MobileHeader (mobile) |
| `components/Sidebar.tsx` | Left nav — accepts optional `onClose` prop for mobile drawer mode |
| `components/MobileHeader.tsx` | Mobile-only sticky top bar + hamburger slide-in drawer |
| `app/(app)/historicos/page.tsx` | Server component — fetches ALL data from Supabase, passes to client |
| `app/(app)/historicos/HistoricosClient.tsx` | Client shell — owns `activeTab` + `activeKpi` state; tab + KPI switching is instant client-side |
| `app/(app)/historicos/loading.tsx` | Next.js loading skeleton — shown immediately while page.tsx fetches Supabase data |
| `app/(app)/historicos/PorHubTab.tsx` | "Por Hub" tab — KPI tiles + WoW charts + "Generar reporte" button |
| `app/(app)/historicos/PorKpiTab.tsx` | "Por KPI" tab — trend line chart, heatmap, top movers; receives `onKpiChange` callback |
| `app/(app)/historicos/ComparativaTab.tsx` | "Comparativa" tab — hub-vs-hub KPI grid; city filter removed (session 7) |
| `app/(app)/historicos/_shared.ts` | Shared types, formatting helpers, utility functions |
| `app/(app)/upload/loading.tsx` | Loading skeleton for /upload |
| `app/(app)/prioridades/loading.tsx` | Loading skeleton for /prioridades |
| `app/(app)/config/loading.tsx` | Loading skeleton for /config |
| `app/api/upload/route.ts` | Upload API — parses CSV, validates, stores upload + rows |
| `lib/kpi-compute.ts` | Core KPI computation — processes raw upload rows into snapshots + peer comparisons |
| `lib/hub-aliases.ts` | **Single source of truth** for hub name → hub_id mapping. Both kpi-compute and page.tsx import from here. Add new hubs/aliases here only. |
| `app/api/generar-reporte/route.ts` | POST endpoint — receives ReportBundle from client, calls Claude Haiku, returns Slack message text |
| `components/GenerarReporte.tsx` | "Generar reporte" button + modal — builds ReportBundle from page props, fetches incidentes erróneas, calls /api/generar-reporte |
| `lib/sku-classifier.ts` | Classifies product names into MnaCategory: 'fyv' / 'carnes' / 'abarrotes' |
| `lib/parse.ts` | CSV parsing + coerceRows (applies app_columns schema to raw CSV strings) |
| `lib/validate.ts` | Upload validation — header check, type check, distribution check |
| `lib/kpi-direction.ts` | **Session 11.** Single source of truth for the tasa_armado direction override (see §12) — `effectiveDirection()` / `defaultComparator()`. Shared by `/config`'s target editor and the report generator so the override isn't re-derived in two places. |
| `app/(app)/historicos/_shared.ts` | Shared types/helpers for `/historicos`. **Session 11:** also now home to `KpiTarget` type + `resolveTarget` / `meetsTarget` / `isBelowTarget` — the configurable-KPI-targets resolver (see §14). |
| `app/(app)/config/KpiTargetsSection.tsx` | **Session 11.** "Metas / Targets" editor on `/config` — global target per KPI + expandable per-hub overrides, auto-save on blur. See §14. |
| `app/api/kpi-targets/route.ts` | **Session 11.** GET/PUT/DELETE for `kpi_targets`. Delete-then-insert against the partial unique index (not a plain upsert) — see §14. |
| `supabase/migrations/20260717000001_kpi_targets.sql` | **Session 11.** Creates the real `kpi_targets` table (replacing an old, unused, differently-shaped speculative one from the original registry schema) + seeds it from the constants that were hardcoded pre-session-11. |
| `CONFIGURABLE_KPI_TARGETS.md` | Feature spec for the configurable KPI targets work (session 11) — design rationale, precedence rules, unit-conversion contract. Read this before touching targets code. |
| `PLAN_RESUMEN_OPERATIVO.md` | **Session 12 build doc — shipped 2026-07-31.** Original build instructions for the "Resumen operativo" tab. The feature is live; treat this as historical rationale (the weighting math, the footgun table), not a task list. See §21 for what shipped and how it diverged. |
| `app/(app)/historicos/ResumenTab.tsx` | **Session 12.** "📦 Resumen" tab — Total/city/hub expandable tree over the 8 `resumen_operativo` KPIs, client-side Total-row override for count/currency (§21), upload-completeness banner. |
| `app/(app)/historicos/ResumenCharts.tsx` | **Session 12.** `ResumenTrendChart` — WoW line chart used 3× on the Resumen tab (Pedidos entregados / AOV / Ingresos estimados), each with an independent Total · Por ciudad · Por hub scope toggle. See §21. |
| `supabase/migrations/20260731000001_kpi_unit_currency_avg.sql` | **Session 12.** Adds `currency_avg` to the `kpi_unit` enum. Own file — Postgres won't let a transaction use an enum value it just added. |
| `supabase/migrations/20260731000002_resumen_operativo.sql` | **Session 12.** Registers the `resumen_operativo` app (per_city, 4 files/week), its 20 `app_columns`, and the 8 new KPIs (`category = 'operacion'`). |
| `lib/validate-identity.ts` | **Session 13.** Upload identity safety net — hub-column city check + roster-overlap-vs-history check, per app via `IDENTITY_CONFIG`. See §22. |
| `lib/normalize.ts` | **Session 14.** `normalizeName()` — extracted out of `validate-identity.ts` so `lib/tenure.ts` joins on the same normalizer instead of a second copy. |
| `lib/tenure.ts` | **Session 14.** Single source of truth for the derived tenure ledger — `deriveTenureLedger()` / `refreshTenureLedger()` / `tenureStatus()` / `tenureLabel()` / `tenureCode()` / `buildTenureNameIndex()`. See §23. |
| `PLAN_MODO_ENTRENAMIENTO.md` | **Session 14 build doc — shipped 2026-08-20.** Original build instructions for Modo Entrenamiento. The feature is live; treat this as historical rationale, not a task list. See §23 for what shipped. |
| `supabase/migrations/20260819000001_person_tenure.sql` + `20260819000004_person_tenure_rls.sql` | **Session 14.** Creates `person_tenure` (the derived ledger) — the RLS policy was forgotten in the first migration and had to be added in a follow-up; see §23's footgun table. |
| `supabase/migrations/20260819000002_kpi_ramp_targets.sql` + `20260819000003_kpi_ramp_targets_rls.sql` | **Session 14.** Creates `kpi_ramp_targets` + seeds the 10-week armador/tasa_armado ramp — same forgotten-RLS footgun as person_tenure, same fix pattern. |
| `app/api/ramp-targets/route.ts` | **Session 14.** GET/PUT for `kpi_ramp_targets`. Plain upsert IS safe here (no nullable key) — do not copy the delete-then-insert pattern from `/api/kpi-targets`. |
| `app/api/person-tenure/route.ts` | **Session 14.** PUT (`set_first_seen` / `graduate`) + DELETE (revert to derived) for manual tenure overrides — the escape hatch for a bad derivation or a rehire under a new id. |
| `app/(app)/config/RampTargetsSection.tsx` | **Session 14.** "Entrenamiento / Rampa" `/config` section — 10-row mínimo/esperado editor, "En entrenamiento" supervision list, "Overrides manuales" list (only visible with an active override). |
| `scripts/tenure-dry-run.ts` / `scripts/tenure-backfill.ts` / `scripts/test-tenure.ts` | **Session 14.** Read-only ledger inspection, real backfill runner, and the plain-`node:assert` unit test suite (no test framework in this repo — see §23) for `tenureStatus`/`resolvePersonTarget`. |
| `supabase_discrepancia_setup.sql` | One-time SQL to register the discrepancia app + app_columns + KPI |

---

## 3. Database Tables (relevant)

### `kpi_snapshots`
One row per KPI × week × scope. Columns used:
- `kpi_id`, `week_start`, `scope_level` ('hub' | 'city' | 'global'), `scope_key` (hub_id or city name)
- `value`, `numerator`, `denominator`, `prev_week_value`, `rolling_mean_4w`

Note: `rolling_mean_4w` and `value` for pct KPIs are stored as **0–1 fractions**, not percentages.  
Note: `value` for currency KPIs is raw MXN (no fraction).

⚠️ `prev_week_value` and `rolling_mean_4w` are only populated for the most recent weeks in the DB. For older historical rows they may be null. The heatmap in PorKpiTab computes these from the chronological snapshot array client-side as a fallback.

### `peer_comparisons`
One row per entity × KPI × week × scope. Columns:
- `kpi_id`, `week_start`, `entity_type` ('operator' | 'driver'), `entity_key` (person name)
- `scope_type` ('within_hub' | 'within_city' | 'global'), `scope_key` (hub_id, city key, or null for global)
- `value`, `peer_mean`, `z_score`, `rank`, `rank_total`

⚠️ **CRITICAL: `peer_comparisons` has NO `hub_id` column.** PostgREST silently ignores unknown columns on UPSERT but returns `data: null` on SELECT if you request a non-existent column. All SELECTs must omit `hub_id`. Use `scope_key` to identify hub — for `within_hub` rows, `scope_key === hub_id`.

Note: pct KPI `value` in `peer_comparisons` is also stored as **0–1 fraction**.  
Note: currency KPI `value` is raw MXN (shortfall amount, not fraction).

### `upload_rows`
Raw uploaded data rows. `data` column is a JSON blob keyed by column name. Only columns defined in `app_columns` for the app are stored — columns not in `app_columns` are dropped by `coerceRows`.

### `apps`
Registry of upload apps. Key fields: `id`, `name_es`, `scope` ('total' | 'per_city' | 'per_hub'), `expected_files_per_week`.

### `app_columns`
Column schema for each app. **Must be populated for every app** — `coerceRows` only stores columns listed here. Missing `app_columns` = empty `{}` rows stored = KPI computation produces nothing.

### `kpis`
KPI registry. Key fields: `id`, `name_es`, `unit`, `direction`, `source_app_id`, `numerator_field`, `denominator_field`, `active`, `display_order`.

### `desempeño_repartidores`
Driver roster — used to zero-fill drivers with no incidents in `extractIncidentesValues`.

---

## 4. Data Flow in `/historicos`

```
page.tsx (server)
  ├── Counts all rows across 6 data sets (parallel HEAD requests)
  ├── Paginates ALL pages in parallel (PAGE = 1000 rows/request)
  │     ├── kpi_snapshots       (52 weeks, hub/city/global scope)
  │     ├── peer_comparisons    (current week only — KPI tile back faces)
  │     ├── upload_rows MNA     (current week, one query per upload)
  │     ├── upload_rows faltantes_armador (current week, one query per upload)
  │     ├── assemblerTrend      (multi-week, entity_type=operator, scope=within_hub)
  │     └── driverTrend         (multi-week, entity_type=driver,   scope=within_hub)
  └── Flat arrays → HistoricosClient → PorKpiTab / PorHubTab / ComparativaTab
```

Hub switching, tab switching, and KPI switching are all **client-side only** — all data is fetched once on page load and filtered/navigated in the browser. See §4a for the navigation architecture.

---

## 4a. Client-Side Navigation Architecture (session 7)

All in-page navigation in `/historicos` uses **client state + `history.pushState`**, never `router.push`. Using `router.push` inside historicos triggers a full Next.js server navigation → all Supabase queries re-run → 4-5 second freeze. This was the root cause of slow tab switching and slow KPI switching before session 7.

### State ownership
`HistoricosClient` owns two navigation state variables:

```ts
const [activeTab, setActiveTab] = useState<'kpi' | 'hub' | 'cmp'>(props.tab);
const [activeKpi, setActiveKpi] = useState<string>(props.selectedKpi ?? defaultKpi);
```

Both are initialised from server-provided props (which come from URL `searchParams` on first load or direct links). Subsequent changes are pure JS — no server contact.

### URL sync without server re-render
`syncUrl()` in `HistoricosClient` updates the browser URL so the back button and bookmarks still work:

```ts
function syncUrl(tab: 'kpi' | 'hub' | 'cmp', kpi: string) {
  const params = new URLSearchParams();
  if (tab !== 'kpi') params.set('tab', tab);
  if (tab === 'kpi' && kpi && kpi !== defaultKpi) params.set('kpi', kpi);
  window.history.pushState(null, '', url);
}
```

⚠️ **Never replace `history.pushState` with `router.push` here** — `router.push` triggers a Next.js navigation which re-runs `page.tsx` and all its Supabase queries.

### Callback pattern for KPI switching
`PorKpiTab` does not own the selected KPI. It receives `selectedKpi` (read-only) and `onKpiChange` (callback) from `HistoricosClient`. Clicking a top mover card or the KPI selector dropdown calls `onKpiChange(id)` → parent flips `activeKpi` → React re-renders with new KPI data, all from memory.

```ts
// PorKpiTab — no useRouter, no router.push
function pickKpi(id: string) {
  onKpiChange?.(id);
}
```

### loading.tsx — immediate page shell
Every route now has a `loading.tsx` file (`/historicos`, `/upload`, `/prioridades`, `/config`). Next.js shows these instantly on navigation while the server component fetches Supabase data in the background. Without `loading.tsx`, Next.js blocks the navigation until all fetches complete — the old "stuck on the previous page" behavior.

⚠️ `loading.tsx` improves **perceived** speed only. Actual Supabase fetch time is unchanged. If the initial historicos load is too slow, the next step is moving data fetching client-side with SWR (see §19).

---

**Adding a new KPI** that follows the standard driver/operator/hub CSV pattern requires:
1. `apps` row + `app_columns` rows in Supabase
2. `kpis` row in Supabase
3. Extraction function in `lib/kpi-compute.ts` + case in `computeEntityValues` switch
4. (Optional) Entry in `KPI_META` + chart line in the relevant WoW section in `PorHubTab.tsx`

The tile front/back face, Por KPI chart, and heatmap all appear automatically for any active KPI — no additional frontend code needed beyond the optional WoW chart.

---

## 5. Upload Pipeline

### Route: `POST /api/upload`

1. Auth check
2. Parse multipart form (`app_id`, `week_start`, `city?`, `hub_id?`, `force_identity?`, `file`)
3. Validate `week_start` is a Friday — uses **local noon** (`T12:00:00`) not UTC midnight (`T00:00:00Z`) to avoid timezone mismatch with `weekStartFriday`'s local-time methods
4. Look up `apps` + `app_columns` from DB
5. Parse CSV with PapaParse
6. Validate headers + types vs `app_columns` schema (hard fail, never override-able)
7. **Session 13 — identity safety net.** `computeIdentityChecks()` (`lib/validate-identity.ts`): does the file's hub column resolve to the declared city, and does its roster look like this slot's history or a different city's? `identity_*` errors are override-able via `force_identity=true`; see §22 for the full design.
8. **Delete all existing uploads** for this (app, week, city, hub) slot using `select()` + `in()` delete — handles PostgreSQL `NULL != NULL` in unique constraints that caused silent duplicate inserts with plain upsert
9. Insert fresh upload record + coerced rows

⚠️ **`coerceRows` only stores columns defined in `app_columns`.** If `app_columns` is empty for an app, every row is stored as `{}`. This is the silent failure mode when you add a new app but forget to add its columns.

⚠️ **NULL conflict bug (now fixed):** `upsert onConflict(app_id,week_start,city,hub_id)` silently inserts a duplicate when `city=null` AND `hub_id=null` (total-scope apps) because PostgreSQL treats NULL != NULL in unique indexes. Use the current delete-then-insert pattern for any future re-upload logic.

---

## 6. Mobile Layout

The app is fully responsive. Breakpoint: `lg` (1024px).

### Desktop (lg+)
- `app/(app)/layout.tsx`: `lg:grid lg:grid-cols-[232px_1fr]`
- Left column: `<Sidebar>` (sticky, `h-screen`)
- Right column: `<main>` with `px-9 pt-7` padding

### Mobile (< lg)
- `<MobileHeader>`: sticky black top bar (h-12) with "calii ops" wordmark + ☰ button
- Tap ☰ → dark overlay + `<Sidebar>` slides in from left as a 260px drawer
- `<Sidebar>` receives `onClose` prop → shows an X button at top-right
- `<main>` uses `px-4 pt-4` padding on mobile

### Key classes
```
layout.tsx:  min-h-screen lg:grid lg:grid-cols-[232px_1fr]
Sidebar:     w-full sticky top-0 h-screen (fills parent — grid col on desktop, drawer on mobile)
MobileHeader: lg:hidden (entire component invisible on desktop)
Desktop sidebar wrapper: hidden lg:block
```

---

## 7. PorKpiTab Architecture

### Tab bar
- Tab label: `📈 Por KPI` (no suffix)
- Tab bar has `overflow-x-auto` + `shrink-0 whitespace-nowrap` on each tab for mobile scrolling

### Top movers strip
- 5 cards, biggest absolute WoW change across all KPIs × hubs
- Clicking a card calls `onKpiChange(kpiId)` — instant client-side KPI switch, no server round-trip (session 7)

### Main chart
- Line per hub + **dashed grey global mean trend line** (`dataKey="__global__"`)
- Global mean sourced from `kpi_snapshots` `scope_level === 'global'` rows for pct/rate; **computed client-side** for count/currency
- For **pct/rate** KPIs: global = weighted sum of all entity numerators/denominators (stored in DB, correct)
- For **count/currency** KPIs: global = **mean of hub values, computed client-side in `allChartData`** — DB stored the raw sum historically; client-side overrides fix all historical weeks without a recompute
- `peerMeanThisWeek` (toolbar badge) uses the same client-side logic for count/currency
- Both stored as 0–1 fractions for pct; raw MXN for currency; `formatValue` handles display
- Timeline selector: 5 sem / 3 m / 6 m / 1 a / YTD
- **Session 11 — target line:** teal dashed `ReferenceLine` + "meta" label when a configured `kpi_targets` global row exists for the selected KPI (`resolveTarget(kpi.id, null, targets)`). Global line only — if per-hub overrides exist, a note appears instead of drawing one line per hub ("start with the global line to keep it readable" per the spec). See §14.

### Heatmap (revised)
- Each cell shows **two values**: absolute value (top) + WoW delta in display units (bottom)
- **Cell background color** = absolute value vs hub's own 4w rolling mean (σ-based):
  - Green = >0.75σ better than own baseline
  - Red = >0.75σ worse than own baseline
  - Fallback: ±5% relative when σ unavailable (< 2 prior weeks)
- **Delta text color** = direction of movement (green = improvement, red = worse, direction-aware)
- ⚠️ Delta and color are computed from the `hubChronological` array (sorted weekly snapshots), NOT from `snap.prev_week_value` / `snap.rolling_mean_4w` — those DB fields are only populated for recent weeks.

---

## 8. PorHubTab Architecture

### KPI Tiles (top section)
- Grid: `grid-cols-1 md:grid-cols-2 lg:grid-cols-3`
- **Front face:** value, WoW delta, 12-week sparkline, 4w rolling average reference line.
- **Back face (click to flip):** ranked list worst→best.
  - Assembler/driver KPIs: **full list, no cap** — all employees shown (scrollable via `overflow-y-auto`)
  - MNA KPIs: top products by `$` (amount) + `%` — max 10 items
  - Faltantes subcategory KPIs: top SKUs by event count — max 8 items
  - Currency KPIs (e.g. discrepancia): driver ranking by shortfall, worst first
- **Tile color:** σ-based threshold (0.75σ) vs hub's own 4w rolling mean. Fallback: ±5% relative.
- **Session 11 — target line + "vs meta" toggle:** teal dashed `ReferenceLine` on the sparkline (alongside the existing grey 4w-avg line) when `resolveTarget(kpi.id, hubId, targets)` finds a row; the "4w avg:" label is replaced by "meta: X" in that case. A "vs histórico / vs meta" toggle above the tile grid (`colorMode` state, defaults to `'hist'`) switches tile coloring to `meetsTarget()`-based green/red — but **only for tiles that actually have a resolved target**; everything else keeps the σ-vs-histórico color regardless of toggle position. See §14.

### MNA Tile Category Filter Map
```ts
const MNA_CATEGORY_FILTER: Record<string, MnaCategory | null> = {
  mna_pct:          null,        // all categories
  mna_graneles_pct: 'abarrotes', // shelf-stable / dry goods
  mna_fyv_pct:      'fyv',
  mna_carnes_pct:   'carnes',
};
```

### Faltantes SKU Category Filter Map
```ts
const FALTANTES_SKU_CATEGORY_FILTER: Record<string, MnaCategory> = {
  faltantes_fyv_pct:      'fyv',
  faltantes_carnes_pct:   'carnes',
  faltantes_graneles_pct: 'abarrotes',
};
// faltantes_armador_pct excluded — its flip shows assembler peer ranking.
```

### Hub ID Resolution — `lib/hub-aliases.ts`
**Single shared module** used by both `kpi-compute.ts` (`hubNameToId` wrapper) and `page.tsx` (direct import). Previously each file had its own copy of the map, which diverged (page.tsx had the `country/mh_country` typo alias; compute didn't → Contry MNA totals were missing).

`resolveHubId(raw)` normalises: NFD accent strip → lowercase → trim → hyphens + spaces → `_` → looks up `HUB_ALIAS_MAP`. `ch_*` prefixes return null (CH Guadalupe excluded).

Known aliases in `HUB_ALIAS_MAP`:
```
mh_contry / contry / mh_country / country → 'mh_contry'   ← country is a common CSV typo
mh_cumbres / cumbres                       → 'mh_cumbres'
mh_san_nicolas / san_nicolas               → 'mh_san_nicolas'
mh_guadalupe / guadalupe                   → 'mh_guadalupe'
mh_avicola / avicola / mh_saltillo / saltillo → 'mh_avicola'
mh_zapopan / zapopan / guadalajara / gdl  → 'mh_zapopan'   ← gdl added session 3
mh_condesa / condesa / cdmx / df / ciudad_de_mexico / mexico → 'mh_condesa'  ← extras added session 3
mh_san_pedro / san_pedro                  → 'mh_san_pedro'
```

⚠️ **Adding a new hub:** edit ONLY `lib/hub-aliases.ts`. Both compute and display update automatically.  
⚠️ `console.warn('[resolveHubId] unrecognised hub label: ...')` fires in dev for any unrecognised string — check these after first upload of a new hub.  
⚠️ Unknown labels (e.g. "San Rafael Puebla") are silently skipped during compute — expected for drivers from hubs not in the Calii system.

### KPI Tile Coloring + 4w avg
- `mean4w` prefers DB `rolling_mean_4w`; falls back to client-side average of prior trend values when null
- This fallback also drives the sparkline `<ReferenceLine>` and the `4w avg:` label — all three read from the same computed `mean4w` variable, not directly from `thisWeek?.rolling_mean_4w`
- σ threshold: 0.75σ; fallback: ±5% relative when <3 prior weeks

### WoW Charts
- Grid: `grid-cols-1 sm:grid-cols-2 gap-3`
- Wide hero chart: `sm:col-span-2`
- Shared x-axis per section (last 5 weeks)
- Y-axis default: `maxVal * 1.1` snapped to nice magnitude — always shows all data, no clipping
- Y-axis range slider: `writingMode: 'vertical-lr'` — do NOT add `direction: 'rtl'`
- `allowDataOverflow={true}` on YAxis — required for zoom-in to work
- Y-axis resets to smart default on hub switch — uses **derived-state pattern** (`if (filterHubId !== hubId)` during render), NOT `useEffect`. Using `useEffect` causes a two-render cycle where `visibleEntities` is briefly empty → `smartYMax = undefined` → `manualYMax = unitMaxCeil = 100` → stuck.
- pct values stored as 0–1 fractions → ×100 before charting
- currency values stored as raw MXN — passed through as-is; `$` formatting in `yFmt` and `WowTooltip.fmt`
- `UNIT_MAX_CEIL`: `{ pct: 100, rate: 250, count: 20, currency: 50_000 }` — slider full-range ceiling per unit

### WoW Person Filter Dropdowns
- `AssemblerWowSection` and `DriverWowSection` each have a `<MultiSelectDropdown>` below the section header
- `entityNames` = only people present in the **most recent week's report** — ex-employees from older weeks are excluded
- Filter state uses the **derived-state pattern** to reset synchronously on hub switch (same reason as y-axis above)
- Default: all current-week people selected; resets to all on hub switch
- `sectionColorMap`: computed once per section from `entityNames` (alphabetical index → `ASSEMBLER_PALETTE`), passed to every `WowChart` so the same person keeps the same color across all charts in the section

### WoW Tooltip (`WowTooltip`)
- Takes `allEntities: string[]` prop — the full `entityOrder` list
- **Always renders all selected entities** regardless of week. Recharts `payload` only includes entries with data for the hovered week; iterating `payload` alone produces a variable-size tooltip.
- Builds a `valueMap` from `payload`, then renders `allEntities` in order. Missing entries show `'—'` and sort to the bottom via `-Infinity`.

### Driver WoW Section
Currently shows 4 charts:
```
% entregas tardías | % entregas fallidas
Entregas erróneas  ← wide (col-span-2)
Discrepancia ($)   ← wide (col-span-2)
```
To add a new driver WoW chart: add entry to `KPI_META` + add `WowChart` line in `DriverWowSection`.

---

## 9. lib/kpi-compute.ts — Extraction Functions

### `computeEntityValues` switch
Dispatches to per-source extraction function based on `kpi.source_app_id`:

| `source_app_id` | Function | entity_type |
|---|---|---|
| `desempeno_operadores` | `extractOperatorValues` | operator |
| `desempeno_repartidores` | `extractDriverValues` | driver |
| `mna` | `extractMnaValues` | sku |
| `incidentes` | `extractIncidentesValues` | driver |
| `discrepancia` | `extractDiscrepanciaValues` | driver |
| Faltantes hub % KPIs | `extractFaltantesHubPctDirect` | hub |
| `resumen_operativo` (8 KPI ids, `RESUMEN_KPI_IDS`) | `extractResumenOperativoValues` | hub |

### `extractIncidentesValues`
Detects **entregas erróneas** (wrong/missing deliveries) per driver. Detection rules (session 10):

1. Rows by `robertott@calii.com` are always excluded — he logs attendance/tardiness only.
2. **Order code is required** as the primary signal. Pattern: `INCIDENTES_ORDER_CODE_RE = /#?[A-Z0-9]{1,2}-[A-Z]\d-\d/i` — e.g. `AF-A3-2`, `WS-C1-3`, `J5-B8-6`, `46-D6-4`, `#JN-D7-2`.
3. **Known responsables** (`INCIDENTES_KNOWN_RESPONSABLES`): any row with an order code is a confirmed entrega errónea. The four known emails are: `dayana.lozano@calii.com`, `violeta@calii.com`, `oscar.escobedo@calii.com`, `marely@calii.com`.
4. **Other responsables** (staff covering vacations, coordinators, etc.): require an order code **plus** delivery-error keywords (`INCIDENTES_DELIVERY_RE`: entrega errónea/equivocada/incorrecta, faltante, pedido incorrecto/equivocado, no es su pedido).

Zero-fill for driver roster: inserts `{ numerator: 0, denominator: 1 }` for any driver in `desempeño_repartidores` NOT found in incidents. Ensures zero-incident drivers appear in WoW chart.

⚠️ **`INCIDENTES_ORDER_CODE_RE` and `INCIDENTES_KNOWN_RESPONSABLES` are defined at module level** in `kpi-compute.ts` (above `extractIncidentesValues`). The matching constants `ORDER_CODE_RE`, `DELIVERY_RE`, and `KNOWN_INCIDENTE_RESPONSABLES` in `GenerarReporte.tsx` **must be kept in sync** — they drive the notes shown in the Slack report. If you add a new known responsable, update both files.

### `extractDiscrepanciaValues`
CSV columns: `Repartidor`, `Hub`, `Cálculo digital efectivo` (expected), `Conciliación manual` (deposited).  
`shortfall = expected − deposited` (positive = driver is short).  
Accepts both accented and unaccented column name variants.  
Drivers from unknown hubs (e.g. San Rafael Puebla, CH Guadalupe) are skipped — `hubNameToId` returns null.  
**Accumulates by `(drvName, hubId)` pair** — uses a `byDriverHub` map so a driver with multiple CSV rows (e.g. multiple cash entries) contributes one `EntityValue` with their total shortfall. Without this, the same driver appears N times → inflated hub totals + wrong z-scores on the tile flip. Fixed session 9 after MH Contry and MH San Nicolás showed miscalculated discrepancia totals.

### `extractResumenOperativoValues` (session 12)

Hub-level direct-read extractor for the 8 `resumen_operativo` KPIs (`pedidos_hub`, `pedidos_entregados`, `aov_mxn`, `ingresos_hub`, `pedidos_por_armador_dia`, `entregas_por_repartidor_dia`, `armadores_activos`, `repartidores_activos`) — one row per hub per week from the Retool export, same shape as `extractFaltantesHubPctDirect`.

- `RESUMEN_FIELDS: Record<kpiId, (row) => [numerator, denominator]>` — the weighted-average KPIs (`aov_mxn` and the two per-head rates) store `numerator = value × weight, denominator = weight`, **not** `numerator = value, denominator = 1`, so `aggregateAllScopes`' `Σnum/Σden` at city/global scope produces a correctly weighted average instead of silently summing per-hub averages. Weight is whatever sits on the bottom of the metric: AOV is pesos/order → weight by orders; the two rates are X/person/día → weight by headcount.
- `ingresos_hub` numerator is `AOV × pedidos_entregados` (delivered orders), not `AOV × Pedidos (#)` (placed) — changed post-launch (2026-07-31) because undelivered orders are never actually charged; the placed-orders version overstated revenue by the undelivered rate (~2.5% in the sample week).
- Skips zero-volume hubs (`Pedidos (#) <= 0`) — MH San Pedro is in `HUB_ALIAS_MAP` but not in the `hubs` table, and ships an all-zero/NaN row.
- Skips a KPI when its own weight denominator is 0 (e.g. `Armadores (#) = 0` → the per-armador rate is undefined, not zero).
- `computePeersForKpi` already handles `entity_type === 'hub'` (same as faltantes hub %) — no separate peer-values path needed.

### `aggregateAllScopes` — global scope for count + currency
For `unit === 'currency'` **and** `unit === 'count'` KPIs, global = **mean of hub totals** not sum-of-all-entities.  
Sum-of-all-entities for count (e.g. entregas_erroneas) is ~N× any single hub value and makes the reference line useless.  
For pct/rate, keeps the standard weighted-sum formula (Σnum / Σden).  
⚠️ Historical weeks recomputed before this change still have the old sum in the DB for count KPIs. `PorKpiTab.allChartData` overrides `__global__` client-side for count/currency so all weeks display correctly without a historical recompute.

### `upload_rows` fetch strategy
Rows are fetched **one upload at a time** using a simple `eq('upload_id', u.id)` with `limit(10_000)`.

Do NOT restore `ORDER BY id` + range pagination — that triggers a full table sort on a growing `upload_rows` table and causes Supabase statement timeouts on weeks with many uploads (25+).

PostgREST's server-side `max_rows` cap (default 1 000) affects `limit()` calls — even `limit(10_000)` is capped at 1 000 per request. One upload at a time means each upload's rows are fetched in a single capped call; if a single upload has >1 000 rows, only the first 1 000 are processed. This is acceptable for current upload sizes.

### Upsert strategy
Sequential 200-row batches, tables written one after the other. Running all batches in parallel (the original `Promise.all`) caused DB lock contention → statement timeouts on large weeks.

### Dedup guard before upsert
Both `allSnapshots` and `allPeers` are deduplicated on their conflict keys before upsert.  
Prevents "ON CONFLICT DO UPDATE command cannot affect row a second time" from duplicate upload records or same-named drivers in the global scope.

---

## 10. HubCityKey Resolution

`peer_comparisons.scope_key` for `within_city` rows = upload.city enum value ('Monterrey', 'Saltillo', 'Guadalajara', 'CDMX').  
`hubs.city` = same enum value. They match as strings when the upload was processed correctly.

Resolution waterfall in PorHubTab:
1. Exact string match — succeeds in the normal case when the city's desempeno_operadores was uploaded
2. Cross-reference: find scope_key whose entity_keys overlap most with hub's `within_hub` entities
3. Accent/case-normalized match
4. Single-hub-city fallback — only fires when the normalized key equals hub.city (guards against returning a different city's key)
5. Last resort: hub.city — may produce empty opsCity/drvsCity, but won't show wrong-city data

⚠️ **Step 4 bug (fixed in session 3):** The old condition `siblingsInCity.length === 1 && allCityKeys.length === 1` was missing the city match check. If only Saltillo's operators resolved (hub_id='mh_avicola'), allCityKeys=['Saltillo']. Zapopan (single GDL hub, siblingsInCity=1) and Condesa (single CDMX hub, siblingsInCity=1) would both return 'Saltillo' → tile flips showed avicola operators/drivers for all non-Monterrey single-hub hubs. Fix: added `&& normalize(allCityKeys[0]) === normCity`.

---

## 11. peer_comparisons Pagination — Stability Requirement

The `allPeers` query in `page.tsx` paginates `peer_comparisons` (current week) in 1000-row pages. **The ORDER BY must be fully deterministic** — otherwise PostgreSQL's OFFSET can shift rows between page requests (due to VACUUM, concurrent writes, or parallel query plans), silently dropping some hubs' operator rows and causing those hubs to fall back to wrong-city data on the tile flip.

Current sort (stable): `entity_type, kpi_id, scope_type, scope_key NULLS LAST, entity_key`

⚠️ Do NOT simplify back to `ORDER BY entity_type` alone — that was the root cause of all hubs showing avicola data in session 4. Confirmed via a dev diagnostic: the DB had correct data for all 7 hubs, but unstable pagination was dropping non-avicola operator rows from `allPeers`.

---

## 12. Known Footguns

| Issue | Detail |
|---|---|
| `peer_comparisons` has no `hub_id` | SELECT with `hub_id` returns `data: null` silently. Always omit. Use `scope_key`. |
| Recharts domain override | Without `allowDataOverflow={true}` on YAxis, Recharts silently extends the domain. Zoom-in appears to do nothing. |
| p75 index formula | `Math.floor((n-1) * 0.75)` not `Math.floor(n * 0.75)`. |
| `writingMode` on range input | `writingMode: 'vertical-lr'`. Do NOT add `direction: 'rtl'`. |
| Rules of Hooks in WowChart | Hooks must be called before any early `return null`. |
| pct fraction vs display | `peer_comparisons.value` for pct KPIs = 0–1 fraction. Multiply ×100 before charting. |
| `kpi_snapshots.value` pct | Also stored as 0–1 fraction. `formatValue(v, 'pct')` handles ×100 internally. |
| Heatmap delta/color fallback | `prev_week_value` and `rolling_mean_4w` only populated for recent weeks. Always compute from `hubChronological` array. |
| KPI tile color + 4w avg fallback | Same issue: `rolling_mean_4w` often null. `mean4w` in the tile render is computed client-side from prior `trend` values. All three consumers (tile color, sparkline ReferenceLine, `4w avg:` label) use this single variable. |
| WoW y-axis reset on hub switch | Do NOT use `useEffect` to reset filter or y-axis on hub switch — async timing causes a stale-filter render → empty `visibleEntities` → `smartYMax=undefined` → stuck at `unitMaxCeil`. Use the **derived-state pattern** (`if (filterHubId !== hubId) { setState... }` during render). |
| WoW tooltip variable size | Recharts `payload` omits entries with null values for the hovered week. Never iterate `payload` to build the tooltip list — always iterate `allEntities` and look up values from a `valueMap` built from `payload`. |
| `lg:hidden` elements in CSS grid | `display:none` children don't consume a grid column — MobileHeader's `lg:hidden` elements are invisible and don't push `<main>` on desktop. |
| Friday validation timezone | Upload route uses `T12:00:00` (local noon), NOT `T00:00:00Z` (UTC midnight). UTC midnight = Thursday evening in Mexico City → `weekStartFriday` sees Thursday → validation fails on a valid Friday. |
| Incidente fecha off-by-one-day | `new Date("2026-05-08")` (date-only ISO string, 10 chars) is parsed as UTC midnight. In Mexico City (UTC-6/-5) that resolves to May 7 evening → `toLocaleDateString` shows "may 7". Fix: `new Date(raw.length === 10 ? raw + 'T12:00:00' : raw)` in `fetchIncidentesErroneas` (`GenerarReporte.tsx`). Same root cause as Friday validation timezone bug. |
| NULL conflict in upsert | `upsert onConflict(app_id,week_start,city,hub_id)` silently inserts duplicates when city=null AND hub_id=null. Use the current delete-then-insert pattern (select all → delete all → insert) for any re-upload logic. |
| Empty `app_columns` = empty rows | `coerceRows` only stores columns defined in `app_columns`. Missing `app_columns` = all rows stored as `{}` = KPI computation produces nothing silently. Always add `app_columns` when registering a new app. |
| `coerceRows` drops extra columns | CSV columns not in `app_columns` are silently dropped. The validator flags them as warnings but still marks status='validated'. |
| count/currency global = mean not sum | For count and currency KPIs, `kpi_snapshots` global scope should be mean of hub totals. `aggregateAllScopes` now does this for both. `PorKpiTab` recomputes client-side to fix historical weeks. |
| Duplicate uploads → recompute crash | Multiple upload records for the same slot cause `extractDiscrepanciaValues` (and any driver extractor) to output duplicate entity_keys → duplicate rows in upsert batch → PostgreSQL error. Dedup guard in `computeSnapshotsForWeek` now catches this, but fix the root cause (upload dedup) first. |
| Discrepancia multi-row drivers | `extractDiscrepanciaValues` previously pushed one `EntityValue` per CSV row — no accumulation. A driver with N cash entries appeared N times → hub total was inflated, tile-flip ranking showed only the first entry's value. Fixed session 9: now uses a `byDriverHub` map keyed on `drvName\|hubId`, accumulating shortfalls like `extractIncidentesValues` does for counts. (In practice, current CSVs have one row per driver, so this fix is defensive — see stale upload note below.) |
| Discrepancia Contry / San Nicolás "miscalculations" | Diagnosed session 9 via debug logging: computation was correct, hub names resolved fine, no rows skipped. Root cause was **stale CSV** — `Conciliación manual` values update in Retool throughout the week. Fix: re-upload the latest discrepancia CSV from Retool and hit Recomputar. Same pattern as session 5 (Contry $40K → $8K after re-upload). |
| Incidente fecha off-by-one (second fix) | First attempt used `raw.length === 10` to detect date-only strings, but `coerceRows` stores `datetime` columns as full UTC ISO strings (`"2026-05-08T00:00:00.000Z"`, 24 chars) via `new Date(t).toISOString()`. Length check was dead code. Real fix: `/^(\d{4}-\d{2}-\d{2})/.exec(raw)?.[1]` extracts the date prefix from any ISO format, then appends `T12:00:00` for local-noon parse. |
| Recompute statement timeout | Supabase default statement timeout (~8 s) is hit when many uploads are processed. Fixes: (1) `ORDER BY id` removed from upload_rows fetch; (2) sequential 200-row upsert batches. `ALTER ROLE postgres SET statement_timeout = '30s'` helps but doesn't fully fix it alone — PostgREST connection pool needs to cycle for role changes to take effect. |
| Hub alias map divergence | Previously `kpi-compute.ts` and `page.tsx` had separate copies of the hub alias map. They diverged — compute was missing the `country`/`mh_country` typo alias that page.tsx had, causing Contry MNA totals to be missing. Now unified in `lib/hub-aliases.ts`. Never duplicate the map again. |
| MNA breakdown works, total blank | MNA breakdown reads `upload_rows` directly in page.tsx (always fresh). MNA tile total reads `kpi_snapshots` (written by recompute). They can be out of sync if recompute hasn't run or failed silently. |
| MNA/faltantes breakdown blank for some hubs | Range pagination over `IN(upload_ids)` without ORDER BY is non-deterministic — rows from one upload can overlap pages. Fixed in session 3: page.tsx now fetches upload_rows one upload at a time (eq upload_id + limit 10_000), same as kpi-compute.ts. |
| Wrong-city operators shown on tile flip | The hubCityKey step 4 fallback returned the sole city-key from allCityKeys without checking it matches hub.city. For single-hub cities (Zapopan, Condesa) this caused avicola operators to appear when only Saltillo had resolved data. Fixed in session 3: added `normalize(allCityKeys[0]) === normCity` guard. |
| All hubs showing avicola on tile flip (session 4) | Root cause: `allPeers` pagination used `ORDER BY entity_type` only — non-deterministic within the operator group → OFFSET shifted rows between pages → non-avicola hubs' operator rows dropped → fallback to wrong city. Fixed in session 4: 5-column stable ORDER BY. Confirmed via dev diagnostic (all 7 hubs had correct DB data; it was purely a fetch issue). |
| GDL drivers/operators with null hub_id | geofence column sometimes contains "GDL" (abbreviation) instead of "Guadalajara" or "Zapopan". Added `'gdl': 'mh_zapopan'` to hub-aliases in session 3. Similarly added `'df'`, `'ciudad_de_mexico'`, `'mexico'` → `'mh_condesa'`. |
| Discrepancia tile shows inflated value | The computation and code are correct. If the hub total looks too high, the most likely cause is a **stale CSV upload** — the `Conciliación manual` values in Retool get updated over time as ops manually reconciles cash. The CSV uploaded early in the week will have less reconciliation than a later export. Fix: re-upload the latest discrepancia CSV and hit Recompute. Confirmed session 5: Contry showed $40,131 (early upload) vs $8,087 (re-uploaded current CSV). |
| `rolling_mean_4w` null for most-recent week | If a week is first computed before prior weeks exist in the DB, `enrichWithHistory` finds no history and writes null for `prev_week_value` and `rolling_mean_4w`. Re-running "Recomputar snapshots" for that week (single-week button) after prior data is uploaded fixes the DB value. **Code-level fix (session 6):** `buildBundle()` in `GenerarReporte.tsx` now computes `rollingMean4w` client-side from the snapshots array when the DB value is null — same fallback pattern as PorHubTab tiles. The report always has rolling mean data regardless of DB state. |
| `retardos_count` ≠ late deliveries | `retardos_count` measures times a repartidor arrived **late to work** (`num_tardy`). It is NOT included in the report sent to coordinators (`DRIVER_KPI_DEFS` removed it). Still suppressed from dashboard tiles via `REPORT_ONLY_KPI_IDS`. |
| `tasa_armado` DB direction may be wrong | The DB `kpis.direction` for `tasa_armado` may be `lower_is_better` even though higher rate = better. `ASSEMBLER_KPI_DEFS` has `higherIsBetter: true` which overrides the DB value throughout: flagging, sort, and the `direction` field in the returned bundle (so `buildTextBundle` prints `UMBRAL: <90` not `>90`). Do not remove this override without verifying the DB direction is corrected. |
| `pedidos_armados` / `retardos_count` are report-only KPIs | These KPIs exist only for the report generator's context — they must NOT appear as dashboard tiles. `REPORT_ONLY_KPI_IDS` in PorHubTab filters them out. They are still fetched in the page query (via peers) so the report bundle can use them. Migration: `20260511000001_count_kpis.sql`. |
| System prompt section headers for assemblers | The two assembler list headers (`Armadores con % de incidente general elevado:` / `Armadores con % de incidentes particular elevado:`) must be literal output lines in the report — not just instructional context to Claude. The system prompt explicitly says "escribir esta línea exacta". If Claude ever collapses the two lists into one, this wording in the prompt is the fix. |
| `kpis_weight_check` constraint | The `kpis` table has a check constraint requiring `weight BETWEEN 1 AND 5`. Do not use weight=0 in migrations. |
| `router.push` inside historicos = full server re-fetch | Any `router.push` call inside `/historicos` triggers a Next.js navigation → `page.tsx` re-runs → all 6 Supabase query batches fire again → 4-5 second freeze. Always use `history.pushState` for URL sync and `useState` for view changes. See §4a. |
| Comparativa city filter removed (session 7) | `ComparativaTab` previously had city filter buttons that called `router.push` → slow. Filter removed entirely in session 7. Tab now always shows all hubs. Do not re-add router-based filters to this component. |
| Incidentes order-code regex missing letter-starting codes (fixed session 10) | Old pattern `/\d[\w]*[-–]\w+[-–]\w+/` required the first character to be a digit — silently dropped every order code starting with a letter (WS-, JN-, GM-, SL-, GP-, JH-, U-). In a 3-week real sample this missed 8 of 17 incidents (47%). Fixed with `/#?[A-Z0-9]{1,2}-[A-Z]\d-\d/i`. Same regex must be in sync between `kpi-compute.ts` and `GenerarReporte.tsx`. |
| Incidentes detection: delivery keywords alone not enough | Old logic counted a row if it had EITHER an order code OR the word "entrega/entregado". Delivery words without a code are too noisy (e.g. normal service notes). New logic: order code is always required. For unknown responsables, delivery keywords serve as secondary confirmation only. |
| Old unused `kpi_targets` table (session 11) | The original registry schema migration (`20260427000001`) already created a `kpi_targets` table — but with a different shape (`scope`/`scope_value`/`target`, no `comparator`/`unit`/`active`, and the exact NULL-in-UNIQUE bug this class of footgun is named after). It was never wired up anywhere (zero code references, unseeded). Migration `20260717000001` drops and recreates it with the real design. If you ever see a stray reference to columns like `scope_value` or `warn_threshold`, that's the dead old shape — don't resurrect it. |
| Report said "vs promedio 4 semanas" but showed the WoW delta | The KPI line in `buildTextBundle` used to print a signed WoW delta (`+1.2pp`) immediately before a signed rolling-mean diff (`+Xpp`). Haiku regularly copied the WoW number into the "promedio de las últimas 4 semanas" sentence. Fixed: WoW is now **direction only** (`SUBIÓ`/`BAJÓ`/`SE MANTUVO`, no figure — the prompt only ever needed it for the MNA/faltantes "subió/bajó" sentence), and the comparison ships as a finished `FRASE_PROMEDIO: "…"` the prompt copies verbatim. Never re-introduce a second signed delta on that line. |
| "promedio de las últimas 4 semanas" over fewer than 4 weeks | `enrichWithHistory` averages *up to* 4 prior weeks — with one week of history the "4-week mean" **is** last week's value. `KpiSummaryEntry.rollingWeeks` now carries the real window size and `FRASE_PROMEDIO` states it ("últimas 2 semanas", or "del valor de la semana anterior" at n=1). `GenerarReporte.tsx` computes the mean client-side over the same 5-week window the DB uses so mean and count can't disagree. |
| Haiku inventing "— incidentes manuales" as an incident type | A LISTA 1 entry over the total threshold with no flagged sub-metric has no `— tipo`. Haiku filled the gap from the nearest noun in context: the DB `name_es`, "Incidentes manuales (%)". Fixed at the source — `lib/kpi-labels.ts` relabels it to "Incidentes armado" before it reaches the bundle, the prompt bans the word outright, and the LISTA 1 rule says to leave a tipo-less item alone. Don't feed raw `name_es` into the report prompt. |
| Tenure badge missing outside Tasas | `buildBundle` computed `tenureBadge` only when `isTasaArmado`, so an armador named in the incidentes or FA lists lost their `(S3)`/`(RI)`. The badge is a property of the person and the week, not the KPI — it is now set on every assembler group, and `route.ts` carries a `badgeByName` map into LISTA 1/LISTA 2. Only the personal ramp *target* stays tasa_armado-only (PLAN_MODO_ENTRENAMIENTO.md §5.3). AI insights (`lib/generate-insights.ts`) enrich outliers with a `tenure` field for the same reason. |
| Dashboard tiles read raw `kpi.direction` | `PorHubTab` tiles (color + delta class + "↓ menor mejor"), `PorKpiTab` (heatmap, top movers) and `ComparativaTab` (ranking) all compared against the DB direction, bypassing `effectiveDirection()` — a wrong DB direction for `tasa_armado` would paint a faster week red. All three now go through `lib/kpi-direction.ts`, as does the report's `kpiSummary.direction`. |
| `kpi_targets` NULL-in-UNIQUE (session 11) | Same class as the upload dedup bug above: a plain `unique(kpi_id, scope_level, scope_key)` does NOT stop duplicate global rows because `scope_key` is NULL for all of them. Fixed with two partial unique indexes (`kpi_targets_global_uniq`, `kpi_targets_hub_uniq`). `/api/kpi-targets` PUT does delete-then-insert matching the exact partial index — never a plain `upsert(onConflict: 'kpi_id,scope_level,scope_key')` here. |
| `meetsTarget` boundary is strict, not inclusive (session 11) | Landing exactly on a target does NOT count as meeting it — you have to clear it, not tie it (explicit product decision). `TARGET_EPS = 1e-9` in `historicos/_shared.ts` guards against float noise (e.g. a value that's conceptually 90 but stored as 89.99999999999997) rather than making the boundary inclusive. This is a deliberate deviation from how the original hardcoded assembler thresholds worked in early drafts of `GenerarReporte.tsx` (`<=`/`>=`) — don't "fix" it back to inclusive without checking with Jose first. |
| Optional targets = row absence, not `target_value: null` (session 11) | KPIs that flag on "outlier > 2× hub mean" today (`faltantes_armador_pct`, `pct_tardias_reparto`, `pct_undelivered`) stay on that behavior when no `kpi_targets` row exists. A blank `/config` input calls `DELETE`, not `PUT` with a null value — `target_value` is `NOT NULL` in the schema on purpose. Setting *any* number for these three KPIs switches them from 2×-mean to the fixed target immediately. |
| `npm run build` vs `npm run dev` share `.next` (session 11) | Running a production build while the dev server is running corrupts the dev server's webpack output — `Cannot find module './NNN.js'` errors, then a wave of 404s for `_next/static/chunks/*`. Fix: kill the dev server, `rm -rf .next`, restart `npm run dev`. Don't run `npm run build` as a "quick sanity check" while `npm run dev` is live in another terminal — use `npx tsc --noEmit` for that instead, and save `npm run build` for right before a deploy. |
| New Supabase table + forgot RLS = silently empty in the browser (session 14) | Both `person_tenure` and `kpi_ramp_targets` migrations created the table but no RLS policy. A service-role script (backfill/dry-run scripts) sees the data fine — RLS doesn't apply to the service role — but `/historicos` and `/config` use the session-authenticated client (`createServerClient()`), which got zero rows back with no error. Symptom: badges/ramp inputs render empty or fall back to placeholders even though the table is fully populated. Fix pattern: `alter table X enable row level security; create policy "auth_read_X" on X for select to authenticated using (true);` — same pattern as every other registry table (`20260427000005_rls.sql`). **Any new table this app reads from a client component needs this in its own migration, not just the `create table`.** |
| `resolveTarget` "is not a function" when called from a Server Component (session 14) | `historicos/_shared.ts` has `'use client'` at the top. Its exports work fine when imported by another client component (e.g. `KpiTargetsSection.tsx`) but become opaque client-reference objects when imported into a Server Component (e.g. `config/page.tsx`) and called directly — Next.js throws `(0, _historicos_shared__WEBPACK_IMPORTED_MODULE_4__.resolveTarget) is not a function`. Fix: never call a `'use client'` module's functions from a server page; pass the raw data down as props and let a client component (which already has to exist for interactivity) do the resolution. `lib/tenure.ts` deliberately has no `'use client'` directive so its functions (`hydrateTenureRow`, `tenureStatus`, etc.) stay callable from both server and client. |
| `person_tenure.reentry_weeks` doesn't exist — must be recomputed on every read | The re-entry-with-guard weeks (§23) depend on `weeksWithData` (validated upload weeks for the role's app), which isn't a per-person fact — it's not stored on the `person_tenure` row at all. Every reader of `person_tenure` (not just `deriveTenureLedger`) must call `hydrateTenureRow(dbRow, weeksWithData)` before calling `tenureStatus()`, or reentry (`RI`) will silently never fire. `app/(app)/historicos/page.tsx` and `app/(app)/config/page.tsx` both fetch `uploads` for `desempeno_operadores`/`desempeno_repartidores` (status=validated) alongside `person_tenure` specifically for this. |
| No test framework in this repo | `scripts/test-tenure.ts` uses plain `node:assert/strict` run via `npx tsx`, not jest/vitest — there was no existing test culture to match, and pulling in a framework for one file would be its own decision. `npm run test:tenure` runs it. If a real framework gets adopted later, port this file rather than leaving two parallel test conventions. |

---

## 13. Weekly Report Generator

### Overview
The "Generar reporte" teal button in the PorHubTab header generates a plain-text Slack message for the hub coordinator. Clicking it:
1. Builds a `ReportBundle` from the props already loaded in PorHubTab (no extra server fetches except incidentes erróneas)
2. Fetches incidentes erróneas notes directly from Supabase (browser client, filtered to this hub's drivers)
3. POSTs to `/api/generar-reporte` → Claude Haiku → returns text
4. Shows the text in a modal with a copy-to-Slack button

### Types (exported from `app/api/generar-reporte/route.ts`)
```ts
KpiSummaryEntry  { id, name, value, prevValue, rollingMean4w, unit, direction }
PeerEntity       { name, value, flagged, numOrders? }
KpiPeerGroup     { kpiId, kpiName, unit, direction, hubMean, threshold?, entities }
IncidenteErroneo { driver, fecha, notas }
ReportBundle     { hub, week, kpiSummary, armadoresPorKpi, repartidoresPorKpi,
                   incidentesErroneas, mnaProductos, faltantesSkus }
```

### KPI definitions in `GenerarReporte.tsx`
⚠️ **Session 11 — thresholds are now config-driven.** `defaultThreshold` on each def below is the CODE DEFAULT, used only when `/config` has no `kpi_targets` row for that KPI+hub (see §14). `resolveEffectiveTarget()` resolves the configured row (hub override > global) or falls back to `defaultThreshold`, returns a `KpiTarget`-shaped object, and `meetsTarget()` (from `historicos/_shared.ts`) does the actual flagging comparison — do not hand-roll a new `<=`/`>=` comparison here, that's exactly the "second source of truth" the target resolver exists to avoid.

**Assembler KPIs** (`ASSEMBLER_KPI_DEFS`):
- `incidentes_manuales_pct` — general incidentes, default **≥ 6%** → LISTA 1
- `incidentes_calidad_pct` / `incidentes_faltantes_pct` / `_parciales` / `_completos` — sub-metrics, default **≥ 4%** → LISTA 2
- `tasa_armado` — direction comes from `lib/kpi-direction.ts`'s `effectiveDirection()` (DB direction may say `lower_is_better`, this is the single source of truth for the override — see §12). Default **≤ 90 SKUs/hr** = bad. The corrected direction is passed in the bundle so `buildTextBundle` generates `UMBRAL: <90` (or whatever the configured target is) not `>90`. `buildTextBundle` also **pre-filters** tasa_armado entities to flagged-only before sending to Claude — avoids Claude accidentally listing fast assemblers.
- `faltantes_armador_pct` — outlier ≥ 2× hub mean unless a target is configured in `/config` (no code default)

**Driver KPIs** (`DRIVER_KPI_DEFS`):
- `pct_tardias_reparto` — outlier >2× hub mean unless a target is configured → "Reparto tardío" in report
- `pct_undelivered` — outlier >2× hub mean unless a target is configured → "Entregas fallidas" in report

(Removed from driver report: `retardos_count`, `discrepancia_mxn` — not shared with coordinators.)

### Report-only KPIs (NOT shown as dashboard tiles)
These KPIs exist solely to provide context to the report generator:
```ts
const REPORT_ONLY_KPI_IDS = new Set(['pedidos_armados', 'retardos_count']);
// Filtered out of the tiles array in PorHubTab
```
- `pedidos_armados` (migration `20260511000001`) — `num_assembled` per assembler, used as `numOrders` context to show "X pedidos" next to flagged assemblers
- `retardos_count` — still in `REPORT_ONLY_KPI_IDS` for tile suppression but no longer included in `DRIVER_KPI_DEFS` and not sent to Claude

### `buildBundle()` in `GenerarReporte.tsx`
- Filters `peers` for `within_hub` + `scope_key === hub.id` per KPI
- `assemblerOrderCount` map built from `pedidos_armados` peer entries, attached to each assembler entity as `numOrders`
- **`rollingMean4w`**: prefers `snap.rolling_mean_4w` from DB; falls back to client-side average of prior snapshots for the same KPI/hub when the DB value is null. This mirrors the PorHubTab tile fallback.
- **`effectiveHigherIsBetter`** for assembler KPIs: session 11 — now computed via `lib/kpi-direction.ts`'s `effectiveDirection(kpi.id, kpi.direction)` instead of a per-def `higherIsBetter` field (that field was removed from `ASSEMBLER_KPI_DEFS`). Used for both the flagging check (via `resolveEffectiveTarget`/`meetsTarget`) and the sort order. The returned group's `direction` field is set from this effective value (not raw `kpi.direction`) so `buildTextBundle` generates the correct UMBRAL label.
- **Configured targets** (session 11): `resolveEffectiveTarget()` wraps `resolveTarget()` (hub override > global) and falls back to the def's `defaultThreshold` when no row exists — see §14 and the footgun table in §12.

### `buildTextBundle()` in `app/api/generar-reporte/route.ts`
Pre-resolves the two assembler lists so Claude just copies them:
- **LISTA 1** — `incidentes_manuales_pct ≥ 6%`: `- Nombre: X.X% — calidades, faltantes`
- **LISTA 2** — any sub-metric ≥ 4% (independent of LISTA 1 — same person can appear in both): `- Nombre: sub-métrica X.X%`
- **tasa_armado**: entities pre-filtered to flagged-only (slow assemblers) before the text block is written. Claude receives only the slow ones; no ⚠️ parsing needed.

Each KPI line includes:
- WoW delta: `WoW: +Xpp PEOR/MEJORA`
- Rolling mean (when available): `promedio_4sem: X.X%  diff_vs_promedio: +Xpp POR ENCIMA (PEOR que promedio)`

### System prompt rules (SYSTEM_PROMPT in route.ts)
Key constraints — do not loosen these without testing:
- **REGLA DE COMPARACIÓN**: if `diff_vs_promedio` is absent from a KPI line, omit the comparison entirely. Never write "sin datos de comparación" or similar.
- **Section headers**: four main headers only — `Armado`, `Reparto`, `MNA`, `Faltantes armador`. Tasas, FA, Reparto tardío, Entregas fallidas, Entregas erróneas are subsections within their parent — no separate headers.
- **Assembler sub-list headers**: must literally output `Armadores con % de incidente general elevado:` and `Armadores con % de incidentes particular elevado:` before their respective item lists.
- **FA in Armado section**: only the per-assembler bullet breakdown. The FA total % and 4-week comparison appear ONLY in the "Faltantes armador" section at the end.
- **Entregas erróneas**: notes copied verbatim from the bundle — no AI summarization, no paraphrasing. No closing summary paragraph.
- **MNA/FA WoW sentence**: describes category-level movement (subió/bajó/se mantuvo) using mna_fyv_pct, mna_carnes_pct, mna_graneles_pct WoW labels. No product names, no SKU names, no numeric values in this sentence.

### `lib/sku-classifier.ts` — FyV keyword tier (added session 6)
The classifier previously had no Tier 2 FyV fallback — unknown-supplier produce items were misclassified as Abarrotes. Fixed by adding `FYV_NAME_SIGNALS` (~40 unambiguous produce keywords: guayaba, jitomate, aguacate, brócoli, etc.) and updating Tier 2 logic:
```ts
const freshProduce = FYV_NAME_SIGNALS.some((k) => n.includes(norm(k)));
const dryProcessed = shelfStable || /polvo|deshidratad|molido/.test(n);
if (freshProduce && !dryProcessed && !coldChain) return 'fyv';
if (coldChain && !shelfStable) return 'carnes';
return 'abarrotes'; // default
```
Intentionally excluded from FYV_NAME_SIGNALS: cebolla, ajo, papa, maíz, coco — too common in processed/dry forms (salsa, en polvo, aceite).

---

## 14. Configurable KPI Targets (session 11)

Full design doc: `CONFIGURABLE_KPI_TARGETS.md` (project root) — read it before making non-trivial changes here, this section is a summary of what shipped, not the rationale.

### Overview
Targets (umbrales) that used to be hardcoded constants in `GenerarReporte.tsx` are now editable from `/config` -> "Metas / Targets", globally or per-hub, without a code change or redeploy. They drive both the AI report's flagging/`UMBRAL:` line and the dashboard's target reference line + optional "vs meta" tile coloring.

### Data model — `kpi_targets` table
Migration: `supabase/migrations/20260717000001_kpi_targets.sql`.

```
id, kpi_id, scope_level ('global'|'hub'), scope_key (hub_id or null),
target_value (numeric, NOT NULL), comparator ('gte'|'lte'|'gt'|'lt'),
unit (snapshot of kpis.unit), active, updated_by, updated_at
```

- **`target_value` is stored in DISPLAY units** (90 for tasa_armado, 6 for a 6% threshold) — NOT the 0-1 fraction `kpi_snapshots`/`peer_comparisons` use for pct. This was the #1 thing the spec called out to get right; conversion happens in exactly one place (`toDisplayUnits` inside `historicos/_shared.ts`, not exported — go through `meetsTarget`/`isBelowTarget`).
- **Optionality = row absence**, not `target_value: null` — the column is `NOT NULL` on purpose. A blank `/config` input issues a `DELETE`, never a `PUT` with a null value.
- Precedence: **hub-specific row > global row > code default** (the def-level constants still in `GenerarReporte.tsx`, renamed `defaultThreshold`). Never hard-fails on a missing target.
- Replaced an old, unused, differently-shaped `kpi_targets` table from the original registry schema — see §12 footgun table.

### Resolver — `app/(app)/historicos/_shared.ts`
```ts
resolveTarget(kpiId, hubId, targets): KpiTarget | undefined   // hub > global > undefined
meetsTarget(dbValue, target): boolean                          // direction-aware "is this good"
isBelowTarget(dbValue, target): boolean                        // direction-agnostic, for chart geometry
```
`meetsTarget`'s boundary is **strict, not inclusive** — exactly hitting the target does not count as meeting it (see §12 footgun). This is the single place every consumer (report, config UI defaults, dashboard tiles/chart) goes through — do not reimplement the gte/lte switch anywhere else.

### `/config` UI — `KpiTargetsSection.tsx` + `/api/kpi-targets`
- One row per KPI: global number input + an expandable per-hub override grid (hubs read from the `hubs` table already fetched in `config/page.tsx`, never hardcoded).
- Comparator is **not user-editable** — always derived from the KPI's effective direction via `lib/kpi-direction.ts` (§12). Sent along with every write so the report's UMBRAL label stays unambiguous.
- Auto-save on blur, no explicit "Guardar" button. Each input manages its own saving/saved/error state.
- `/api/kpi-targets`: `GET` (list active), `PUT` (delete-then-insert against the exact partial unique index — see §12 NULL-in-UNIQUE footgun), `DELETE` (clears a row). Auth-checked like `/api/upload`.

### Report wiring — `GenerarReporte.tsx` + `app/api/generar-reporte/route.ts`
`resolveEffectiveTarget()` (in `GenerarReporte.tsx`) wraps `resolveTarget()` + the def's `defaultThreshold` fallback into a single `KpiTarget`-shaped object so `meetsTarget()` can be reused unchanged for flagging. `threshold` on the returned `KpiPeerGroup` stays in DB-native units (same as before) so `route.ts`'s existing `fmtVal()`-based `UMBRAL:` rendering keeps working without changes — it now just reflects the resolved target instead of a constant. The driver section's header (previously always "OUTLIER: >2x promedio") now prints `UMBRAL:` when a target is configured, same precedence as the assembler section.

### Dashboard wiring — `PorHubTab.tsx` (§8) + `PorKpiTab.tsx` (§7)
See the "Session 11" bullets already added to §7 and §8 above.

### Verification status
Live-tested in session 11: seed values match old hardcoded behavior exactly (tasa_armado 90, incidentes 6%/4%); global edit + per-hub override + clear-override all round-trip correctly through the DB; report UMBRAL line and flagging correctly reflect a changed target (tested 90->95 global, then a 120 per-hub override on MH Avicola — flagged count went from 2 to 8 assemblers); dashboard tile target line, "meta:" label, and "vs meta" toggle all confirmed live; PorKpiTab main chart target line confirmed for both a configured and an unconfigured KPI.

**Not yet done** (from the original spec's Step 7 checklist): explicitly testing a 2x-hub-mean KPI (`pct_tardias_reparto`/`pct_undelivered`) — confirm blank stays on the 2x rule and a set value overrides it — and a final grep pass for any other stray consumer of the pre-session-11 hardcoded constants.

---

## 15. Local Development

```bash
cd ~/Desktop/calii-ops-app
npm run dev
# → http://localhost:3000
```

`npm run dev` runs a **long-lived server process** — it occupies the terminal and runs until you kill it. That is normal. To stop it: `Ctrl+C` in the terminal. Safe to close the terminal window if you click "Terminate" (or equivalent) on the dialog — it kills the process cleanly.

`.env.local` requires:
```
NEXT_PUBLIC_SUPABASE_URL=https://nxwpsvvfgygafjnhwccc.supabase.co   # no /rest/v1/ suffix
NEXT_PUBLIC_SUPABASE_ANON_KEY=<from Supabase dashboard → Settings → API>
SUPABASE_SERVICE_ROLE_KEY=<already set>
NEXT_PUBLIC_SITE_URL=http://localhost:3000
APP_OWNER_EMAIL=jose.romero@calii.com
```

**Workflow:**
- File save → localhost refreshes instantly (no commit needed)
- `git commit` → saves checkpoint, no Netlify deploy
- `git push` → triggers Netlify deploy (only when ready to go live)

**Production URL:** use the main Netlify URL — NOT deploy preview URLs (e.g. `a0fc--calii-kpi-ops.netlify.app` is an old snapshot).

**Bash mount (Cowork sessions):** `/sessions/<session-name>/mnt/calii-ops-app/`  
The session name changes each conversation — check the system prompt for the current mount path.

---

## 16. Commits

```
(session 14) feat: Modo Entrenamiento — person_tenure + kpi_ramp_targets tables (+ RLS follow-up fixes), lib/tenure.ts derivation/status/target-resolution, (Sx)/(RI) badges across PorHubTab, report training-block wiring, /config ramp editor + supervision list + manual overrides — see §23
(session 13) feat: upload identity safety net — hub-column city check + roster-overlap-vs-history check (lib/validate-identity.ts), override via force_identity=true logged to audit_log, UploadDropzone override/cancel UI — see §22
(session 12) feat: Resumen operativo tab — filter-only commit, migrations (currency_avg unit, resumen_operativo app/columns/8 kpis), extractResumenOperativoValues, ResumenTab tree + Total-row override, tab wiring; follow-up: ingresos_hub switched to delivered orders, 3 WoW trend charts (Total/por ciudad/por hub) — see §21
(session 11) feat: configurable KPI targets — kpi_targets table + migration/seed, resolveTarget/meetsTarget resolver, /config Metas UI + /api/kpi-targets, report + dashboard wiring, epsilon-strict target boundary
(session 10) fix: entregas erróneas detection — order code regex now catches letter-starting codes (WS-, JN-, GM- etc); order code required as primary signal; known responsables list added
(session 9) fix: incidente fecha regex date extract (coerceRows stores datetime as full UTC ISO, length-10 check was dead code); discrepancia byDriverHub accumulation (defensive); Contry/San Nicolás diagnosed as stale CSV — re-upload fix, not code
(session 8) fix: report generator — inclusive thresholds, tasa_armado direction override, LISTA 2 independent, driver KPIs trimmed, section headers, FA split, verbatim entregas erróneas
(session 7) ux: instant tab + KPI switching via client state; remove Comparativa city filter; loading skeletons for all pages
(session 6) feat: weekly report generator — /api/generar-reporte, GenerarReporte component, two-list assembler breakdown, FyV SKU classifier fix, rolling mean client-side fallback
(session 5) ops: diagnosed discrepancia inflation — stale CSV upload, not a code bug; re-upload + recompute resolved Contry $40k→$8k
(session 4) fix: stable 5-col ORDER BY for peer_comparisons pagination; remove dev diagnostic
(session 3) fix: MNA per-upload fetch; hubCityKey step-4 guard; hub-aliases GDL/CDMX variants
ffdea85     compute: hub-aliases shared module, upload_rows fetch fix, sequential upserts
4d2f4da     refactor: single hub alias map in lib/hub-aliases.ts; fix country/contry typo in compute
a7f2929     compute: fetch upload_rows one upload at a time (fix silent row truncation)
7739782     compute: fix upload_rows fetch (remove ORDER BY timeout), sequential 200-row upserts
f40bcf0     PorHub: person filter dropdowns, stable colors, tooltip fix, tile coloring; PorKPI + compute: global mean for count KPIs
91c9a52     feat: Discrepancia KPI; fix upload dedup + currency global mean
6561a02     PorKPI: trend line, heatmap WoW+baseline color, tab rename; PorHub: full lists, MNA resolveHubId; mobile responsive
71160f4     mobile: responsive layout, hamburger drawer, tab bar, WoW chart grids
```

---

## 17. What's Working ✓

- **Modo Entrenamiento (session 14)**: `person_tenure` derives everyone's tenure from upload history (no hire-date field anywhere) — `(S1)`–`(S10)` badges for new armadores, `(S1)`–`(S4)` for new repartidores, `(RI)` reingreso for returners after a ≥10-week gap. Badges render everywhere a name appears in `/historicos` (tile back faces, WoW dropdowns/tooltips, historical weeks show the correct lower S-number) and in the weekly Slack report, where trainees below their personal ramp mínimo get their own supervision block instead of being mixed into the veteran slow-assembler list. `/config` → "Entrenamiento / Rampa" has the 10-week mínimo/esperado editor, a live supervision list, and manual overrides for bad derivations/rehires-under-a-new-id. See §23.
- **Upload identity safety net (session 13)**: `/api/upload` now catches "right file, wrong slot" uploads — hub-column city mismatches (deterministic) and roster-overlap mismatches vs. history (fuzzy) — for `desempeno_operadores`, `desempeno_repartidores`, `resumen_operativo`, `incidentes`, `discrepancia`. Hard-blocks by default with an override path (`force_identity=true`, logged to `audit_log`). Verified against real production data with zero false positives on a correctly-labeled file. See §22.
- **Resumen operativo tab (session 12)**: `/historicos` → "📦 Resumen" — Total/city/hub tree over 8 hub-level KPIs (orders, delivered orders, AOV, revenue, headcount, headcount rates) fed by a new per-city weekly Retool export, plus 3 WoW trend charts with Total/por ciudad/por hub scope toggles. Live in production with real data for week 2026-07-24, verified against hand-computed numbers. See §21.
- **Configurable KPI targets (session 11)**: `/config` → "Metas / Targets" — global + per-hub umbrales, no redeploy needed. Drives the report's flagging/UMBRAL line and a target reference line + "vs meta" tile coloring toggle on the dashboard. See §14.
- **Weekly report generator**: "Generar reporte" button in PorHubTab → Claude Haiku Slack message with assembler breakdown, driver flags, incidentes erróneas, MNA/FA sections
- **Entregas erróneas detection fixed (session 10)**: order code regex now catches all formats (letter-starting and digit-starting); known responsables list enforced; order code required as primary signal
- **Instant tab switching**: Por KPI / Por Hub / Comparativa tabs switch via `useState` — no Supabase re-fetch (session 7)
- **Instant KPI switching**: Top movers + KPI dropdown use `onKpiChange` callback — no Supabase re-fetch (session 7)
- **Loading skeletons**: All pages show immediate skeleton on navigation; no more "frozen on previous page" (session 7)
- All 7 assembler WoW charts + all 4 driver WoW charts (incl. Discrepancia)
- Mobile layout: hamburger drawer, responsive grids, scrollable tab bar
- Por KPI: global mean trend line on chart, revised heatmap (value + WoW delta + own-baseline color)
- Por Hub KPI tiles: σ-based color vs own history, full assembler/driver lists on flip (no cap)
- MNA tile flip: single $ list with % alongside, sorted highest $ first
- Faltantes SKU tile flip: top SKUs by event count per subcategory
- Discrepancia KPI: hub total on tile front, driver ranking on tile flip, WoW chart per driver
- Hub switching: fully client-side, no server round-trip
- Y-axis slider: smart cap default, resets on hub switch
- Upload re-upload: properly replaces all previous records (no duplicates)
- Currency KPI global mean: mean of hub totals, comparable to individual hub lines
- Operator/driver tile flip breakdown: correct per-hub data for all 7 hubs

---

## 18. Discrepancia KPI — Reference

**Source app:** `discrepancia` (scope: total, 1 file/week)

**CSV columns:**

| Column | Type | Role | Notes |
|---|---|---|---|
| `Operator ID` | string | id | Retool driver ID |
| `Repartidor` | string | dimension | Driver full name — used as `entity_key` |
| `Hub` | string | dimension | Hub name, resolved via `hubNameToId` |
| `Apodo` | string | free_text | Short name |
| `ID efectivo` | string | id | Cash ID in Retool |
| `Cálculo digital efectivo` | float | metric | **Expected** amount (order totals) |
| `Conciliación manual` | float | metric | **Deposited** amount |
| `Conciliación Panamericano` … | float | ignored | Stored but not used by kpi-compute |

**Computation:** `shortfall = Cálculo digital efectivo − Conciliación manual`  
Positive = driver is short (owes money). `direction = lower_is_better`.

**Hub total** = sum of all drivers' shortfalls in that hub.  
**Global** = mean of hub totals (§9 above).

**Supabase setup:** `supabase_discrepancia_setup.sql` in project root — already applied to production 2026-05-07.

⚠️ **Stale upload pattern:** `Conciliación manual` in Retool is updated throughout the week as cash is manually reconciled. If you upload the CSV on Monday and check the tile on Friday, the numbers will look inflated — not a bug. Always re-upload the latest CSV export and hit Recompute before trusting the discrepancia tile values. Diagnosed session 5: Contry showed $40,131 from an early-week upload; after re-uploading the Friday export the value corrected to $8,087.

⚠️ **Why Contry and San Nicolás always look wrong first:** These hubs' coordinators reconcile their drivers' cash deposits later in the week than other hubs. On an early upload `Conciliación manual` for those drivers is still $0 → shortfall = full expected amount → inflated tile. Other hubs reconcile earlier so their numbers are already accurate on the first upload. This is a process difference, not a code bug. Confirmed via debug logging in session 9: computation was correct, hub names resolved, no rows skipped — root cause was purely stale `Conciliación manual`. **Operational fix:** upload discrepancia CSV on Friday, not earlier in the week.

---

## 19. Ideas / Possible Next Tasks

- **Resumen operativo — Phase 2 ideas, parked (not in scope).** See §21 and `PLAN_RESUMEN_OPERATIVO.md` §10: `impacto_incidentes_mxn` (quality KPIs expressed in pesos now that AOV exists), a reconciliation view for the 6 overlap columns vs our entity-derived numbers, timestamp/ventana KPIs (`kpi_unit` already has an unused `'minutes'` value), volume-weighted global means for count/currency KPIs generally (bigger decision, changes historical comparability).
- **KPI targets — finish Step 7 verification (session 11 leftover)**: explicitly test a 2×-hub-mean KPI (`pct_tardias_reparto` or `pct_undelivered`) — blank should stay on the 2× rule, setting a number should override it. Also do a final grep for any other stray consumer of the pre-session-11 hardcoded thresholds that might have been missed. See §14.
- **Report generator — rolling mean**: The DB `rolling_mean_4w` for the current week is null when the week was first computed before prior data existed. The report bundle now falls back to client-side computation, so the report works regardless. To permanently fix the DB: go to `/upload`, select the affected week, click "Recomputar snapshots". The enrichWithHistory function will find prior data and write the correct value.
- **Report generator — MNA/FA WoW sentence**: Requires `mna_fyv_pct`, `mna_carnes_pct`, `mna_graneles_pct` (and faltantes equivalents) to be in `kpiSummary` with populated `prevValue`. If those sub-KPIs don't have snapshots, Claude has nothing to compare.
- **Comparativa tab** — city filter removed (session 7). Always shows all hubs. Could add hub-vs-hub ranking tables or a best/worst summary row.
- **True data preloading (SWR)** — `loading.tsx` masks the wait but doesn't shorten the actual Supabase fetch time for the initial historicos load. If that's still too slow, convert `page.tsx` data fetching to a `/api/historicos-data` route + SWR client-side cache. Data would then persist in memory for the whole session — navigating away from and back to historicos would be instant after the first load. This is the Gmail/Instagram preload pattern.
- **CSS keep-alive tabs** — with the current `useState` conditional rendering, switching to a tab you've already visited still remounts its React component (~0.3-0.8s). For truly instant repeat visits, wrap each tab in `<div className={active ? '' : 'hidden'}>` so components stay mounted. Hold off until/if it feels slow — the initial render of all three tabs at once would make first load heavier.
- **Home dashboard** — quick summary of current-week KPI status across all hubs
- **Discrepancia trend** — shows automatically once 2+ weeks of data exist
- **Discrepancia provisional warning** — show a ⚠️ badge on the discrepancia tile when the upload for that week was created before Thursday (i.e. `uploads.created_at < week_start + 4 days`). Reminds ops the number is provisional and a re-upload on Friday is needed. Contry and San Nicolás are always affected because their coordinators reconcile cash later in the week.
- **New hubs** — if a hub is added to `hubs` table, add its alias to `lib/hub-aliases.ts` (shared by both compute and display)
- **San Rafael Puebla** — appears in discrepancia CSV but not in alias map; drivers show 0s and are skipped. Add to alias map if the hub goes live.

---

## 20. Environment

```
Workspace:   /Users/adrianrodriguez/Desktop/calii-ops-app
Deploy:      Netlify (git push to main triggers deploy)
Supabase:    https://nxwpsvvfgygafjnhwccc.supabase.co
```

---

## 21. Resumen operativo tab — SHIPPED (session 12, 2026-07-31)

**Original build instructions: `PLAN_RESUMEN_OPERATIVO.md` in the project root.** Feature is live in production. This section documents what actually shipped and where it diverged from that plan — read the plan for full rationale (the weighting math worked examples, the footgun table), but treat this section as the current source of truth on status.

### What it is
A 4th tab in `/historicos` (`📦 Resumen`) fed by a weekly Retool export — one row per hub, containing order volume, AOV, headcount and productivity rates. Uploaded **per city, 4 files/week**, covering the 7 hubs. Plus 3 WoW trend charts (added post-launch, see below).

### Registry objects (live in production)
- App: `resumen_operativo` (`scope: per_city`, `expected_files_per_week: 4`), 20 `app_columns`. Migration: `20260731000002_resumen_operativo.sql`.
- 8 KPIs, all `category = 'operacion'`: `pedidos_hub`, `pedidos_entregados`, `aov_mxn`, `ingresos_hub`, `pedidos_por_armador_dia`, `entregas_por_repartidor_dia`, `armadores_activos`, `repartidores_activos`.
- `kpi_unit` enum value **`currency_avg`** (AOV is an average, not a total — `currency` would make city scope sum the hub AOVs). Own migration: `20260731000001_kpi_unit_currency_avg.sql` (Postgres won't let a transaction use an enum value it just added).

### The three things that were most likely to be built wrong (all verified correct)
1. **Total row ≠ DB global row.** `aggregateAllScopes` writes the global scope as the *mean of hub totals* for `count`/`currency` (§9). `ResumenTab`'s Total row uses a client-side **true sum** of the 7 hub rows for count/currency KPIs (same override pattern `PorKpiTab.allChartData` already uses) and reads the DB global directly for `currency_avg`/`rate` (already correctly weighted). City rows are already true sums in the DB and need no override.
2. **Weighted, never unweighted.** AOV and the two per-person rates roll up as weighted averages — weight by whatever is on the bottom of the metric (AOV by orders, the rates by headcount) — encoded in `RESUMEN_FIELDS`' numerator/denominator choices (§9) so `aggregateAllScopes` does it automatically.
3. **New KPIs leak into other views.** `PorHubTab` tiles, `ComparativaTab`, and `GenerarReporte.buildBundle`'s `kpiSummary` all excluded via the `isResumenKpi` helper in `_shared.ts` (`category === 'operacion'`). `PorKpiTab`'s selector and heatmap **do** include them (decided); only its `topMovers` block excludes.

Verified live on the 2026-07-24 week against hand-computed numbers: Monterrey `aov_mxn` = $1,096.17 (not $4,350), `pedidos_por_armador_dia` = 6.7642 (not 27.3), Total `pedidos_hub` = 4,247 (sum of 4 cities, not the ~426 the DB global mean would show). Zero leakage confirmed into Por Hub tile count, Comparativa KPI count, or top movers.

### Deviations from the plan
Two open questions from `PLAN_RESUMEN_OPERATIVO.md` §9 were resolved during/after the build, not left open:

1. **`ingresos_hub` numerator** — plan hedged between `Pedidos (#)` and `pedidos_entregados` as the multiplier. Resolved: **`pedidos_entregados`** (delivered orders) — undelivered orders are never actually charged, so `Pedidos (#) × AOV` overstated revenue by the undelivered rate (~2.5% in the sample week). `aov_mxn`'s weighting still uses `Pedidos (#)` (unchanged — that question was specifically about `ingresos_hub`).
2. **`Nro. de pedidos / armador / día` — working days vs calendar days** — resolved: Calii operates 7 days/week uniformly across all hubs, so "día" is consistent across hubs and doesn't distort cross-hub comparison. No code change needed.

### WoW trend charts (added post-launch, same session)
`ResumenCharts.tsx` — `ResumenTrendChart` component, used 3× on the Resumen tab (Pedidos entregados, AOV, Ingresos estimados). Each chart is independent and has:
- A **Total / Por ciudad / Por hub** scope-mode toggle (not combined — mutually exclusive, unlike Por KPI's single hub-lines-plus-global-mean chart).
- Per-mode multi-select pills (cities or hubs) when not in Total mode, default all selected.
- The same 5 sem / 3 m / 6 m / 1 a / YTD range buttons as `PorKpiTab`'s main chart.
- Total-mode series uses the same sum-vs-weighted rule as the tree's Total row (`chronologicalSeries` + per-week sum for count/currency, DB global series directly for currency_avg/rate).

Not built: a combined dual-axis chart (the plan's §6 Step 5 optional suggestion) — the 3 separate single-axis charts were built instead, per direct request.

### Rollout sequence used (for reference — already executed, don't re-run)
Per plan §9a, in order: (1) filter-only commit pushed and verified as a no-op on production, (2) both migrations run as separate executions in the Supabase SQL editor (pasted via `pbcopy` to the clipboard — copying long SQL from the chat window truncates long lines and causes syntax errors), (3) localhost testing — uploaded all 4 real city files for week 2026-07-24, recomputed, verified against the plan's worked numbers, (4) `ResumenTab` + tab wiring pushed. A 5th, unplanned round shipped the `ingresos_hub` fix + trend charts together, requiring one more local recompute before pushing (formula changes always need a recompute — code alone doesn't retroactively fix stored `kpi_snapshots` rows).

Rollback at any point: `UPDATE kpis SET active = false WHERE category = 'operacion';` — hides all 8 and stops them computing (`kpi-compute.ts`, `page.tsx`) without touching data or code.

### Footguns from the build (resolved, kept for context)
- Every metric column is `required: false` — `MH San Pedro` ships the literal string `NaN`, and `validate.ts` hard-fails an upload on >5% type mismatches in *required* numeric columns.
- `MH San Pedro` is in `HUB_ALIAS_MAP` but **not** in the `hubs` table and **not** in `HUB_COLORS` — the extractor's `Pedidos (#) > 0` guard skips it (San Pedro ships an all-zero row today). Revisit if the hub goes live.
- `apps` in production has `group_id` / `group_label_es` columns that exist in **no local migration file** — the migration used an explicit column list rather than a bare `INSERT INTO apps VALUES (...)`.

---

## 22. Upload identity safety net (session 13, 2026-07-31)

### The gap it closes
`lib/validate.ts`'s 3-layer check (header / type / distribution) only looks at a CSV in isolation — it can't tell that a file is the *wrong* file, just that it's a *malformed* one. The highest-blast-radius upload mistake is content-level, not shape-level: dropping the right kind of file into the wrong city/hub slot (Saltillo's operators CSV into the Monterrey slot). Jose's framing: "if it notices I'm uploading a file with a bunch of [wrong-location] names, it shouldn't let me."

### What it checks, and why some apps are excluded
`lib/validate-identity.ts` exports `computeIdentityChecks()`, gated per app by an `IDENTITY_CONFIG` map:

| App | `hubField` | `nameFields` |
|---|---|---|
| `desempeno_operadores` | `geofence` | `assembler` |
| `desempeno_repartidores` | `hub` | `driver_name`, `driver_nickname` |
| `resumen_operativo` | `Hub` | — |
| `incidentes` | — | `Operador` |
| `discrepancia` | `Hub` | `Repartidor` |

**Deliberately excluded:** `mna` (uploaded per-hub, but the product/SKU catalog is shared across every hub — the same SKU names appear everywhere, so name-overlap can't discriminate one hub from another) and the `faltantes_hub_*_pct` apps (`scope: total` — a single file already covers every hub in one upload, so there's no per-slot swap possible in the first place). Both exclusions were Jose's own reasoning, confirmed correct.

Two checks run per upload, both only for apps present in the config above:

1. **Hub-column check (deterministic).** For any row with a `hubField` value, resolve it via the existing `resolveHubId` (`lib/hub-aliases.ts`) and look up that hub's real `city` from the `hubs` table. Bucket rows by resolved city. If a city *other than* the declared upload city has more matching rows than the declared city does, that's `identity_hub_city_mismatch` — a hard error. Fewer than `MIN_ROWS_FOR_HUB_ERROR` (3) resolvable rows downgrades to a warning — not enough signal to block on a tiny file. A handful of stray out-of-city rows that don't out-number the declared city produces `identity_hub_stray_rows`, a non-blocking warning.
2. **Roster-overlap check (fuzzy, vs. history).** Normalizes names (NFD-strip accents, lowercase, trim) and computes *retention*: what fraction of last week's names for a slot are still present this week. Same-slot retention below `ROSTER_WARN_RETENTION` (0.30) → warning only (`identity_roster_low_retention`) — real turnover happens, this is a nudge not proof. For per-city apps, also computes retention against every *other* city's most recent upload; if some other city's retention both clears `ROSTER_CROSS_MATCH_FLOOR` (0.50) and beats the declared city's own retention, that's `identity_roster_mismatch` — a hard error. `discrepancia` is `scope: total` (one slot, no siblings) so only the same-slot warning applies to it, never the cross-slot error.

Both checks run read-only queries against `uploads`/`upload_rows`/`hubs` — no writes happen until after both pass (or are overridden), so a blocked upload leaves zero trace.

### Override model
`identity_*` errors (not header/type errors — those are never override-able) return `422` with `overridable: true` in the JSON body. The client (`UploadDropzone.tsx`) resubmits the same `File` with `force_identity=true` in the form data; the route downgrades those specific errors to warnings (suffixed `_overridden`) and proceeds. Every override is logged to `audit_log` with `override_identity: true` and `overridden_checks: [...codes]` — Jose's own reasoning for keeping an override at all: "in case its on purpose or the site is glitching," i.e. don't make a heuristic un-overridable, but make the override traceable.

`UploadDropzone.tsx` shows two buttons on an overridable failure: "⚠️ Sé lo que hago, subir de todas formas" (resubmits with the override) and "No, cancelar" (just clears the error state — added after the first pass shipped without it, since the only way to dismiss an override prompt was to drop a different file).

### Verification
Read-only script (no writes) run against real production data for week 2026-07-24: `desempeno_operadores` Saltillo's actual 13 rows, declared correctly as Saltillo → zero errors, zero warnings. The same 13 rows re-declared as Monterrey → both checks fired correctly: `identity_hub_city_mismatch` (13/13 rows resolve to Saltillo hubs, 0/13 to Monterrey) and `identity_roster_mismatch` (87% retention vs. Saltillo's history, 0% vs. Monterrey's). Confirms zero false positives on the legitimate case and a correct catch on the deliberately-wrong case.

### Extending this
If a future app is added with a per-city or per-hub upload slot and either a resolvable hub/geofence column or a person-name column, add it to `IDENTITY_CONFIG` in `lib/validate-identity.ts` — that's the only wiring needed; the route and UI are already generic.

---

## 23. Modo Entrenamiento — tenure-aware targets (session 14, 2026-08-20)

**Full design doc: `PLAN_MODO_ENTRENAMIENTO.md` (project root).** Feature is live in production, built in 7 verified slices. This section documents what shipped and the footguns hit along the way — read the plan for full design rationale (the §4 derivation algorithm, the §5.2 re-entry guard reasoning), but treat this section as the current source of truth on status.

### What it is
New armadores shouldn't be judged against the veteran `tasa_armado` target (100 SKUs/hr) on day one. They now get a **ramped goal that rises week by week for their first 10 weeks**, then graduate to the normal target. New repartidores get a **label only, for 4 weeks** — no ramped goal, since the request was specifically about the assembler onboarding curve.

There is no hire-date field anywhere in the data, so tenure is **derived** from upload history: the first week a person's `operator_id`/`driver_id` appears is week 1; every subsequent Fri–Thu week increments the count; week 11+ is a veteran. A person who returns after a ≥10-calendar-week gap gets a 2-week `(RI)` (reingreso) label — a supervision flag, not a lower bar; they're on the veteran target the moment they're back.

### Data model
- **`person_tenure`** (`20260819000001_person_tenure.sql`, RLS added in `20260819000004`) — the derived ledger, one row per `(person_key, role)`. `first_seen_week` is the only field the S-number is computed from; `seen_weeks` (bounded array, one entry per week they appeared) is the only field the `(RI)` badge is computed from. `confidence='low'` (reason `data_horizon` or `missing_prior_week`) means "can't trust this is really day one" — treated as a veteran, the safe failure direction. `source='manual'` rows are permanently excluded from refresh overwrites.
- **`kpi_ramp_targets`** (`20260819000002_kpi_ramp_targets.sql`, RLS added in `20260819000003`) — 10 seeded rows, `tasa_armado`/`armador` only: week 1 mínimo 50 → week 10 mínimo 100 (= the veteran target, so week 10 is functional graduation), esperado always +5 ahead except week 10 (100, UI renders "100+"). No repartidor rows — `resolvePersonTarget` finding none is a normal, unwarned path.

### The derivation algorithm (`lib/tenure.ts`)
`deriveTenureLedger(sb, role)` walks every validated upload for the role's app (`desempeno_operadores` / `desempeno_repartidores`) chronologically, fetching `upload_rows` **one upload at a time** (`eq('upload_id', id).limit(10_000)`, never `ORDER BY id`, never `IN(...)` range pagination — same statement-timeout/non-determinism reasons as §9's `kpi-compute.ts` fetch strategy). It's pure/read-only; `refreshTenureLedger(sb, opts)` wraps it and does the actual upsert (sequential 200-row batches, skips `source='manual'`, plain `upsert(onConflict: 'person_key,role')` — safe here since neither PK column is nullable, unlike `kpi_targets`).

**Called from:** `POST /api/recompute` (before `computeSnapshotsForWeek`, blocking — a bad refresh should surface, not hide) and `POST /api/upload` (fire-and-forget after a successful `desempeno_operadores`/`desempeno_repartidores` insert — a tenure-refresh failure must never fail the upload itself).

**Re-entry guard (§5.2 of the plan):** a gap ≥10 calendar weeks between two of a person's appearances only counts as `(RI)` if at least one validated upload exists somewhere in that gap window. Zero uploads in the whole window means the *app* wasn't used that stretch, not that the *person* was absent — without this guard, the first week after any such stretch would badge the entire roster `(RI)` simultaneously. `computeReentryWeeks()` implements this; `reentry_weeks` is **not** a `person_tenure` column (it depends on `weeksWithData`, a per-app fact, not a per-person one) — every reader must call `hydrateTenureRow(dbRow, weeksWithData)` before `tenureStatus()`. See the footgun table (§12).

### Status resolution + targets (`lib/tenure.ts` + `historicos/_shared.ts`)
`tenureStatus(row, weekStart)` — precedence reentry > trainee > veteran — takes the **displayed** week, never `new Date()`; a picker who's `S9` today was `S4` five weeks ago, and any WoW tooltip hovering that week must say `S4`. `tenureLabel()` formats for on-screen text (`' (S4)'`); `tenureCode()` returns the bare code (`'S4'`) for contexts that compose their own punctuation (the report bundle, `/config`'s supervision list).

`resolvePersonTarget(kpiId, hubId, status, role, targets, ramps)` in `historicos/_shared.ts` is **entity-scope only** — hub tiles, the PorKpiTab chart's `meta` reference line, and every `kpi_snapshots`-derived number keep using plain `resolveTarget`. Precedence: ramp row (only when `status.kind === 'trainee'`) > hub target > global target > undefined. `stretch` (esperado) is returned alongside the target, never folded into it — `meetsTarget` must never see it, or trainees get flagged for missing an aspirational number.

### Where badges render
Everywhere a name appears in `/historicos`'s Por Hub tab: KPI tile back-face ranked lists, both `MultiSelectDropdown`s (assembler/driver WoW person filters), and `WowTooltip` (resolved per the **hovered** week via a label→ISO lookup map, not `currentWeek`). One helper (`tenureBadge()` in `PorHubTab.tsx`) is the only place that formats a badge — never an inline template string. `PorKpiTab.tsx` renders no person names, so nothing to do there.

Two name-index `Map`s (armador/repartidor, kept separate — a driver and an assembler could share a normalized name) are built **once** in `HistoricosClient.tsx` via `useMemo` and threaded down as props, not rebuilt per tile/tooltip.

### Report wiring (`GenerarReporte.tsx` + `api/generar-reporte/route.ts`)
`PeerEntity` gained optional `tenureBadge` / `personalTarget` / `personalStretch`. For `tasa_armado` only, each entity flags against `resolvePersonTarget(...).target` instead of the group-level target when they're a trainee (falls back to the existing `effectiveTarget`/`defaultThreshold` chain for veterans — untouched). Driver KPI groups get `tenureBadge` only (no ramp rows exist for repartidores). `buildTextBundle()` pulls trainees below their personal mínimo out of the "Tasas" flagged list and into their own `ARMADORES EN ENTRENAMIENTO POR DEBAJO DE SU MÍNIMO` block — a trainee at/above mínimo appears in **neither** list; a veteran below the group threshold stays in Tasas exactly as before. `SYSTEM_PROMPT` got one new rule (same imperative style as the existing `escribir esta línea exacta` rules) — the four main section headers were **not** restructured (HANDOFF §13's fragile-prompt warning still applies).

Live-verified on a real "Generar reporte" run for MH Contry: 4 trainees (S1/S2/S2/S8) landed in the new block with the exact `- Nombre (Sx): value — mínimo Sx: N (esperado M)` format and were absent from the 12-person veteran Tasas list, which was itself unaffected.

### `/config` — "Entrenamiento / Rampa"
`RampTargetsSection.tsx`: the 10-row mínimo/esperado editor (slice 3), a read-only **"En entrenamiento"** supervision list (everyone currently badged — name/role/hub/badge/first-seen-week/confidence), and an **"Overrides manuales"** list. The second list exists because a `"Graduar"` override removes someone from "En entrenamiento" — without a separate place to find them again, there'd be no way to ever click "Revertir a derivado" on a graduated person. `app/api/person-tenure/route.ts` handles both override actions; `DELETE` doesn't delete the row or recompute it, it just flips `source` back to `'derived'` so the *next* `refreshTenureLedger()` run overwrites it with fresh data.

**Live-verified full override lifecycle** against real production data (person_key 4973, Abril Alejandra Galindo Oppenheimer): graduated via the UI (badged count 33→32) → ran the real refresh, confirmed `manual_skipped=1` and her row untouched → found her in "Overrides manuales", clicked "Revertir a derivado" (`source` flipped to `derived`, values stayed stale as designed) → ran the refresh again → her row came back byte-identical to its pre-test state (`confidence: high`, `S1`, `source: derived`).

### Footguns hit during this build (also in §12)
- **Forgot RLS on both new tables.** `create table` alone isn't enough — every table a client component reads needs its own `enable row level security` + `auth_read_X` policy, or the session-authenticated client silently gets zero rows while a service-role script sees everything. Cost two follow-up migrations (`20260819000003`, `20260819000004`).
- **`resolveTarget is not a function` in a Server Component.** `historicos/_shared.ts` is `'use client'`; its exports become opaque client references when called from a server page. Fixed by moving the `resolveTarget` call into the client component and passing raw `targets` down instead.
- **Badges getting truncated away.** The WoW tooltip's `max-w-[110px]` name span and the multi-select dropdown's `max-w-[160px]` span were swallowing the badge along with the overflow ellipsis on long Mexican names. Fixed by pulling the badge into a `shrink-0` sibling span, outside the truncating one.

### Verification status
Slice-1 dry run against real production data (2026-08-19): 181 armadores / 105 repartidores considered, 23 / 10 badged for the current week, zero `(RI)` hits (dataset only spans 20 weeks — mathematically tight for a 10-week-gap return to occur yet, not evidence the guard is broken), 3 normalized-name collisions surfaced (2 repartidor, 1 armador — flagged for Jose to confirm rehire-vs-different-person, not auto-resolved). All 18 test cases in the plan's §10 matrix pass via `scripts/test-tenure.ts` (`npm run test:tenure`). Badges, report wiring, and the `/config` override lifecycle were each live-verified in the browser against real data, not just typechecked — see the sections above.

**Rollback:** `UPDATE kpi_ramp_targets SET active = false;` — every trainee immediately falls back to the veteran target and the report reverts to current behavior. Badges keep rendering (they read from `person_tenure`, which is inert data on its own); to drop those too, guard the badge render on `ramps.length > 0`.
