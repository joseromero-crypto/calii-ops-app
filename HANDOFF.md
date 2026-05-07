# Calii Ops App — Engineering Handoff

**Last updated:** 2026-05-07  
**Project:** Calii Ops Weekly Dashboard (Next.js 14 + Supabase, deployed on Netlify)  
**Prepared for:** Jose Romero / next session

---

## 1. Project Overview

Internal ops dashboard for Calii hub operations. Tracks weekly KPIs per hub (MH), including assembler performance, driver performance, MNA (merma / no-apto), and faltantes. Data is uploaded weekly via a separate upload flow and computed into two main tables: `kpi_snapshots` and `peer_comparisons`.

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
| `lib/kpi-compute.ts` | Core KPI computation — processes raw upload rows into peer_comparisons rows |
| `lib/sku-classifier.ts` | Classifies product names into MnaCategory: 'fyv' / 'carnes' / 'abarrotes' |

---

## 3. Database Tables (relevant)

### `kpi_snapshots`
One row per KPI × week × scope. Columns used:
- `kpi_id`, `week_start`, `scope_level` ('hub' | 'city' | 'global'), `scope_key` (hub_id or city name)
- `value`, `numerator`, `denominator`, `prev_week_value`, `rolling_mean_4w`

Note: `rolling_mean_4w` and `value` for pct KPIs are stored as **0–1 fractions** here, not percentages.

⚠️ `prev_week_value` and `rolling_mean_4w` are only populated for the most recent weeks in the DB. For older historical rows they may be null. The heatmap in PorKpiTab computes these from the chronological snapshot array client-side as a fallback.

### `peer_comparisons`
One row per entity × KPI × week × scope. Columns:
- `kpi_id`, `week_start`, `entity_type` ('operator' | 'driver'), `entity_key` (person name)
- `scope_type` ('within_hub' | 'within_city'), `scope_key` (hub_id or city key)
- `value`, `peer_mean`, `z_score`, `rank`, `rank_total`

⚠️ **CRITICAL: `peer_comparisons` has NO `hub_id` column.** PostgREST silently ignores unknown columns on UPSERT but returns `data: null` on SELECT if you request a non-existent column. All SELECTs must omit `hub_id`. Use `scope_key` to identify hub — for `within_hub` rows, `scope_key === hub_id`.

Note: pct KPI `value` in `peer_comparisons` is also stored as **0–1 fraction**.

### `upload_rows`
Raw uploaded data rows. `data` column is a JSON blob. Processed by `lib/kpi-compute.ts`.

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

---

## 5. Mobile Layout

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

## 6. PorKpiTab Architecture

### Tab bar
- Tab label: `📈 Por KPI` (no suffix)
- Tab bar has `overflow-x-auto` + `shrink-0 whitespace-nowrap` on each tab for mobile scrolling

### Top movers strip
- 5 cards, biggest absolute WoW change across all KPIs × hubs
- Clicking a card navigates to that KPI via `router.push`

### Main chart
- Line per hub + **dashed grey global mean trend line** (`dataKey="__global__"`)
- Global mean sourced from `kpi_snapshots` `scope_level === 'global'` rows
- Both stored as 0–1 fractions; `formatValue` handles ×100 for pct display
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

## 7. PorHubTab Architecture

### KPI Tiles (top section)
- Grid: `grid-cols-1 md:grid-cols-2 lg:grid-cols-3`
- **Front face:** value, WoW delta, 12-week sparkline, 4w rolling average reference line.
- **Back face (click to flip):** ranked list worst→best.
  - Assembler/driver KPIs: **full list, no cap** — all employees shown (scrollable via `overflow-y-auto`)
  - MNA KPIs: top products by `$` (amount) + `%` — max 10 items
  - Faltantes subcategory KPIs: top SKUs by event count — max 8 items
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

### MNA Hub ID Resolution (`resolveHubId` in page.tsx)
Normalises raw hub strings from CSV/DB to canonical hub IDs.
Normalization: NFD accent strip → lowercase → trim → hyphens + spaces → underscore.
`ch_*` prefixes are dropped (city-level).

Known aliases:
```
mh_contry / contry / mh_country / country → 'mh_contry'
mh_cumbres / cumbres                       → 'mh_cumbres'
mh_san_nicolas / san_nicolas               → 'mh_san_nicolas'
mh_guadalupe / guadalupe                   → 'mh_guadalupe'
mh_avicola / avicola / mh_saltillo / saltillo → 'mh_avicola'
mh_zapopan / zapopan                       → 'mh_zapopan'
mh_condesa / condesa                       → 'mh_condesa'
mh_san_pedro / san_pedro                   → 'mh_san_pedro'
```

⚠️ A `console.warn('[resolveHubId] unrecognised hub string: ...')` fires for any string not in the map. Watch the dev server terminal when navigating MNA tiles to catch mismatches. If Contry MNA tiles still show empty, check terminal for the warn log.

### WoW Charts
- Grid: `grid-cols-1 sm:grid-cols-2 gap-3`
- Wide hero chart: `sm:col-span-2`
- Shared x-axis per section (last 5 weeks)
- Y-axis range slider: `writingMode: 'vertical-lr'` — do NOT add `direction: 'rtl'`
- `allowDataOverflow={true}` on YAxis — required for zoom-in to work
- pct values stored as 0–1 fractions → ×100 before charting

---

## 8. lib/kpi-compute.ts — extractIncidentesValues

Zero-fill for driver roster: inserts `{ numerator: 0, denominator: 1 }` for any driver in `desempeño_repartidores` NOT found in incidents. Ensures zero-incident drivers appear in WoW chart.

---

## 9. HubCityKey Resolution

`peer_comparisons.scope_key` for `within_city` rows = city enum like `'mty'`.
`hubs.city` = display name like `'Monterrey'`. These don't match as strings.

Resolution waterfall in PorHubTab:
1. Exact string match
2. Cross-reference: find scope_key whose entity_keys overlap most with hub's `within_hub` entities
3. Accent/case-normalized match
4. Single-hub-city fallback

---

## 10. Known Footguns

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
| `lg:hidden` elements in CSS grid | `display:none` children don't consume a grid column — MobileHeader's `lg:hidden` elements are invisible and don't push `<main>` on desktop. |

---

## 11. Local Development

```bash
cd ~/Desktop/calii-ops-app
npm run dev
# → http://localhost:3000
```

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

---

## 12. Commits (these sessions)

```
[latest push]  PorKPI: trend line, heatmap WoW+baseline color, tab rename; PorHub: full lists, MNA resolveHubId; mobile responsive
71160f4        mobile: responsive layout, hamburger drawer, tab bar, WoW chart grids
a88c9ed        WoW charts: replace custom drag slider with native vertical range input
e17bc0a        WoW charts: fix p75 index; dynamic tooltip sort; zero-fill roster drivers
4952076        WoW charts: p75 y-axis cap; tooltip z-index fix
82bf8da        WoW charts: remove legend; cap y-axis; consistent x-axis per section
682dbf1        fix: remove hub_id from peer_comparisons SELECT; MNA flip to single $ list
```

---

## 13. What's Working ✓

- All 7 assembler WoW charts + all 3 driver WoW charts
- Mobile layout: hamburger drawer, responsive grids, scrollable tab bar
- Por KPI: global mean trend line on chart, revised heatmap (value + WoW delta + own-baseline color)
- Por Hub KPI tiles: σ-based color vs own history, full assembler/driver lists on flip (no cap)
- MNA tile flip: single $ list with % alongside, sorted highest $ first
- Faltantes SKU tile flip: top SKUs by event count per subcategory
- Hub switching: fully client-side, no server round-trip
- Y-axis slider: smart cap default, resets on hub switch

---

## 14. Next Task — Discrepancy KPI

**Goal:** Track weekly discrepancy between money actually deposited and expected money from sales.

**Business definition (to confirm):**
- `expected` = sum of all orders delivered × order total for the week
- `deposited` = cash/transfer actually deposited and reconciled
- `discrepancy` = `deposited − expected` (negative = short, positive = overage)
- KPI unit: currency (`$`) for absolute amount, or pct of expected

**Open questions before implementation:**
1. Where does deposit data live? CSV upload, existing Supabase table, or external system?
2. Where does the expected (sales) total come from? Existing upload or separate source?
3. Scope: per hub only, or also per driver?
4. Should it appear in Por Hub tiles, Por KPI, and/or home dashboard?
5. Direction: `lower_is_better` (minimize absolute discrepancy) or track signed value?

**Implementation path (once data source confirmed):**
1. Add KPI row to `kpis` table: `id`, `name_es`, `unit`, `direction`, `category`, `source_app_id`
2. Add upload type if needed, or hook into existing upload pipeline
3. Add extraction logic in `lib/kpi-compute.ts`
4. `kpi_snapshots` and `peer_comparisons` populated automatically on recompute
5. No frontend changes needed — new KPI appears in all tabs automatically

---

## 15. Environment

```
Workspace:   /Users/adrianrodriguez/Desktop/calii-ops-app
Bash mount:  /sessions/dazzling-serene-albattani/mnt/calii-ops-app/
Deploy:      Netlify (git push to main triggers deploy)
Supabase:    https://nxwpsvvfgygafjnhwccc.supabase.co
```
