# Calii Ops App — Engineering Handoff

**Last updated:** 2026-05-06  
**Project:** Calii Ops Weekly Dashboard (Next.js 14 + Supabase, deployed on Netlify)  
**Prepared for:** Jose Romero / next session

---

## 1. Project Overview

Internal ops dashboard for Calii hub operations. Tracks weekly KPIs per hub (MH), including assembler performance, driver performance, MNA (merma / no-apto), and faltantes. Data is uploaded weekly via a separate upload flow and computed into two main tables: `kpi_snapshots` and `peer_comparisons`.

The main feature area touched across these sessions is **`/historicos`** — the historical analytics page with three tabs: Por KPI, Por Hub, and Comparativa.

---

## 2. Key Files

| File | Role |
|---|---|
| `app/(app)/historicos/page.tsx` | Server component — fetches ALL data from Supabase, passes to client |
| `app/(app)/historicos/HistoricosClient.tsx` | Client shell — tab routing (Por KPI / Por Hub / Comparativa) |
| `app/(app)/historicos/PorHubTab.tsx` | Main client component for the "Por Hub" tab — KPI tiles + WoW charts |
| `app/(app)/historicos/PorKpiTab.tsx` | "Por KPI" tab — not touched in these sessions |
| `app/(app)/historicos/ComparativaTab.tsx` | "Comparativa" tab — not touched |
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
  └── Flat arrays → HistoricosClient → PorHubTab / PorKpiTab / ComparativaTab
```

Hub switching is **client-side only** — all hubs' data is fetched once and filtered in the browser.

---

## 5. PorHubTab Architecture

### KPI Tiles (top section)
- Grid of all active KPIs for the selected hub.
- **Front face:** value, WoW delta, 12-week sparkline, 4w rolling average reference line.
- **Back face (click to flip):** ranked list of operators/drivers worst→best per the current week.
  - MNA KPIs: top products by `$` (amount) + `%` per row — sourced from `upload_rows`, NOT `peer_comparisons`.
  - Faltantes subcategory KPIs (fyv/carnes/graneles): top SKUs by event count from the breakdown upload.
  - All other KPIs: `peer_comparisons` ranked list, worst→best.
- **Tile color:** green / red / white based on this week vs the hub's own 4w rolling mean. Uses σ-based threshold (0.75σ). Fallback: ±5% relative when σ is unavailable or 0.

### MNA Tile Category Filter Map
```ts
const MNA_CATEGORY_FILTER: Record<string, MnaCategory | null> = {
  mna_pct:          null,        // all categories
  mna_graneles_pct: 'abarrotes', // shelf-stable / dry goods ("Graneles" in Spanish)
  mna_fyv_pct:      'fyv',
  mna_carnes_pct:   'carnes',
};
```
Note: "Graneles" (Calii's term) = `'abarrotes'` in the classifier.

### Faltantes SKU Category Filter Map
```ts
const FALTANTES_SKU_CATEGORY_FILTER: Record<string, MnaCategory> = {
  faltantes_fyv_pct:      'fyv',
  faltantes_carnes_pct:   'carnes',
  faltantes_graneles_pct: 'abarrotes',
};
// faltantes_armador_pct (general) is intentionally excluded —
// its flip shows the assembler peer ranking, not SKU data.
```

---

## 6. WoW Charts

Two sections at the bottom of PorHubTab: Assemblers (7 KPIs) and Drivers (3 KPIs).

### Data source
`assemblerTrend` / `driverTrend` — multi-week `peer_comparisons` rows, `within_hub` scope only. Filtered client-side to `scope_key === hubId`, then to `kpi_id`.

### KPI_META lookup
```ts
const KPI_META: Record<string, KpiMeta> = {
  // Assembler KPIs
  faltantes_armador_pct:              { title: 'Faltantes armador',    unit: 'pct',   direction: 'lower_is_better'  },
  incidentes_manuales_pct:            { title: 'Incidentes general',   unit: 'pct',   direction: 'lower_is_better'  },
  incidentes_calidad_pct:             { title: 'Incidentes calidad',   unit: 'pct',   direction: 'lower_is_better'  },
  incidentes_faltantes_pct:           { title: 'Incidentes faltantes', unit: 'pct',   direction: 'lower_is_better'  },
  incidentes_faltantes_completos_pct: { title: 'Faltantes completos',  unit: 'pct',   direction: 'lower_is_better'  },
  incidentes_faltantes_parciales_pct: { title: 'Faltantes parciales',  unit: 'pct',   direction: 'lower_is_better'  },
  tasa_armado:                        { title: 'Velocidad de armado',  unit: 'rate',  direction: 'higher_is_better' },
  // Driver KPIs
  pct_tardias_reparto:                { title: '% entregas tardías',   unit: 'pct',   direction: 'lower_is_better'  },
  pct_undelivered:                    { title: '% entregas fallidas',  unit: 'pct',   direction: 'lower_is_better'  },
  entregas_erroneas:                  { title: 'Entregas erróneas',    unit: 'count', direction: 'lower_is_better'  },
};
```

### Layout (2-column grid)
```
Assemblers:
  Faltantes armador    | Incidentes general
  Incidentes calidad   | Incidentes faltantes
  Faltantes completos  | Faltantes parciales
  Velocidad de armado  ← col-span-2 (wide=true)

Drivers:
  % entregas tardías   | % entregas fallidas
  Entregas erróneas    ← col-span-2 (wide=true)
```

### Shared x-axis
`displayWeeks` is computed once per section from ALL KPI rows for that hub (not per chart). All charts in the section show the same last-5-weeks range. Ensures Entregas erróneas and % tardías show the same weeks.

### WowChart rules
- Only entities with a **non-null value in the most recent week** are plotted. Departed assemblers (absent from most recent week) are excluded automatically.
- `connectNulls={true}` bridges gaps for mid-period joiners.
- Tooltip sorts dynamically by hovered week value (highest first).
- `wrapperStyle={{ zIndex: 9999, pointerEvents: 'none' }}` on Tooltip — without this, adjacent chart lines render over the tooltip popup.
- pct values stored as 0–1 fractions → multiplied ×100 (`toDisplay`) before charting. All chart data and y-axis in display units.

### Y-axis Slider
Native `<input type="range">` rotated vertical:
```tsx
style={{
  writingMode: 'vertical-lr',  // NO direction: 'rtl' — that inverts the slider
  width: 18,
  height: chartHeight,
  ...
}}
```
- **Top = 0** (most zoomed in), **Bottom = unitMaxCeil** (most zoomed out)
- `UNIT_MAX_CEIL = { pct: 100, rate: 250, count: 20 }` (in display units)
- Default = `smartYMax` (p75-based auto cap) — resets on hub switch
- `allowDataOverflow={true}` on YAxis — **required** so Recharts respects the domain even when data exceeds the specified max. Without this, zooming in has no visible effect.
- `domain={[0, Math.max(0.1, manualYMax)]}` — 0.1 floor avoids a [0,0] domain

### computeYMax (smart cap)
```ts
function computeYMax(vals: (number | null)[]): number | undefined {
  const nums = vals.filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
  if (nums.length === 0) return undefined;
  const sorted = [...nums].sort((a, b) => a - b);
  // CRITICAL: (n-1)*0.75, NOT n*0.75 — for n=4, n*0.75 gives index 3 = max = outlier
  const p75idx = Math.floor((sorted.length - 1) * 0.75);
  const p75    = sorted[p75idx];
  const raw    = p75 * 1.3;                                      // 30% headroom
  const mag    = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm   = raw / mag;
  const niceMult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return niceMult * mag;
}
```
Filters zeros (zero incidents = no active range to measure). Returns `undefined` if all values are 0 or null → slider falls back to `unitMaxCeil`.

### Hub switch reset (hooks pattern)
```ts
// All hooks MUST come before any early return
const [manualYMax, setManualYMax] = useState<number>(smartYMax ?? unitMaxCeil);
const hubKey = rows.length > 0 ? (rows[0].scope_key ?? '') : '';
useEffect(() => {
  setManualYMax(smartYMax ?? unitMaxCeil);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [hubKey]);

// Early returns AFTER all hooks:
if (rowWeeks.length === 0 || activeEntities.size === 0) return null;
```

---

## 7. lib/kpi-compute.ts — extractIncidentesValues

Generates `peer_comparisons` rows for incident KPIs (faltantes, calidad, etc.).

**Zero-fill for roster:** After processing incident rows, iterates all drivers in `desempeño_repartidores` for that hub/week and inserts `{ numerator: 0, denominator: 1 }` for any driver NOT found in incidents. This ensures drivers with zero incidents appear in the WoW chart — without this, zero-incident drivers look "departed."

```ts
// driverHub map: entity_key → { hub_id, city, originalName }
for (const [, info] of driverHub) {
  if (!byDriver.has(info.originalName)) {
    byDriver.set(info.originalName, {
      entity_type: 'driver', entity_key: info.originalName,
      city: info.city, hub_id: info.hub_id,
      numerator: 0, denominator: 1,
    });
  }
}
```

---

## 8. HubCityKey Resolution

`peer_comparisons.scope_key` for `within_city` rows = a city enum like `'mty'`.  
`hubs.city` = display name like `'Monterrey'`. These don't match as strings.

Resolution waterfall in PorHubTab:
1. Exact string match
2. Cross-reference: find scope_key whose entity_keys overlap most with this hub's `within_hub` entities
3. Accent/case-normalized match
4. Single-hub-city fallback (only one within_city scope_key exists → use it)

---

## 9. Known Footguns

| Issue | Detail |
|---|---|
| `peer_comparisons` has no `hub_id` | SELECT with `hub_id` returns `data: null` silently. Always omit. Use `scope_key`. |
| Recharts domain override | Without `allowDataOverflow={true}` on YAxis, Recharts silently extends the domain to fit data, ignoring your max. Zoom-in appears to do nothing. |
| p75 index formula | `Math.floor((n-1) * 0.75)` not `Math.floor(n * 0.75)`. For n=4: wrong gives index 3 (max), correct gives index 2 (second-highest). |
| `writingMode` on range input | Works in Chrome/Firefox with `writingMode: 'vertical-lr'`. Do NOT add `direction: 'rtl'` — it inverts the slider direction. |
| Rules of Hooks in WowChart | Hooks (`useState`, `useEffect`) must be called before any early `return null`. Pre-compute everything above the hooks, guard after. |
| pct fraction vs display | `peer_comparisons.value` for pct KPIs = 0–1 fraction. Multiply ×100 before charting. `computeYMax` and `manualYMax` are in display units (0–100). |
| `kpi_snapshots.value` pct | Also stored as 0–1 fraction. `formatValue(v, 'pct')` handles the ×100 conversion internally. |

---

## 10. Commits (these sessions)

```
e17bc0a  WoW charts: fix p75 index; dynamic tooltip sort; entregas erróneas zero-fill for roster drivers
4952076  WoW charts: p75 y-axis cap; tooltip z-index fix
82bf8da  WoW charts: remove legend; cap y-axis; fix mid-line endings; consistent x-axis per section
682dbf1  fix: remove hub_id from peer_comparisons SELECT; MNA flip to single $ list; defensive prop defaults
[pending push]  WoW charts: native range slider (writingMode); allowDataOverflow; smart cap default
```

---

## 11. What's Working ✓

- All 7 assembler WoW charts + all 3 driver WoW charts
- Shared x-axis per section (consistent weeks across all charts in a section)
- Departed assemblers/drivers auto-excluded (no value in most recent week)
- Zero-incident drivers appear in Entregas erróneas chart (zero-filled from roster)
- Y-axis slider: full 0–unitMaxCeil range, smart cap default, resets on hub switch
- Tooltip: dark popup, sorts by hovered week value, z-index above adjacent charts
- MNA tile flip: single $ list with % alongside, sorted highest $ first
- Faltantes SKU tile flip: top SKUs by event count per subcategory
- Tile colors: σ-based vs own 4w rolling mean (not vs peers)
- Hub switching: fully client-side, no server round-trip

---

## 12. Environment

```
Workspace:   /Users/adrianrodriguez/Desktop/calii-ops-app
Bash mount:  /sessions/beautiful-friendly-ptolemy/mnt/calii-ops-app/
Deploy:      Netlify (git push triggers deploy)
```
