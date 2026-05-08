# Calii Ops App — Engineering Handoff

**Last updated:** 2026-05-08 (session 3)  
**Project:** Calii Ops Weekly Dashboard (Next.js 14 + Supabase, deployed on Netlify)  
**Prepared for:** Jose Romero / next session

---

## 1. Project Overview

Internal ops dashboard for Calii hub operations. Tracks weekly KPIs per hub (MH), including assembler performance, driver performance, MNA (merma / no-apto), faltantes, and cash discrepancy. Data is uploaded weekly via a separate upload flow and computed into two main tables: `kpi_snapshots` and `peer_comparisons`.

The main feature areas:
- **`/historicos`** — historical analytics page with three tabs: Por KPI, Por Hub, Comparativa
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
| `app/(app)/historicos/HistoricosClient.tsx` | Client shell — tab routing (Por KPI / Por Hub / Comparativa) |
| `app/(app)/historicos/PorHubTab.tsx` | "Por Hub" tab — KPI tiles + WoW charts |
| `app/(app)/historicos/PorKpiTab.tsx` | "Por KPI" tab — trend line chart, heatmap, top movers |
| `app/(app)/historicos/ComparativaTab.tsx` | "Comparativa" tab — not touched in these sessions |
| `app/(app)/historicos/_shared.ts` | Shared types, formatting helpers, utility functions |
| `app/api/upload/route.ts` | Upload API — parses CSV, validates, stores upload + rows |
| `lib/kpi-compute.ts` | Core KPI computation — processes raw upload rows into snapshots + peer comparisons |
| `lib/hub-aliases.ts` | **Single source of truth** for hub name → hub_id mapping. Both kpi-compute and page.tsx import from here. Add new hubs/aliases here only. |
| `lib/sku-classifier.ts` | Classifies product names into MnaCategory: 'fyv' / 'carnes' / 'abarrotes' |
| `lib/parse.ts` | CSV parsing + coerceRows (applies app_columns schema to raw CSV strings) |
| `lib/validate.ts` | Upload validation — header check, type check, distribution check |
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
  │     ├── upload_rows MNA     (current week)
  │     ├── upload_rows faltantes_armador (current week)
  │     ├── assemblerTrend      (multi-week, entity_type=operator, scope=within_hub)
  │     └── driverTrend         (multi-week, entity_type=driver,   scope=within_hub)
  └── Flat arrays → HistoricosClient → PorKpiTab / PorHubTab / ComparativaTab
```

Hub switching is **client-side only** — all hubs' data is fetched once and filtered in the browser.

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
2. Parse multipart form (`app_id`, `week_start`, `city?`, `hub_id?`, `file`)
3. Validate `week_start` is a Friday — uses **local noon** (`T12:00:00`) not UTC midnight (`T00:00:00Z`) to avoid timezone mismatch with `weekStartFriday`'s local-time methods
4. Look up `apps` + `app_columns` from DB
5. Parse CSV with PapaParse
6. Validate headers + types vs `app_columns` schema
7. **Delete all existing uploads** for this (app, week, city, hub) slot using `select()` + `in()` delete — handles PostgreSQL `NULL != NULL` in unique constraints that caused silent duplicate inserts with plain upsert
8. Insert fresh upload record + coerced rows

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
- Clicking a card navigates to that KPI via `router.push`

### Main chart
- Line per hub + **dashed grey global mean trend line** (`dataKey="__global__"`)
- Global mean sourced from `kpi_snapshots` `scope_level === 'global'` rows for pct/rate; **computed client-side** for count/currency
- For **pct/rate** KPIs: global = weighted sum of all entity numerators/denominators (stored in DB, correct)
- For **count/currency** KPIs: global = **mean of hub values, computed client-side in `allChartData`** — DB stored the raw sum historically; client-side overrides fix all historical weeks without a recompute
- `peerMeanThisWeek` (toolbar badge) uses the same client-side logic for count/currency
- Both stored as 0–1 fractions for pct; raw MXN for currency; `formatValue` handles display
- Timeline selector: 5 sem / 3 m / 6 m / 1 a / YTD

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

### `extractIncidentesValues`
Zero-fill for driver roster: inserts `{ numerator: 0, denominator: 1 }` for any driver in `desempeño_repartidores` NOT found in incidents. Ensures zero-incident drivers appear in WoW chart.

### `extractDiscrepanciaValues`
CSV columns: `Repartidor`, `Hub`, `Cálculo digital efectivo` (expected), `Conciliación manual` (deposited).  
`shortfall = expected − deposited` (positive = driver is short).  
Accepts both accented and unaccented column name variants.  
Drivers from unknown hubs (e.g. San Rafael Puebla, CH Guadalupe) are skipped — `hubNameToId` returns null.

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

## 11. Known Footguns

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
| NULL conflict in upsert | `upsert onConflict(app_id,week_start,city,hub_id)` silently inserts duplicates when city=null AND hub_id=null. Use the current delete-then-insert pattern (select all → delete all → insert) for any re-upload logic. |
| Empty `app_columns` = empty rows | `coerceRows` only stores columns defined in `app_columns`. Missing `app_columns` = all rows stored as `{}` = KPI computation produces nothing silently. Always add `app_columns` when registering a new app. |
| `coerceRows` drops extra columns | CSV columns not in `app_columns` are silently dropped. The validator flags them as warnings but still marks status='validated'. |
| count/currency global = mean not sum | For count and currency KPIs, `kpi_snapshots` global scope should be mean of hub totals. `aggregateAllScopes` now does this for both. `PorKpiTab` recomputes client-side to fix historical weeks. |
| Duplicate uploads → recompute crash | Multiple upload records for the same slot cause `extractDiscrepanciaValues` (and any driver extractor) to output duplicate entity_keys → duplicate rows in upsert batch → PostgreSQL error. Dedup guard in `computeSnapshotsForWeek` now catches this, but fix the root cause (upload dedup) first. |
| Recompute statement timeout | Supabase default statement timeout (~8 s) is hit when many uploads are processed. Fixes: (1) `ORDER BY id` removed from upload_rows fetch; (2) sequential 200-row upsert batches. `ALTER ROLE postgres SET statement_timeout = '30s'` helps but doesn't fully fix it alone — PostgREST connection pool needs to cycle for role changes to take effect. |
| Hub alias map divergence | Previously `kpi-compute.ts` and `page.tsx` had separate copies of the hub alias map. They diverged — compute was missing the `country`/`mh_country` typo alias that page.tsx had, causing Contry MNA totals to be missing. Now unified in `lib/hub-aliases.ts`. Never duplicate the map again. |
| MNA breakdown works, total blank | MNA breakdown reads `upload_rows` directly in page.tsx (always fresh). MNA tile total reads `kpi_snapshots` (written by recompute). They can be out of sync if recompute hasn't run or failed silently. |
| MNA/faltantes breakdown blank for some hubs (session 3) | Range pagination over `IN(upload_ids)` without ORDER BY is non-deterministic — rows from one upload can overlap pages. Fixed in session 3: page.tsx now fetches upload_rows one upload at a time (eq upload_id + limit 10_000), same as kpi-compute.ts. |
| Wrong-city operators shown on tile flip | The hubCityKey step 4 fallback returned the sole city-key from allCityKeys without checking it matches hub.city. For single-hub cities (Zapopan, Condesa) this caused avicola operators to appear when only Saltillo had resolved data. Fixed in session 3: added `normalize(allCityKeys[0]) === normCity` guard. |
| GDL drivers/operators with null hub_id | geofence column sometimes contains "GDL" (abbreviation) instead of "Guadalajara" or "Zapopan". Added `'gdl': 'mh_zapopan'` to hub-aliases in session 3. Similarly added `'df'`, `'ciudad_de_mexico'`, `'mexico'` → `'mh_condesa'`. |

---

## 12. Local Development

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

## 13. Commits

```
(next)   display: MNA per-upload fetch; hubCityKey step-4 guard; hub-aliases GDL/CDMX variants
(prev)   compute: hub-aliases shared module, upload_rows fetch fix, sequential upserts
f40bcf0  PorHub: person filter dropdowns, stable colors, tooltip fix, tile coloring; PorKPI + compute: global mean for count KPIs
91c9a52  feat: Discrepancia KPI; fix upload dedup + currency global mean
6561a02  PorKPI: trend line, heatmap WoW+baseline color, tab rename; PorHub: full lists, MNA resolveHubId; mobile responsive
71160f4  mobile: responsive layout, hamburger drawer, tab bar, WoW chart grids
a88c9ed  WoW charts: replace custom drag slider with native vertical range input
e17bc0a  WoW charts: fix p75 index; dynamic tooltip sort; zero-fill roster drivers
4952076  WoW charts: p75 y-axis cap; tooltip z-index fix
82bf8da  WoW charts: remove legend; cap y-axis; consistent x-axis per section
682dbf1  fix: remove hub_id from peer_comparisons SELECT; MNA flip to single $ list
```

---

## 14. What's Working ✓

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

---

## 15. Discrepancia KPI — Reference

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

---

## 16. Ideas / Possible Next Tasks

- **Comparativa tab** — not touched yet; could show hub-vs-hub ranking tables
- **Home dashboard** — quick summary of current-week KPI status across all hubs
- **Discrepancia trend** — shows automatically once 2+ weeks of data exist
- **New hubs** — if a hub is added to `hubs` table, add its alias to **both** `HUB_ALIAS_MAP` in `lib/kpi-compute.ts` AND `resolveHubId` in `page.tsx` — both maps must stay in sync
- **San Rafael Puebla** — appears in discrepancia CSV but not in alias map; drivers show 0s and are skipped. Add to alias map if the hub goes live.

---

## 17. Environment

```
Workspace:   /Users/adrianrodriguez/Desktop/calii-ops-app
Deploy:      Netlify (git push to main triggers deploy)
Supabase:    https://nxwpsvvfgygafjnhwccc.supabase.co
```
