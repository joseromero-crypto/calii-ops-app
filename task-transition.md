# Task Transition — Calii Ops Weekly Dashboard
**Date:** 2026-05-05
**Project:** Calii Ops Weekly Dashboard (Next.js 14 + Supabase, deployed on Netlify)
**Prepared for:** Jose Romero / next session handoff

---

## 1. Project Overview

Internal Next.js 14 App Router dashboard connected to Supabase. Displays weekly KPI snapshots for all Calii hubs (Monterrey, Saltillo, Guadalajara, CDMX) on the `/historicos` page: hub tiles, sparklines, peer comparisons, z-scores, and MNA product breakdowns.

**Stack:** Next.js 14 App Router · Supabase (PostgREST) · Netlify · TypeScript

**Key tables:**
- `kpi_snapshots` — pre-computed KPI values per week × scope (hub/city/global)
- `peer_comparisons` — z-scores and rankings per entity
- `uploads` — weekly file uploads per app (mna, desempeno_operadores, etc.)
- `upload_rows` — individual CSV rows, with `is_excluded` flag
- `kpis` — KPI registry (id, unit, direction, source_app_id, etc.)
- `hubs` — hub registry
- `current_week` — single-row table declaring active week (**currently empty** — fallback reads latest from `kpi_snapshots`)

**Hub slugs (canonical):**
`mh_contry`, `mh_cumbres`, `mh_san_nicolas`, `mh_guadalupe`, `mh_avicola` (Saltillo), `mh_zapopan`, `mh_condesa`, `mh_san_pedro`

**Local setup (NEW this session):**
- Repo cloned at `~/Desktop/calii-ops-app`
- `npm install` done — node_modules present
- Git push works with GitHub PAT (saved in macOS Keychain)
- `.env.local` created but points to wrong Supabase project — do not rely on local scripts that query Supabase until credentials are verified
- In future sessions: connect folder via Claude folder picker → instant file access, no copy-paste needed

---

## 2. What Was Done This Session

### 2.1 🔴 Root Cause Fixed — MNA Data Not Displaying

**Symptom:** Por Hub tile fronts showed `—` for all MNA KPIs (`mna_pct`, `mna_carnes_pct`, `mna_fyv_pct`, `mna_graneles_pct`). Tile flips (product breakdown) worked. Comparativa and Por KPI charts showed "Sin datos".

**Root cause:** `extractMnaValues` in `lib/kpi-compute.ts` resolved hub via `r.upload.hub_id` only. MNA uploads uploaded at city level have `hub_id = null` on the uploads row. This caused every MNA row to be skipped (`entityValues.length === 0`) → no snapshot written → all MNA KPIs show blank.

`page.tsx` (tile flip) worked because it has a fallback: `u.hub_id || r.data['Hub'] || r.data['geofence'] || r.data['Geofence']`.

**Fix applied in `lib/kpi-compute.ts` → `extractMnaValues`:**
```ts
// Before (broken):
const hubId = r.upload.hub_id;
if (!producto || !hubId) continue;

// After (fixed):
const rawHubRef =
  r.upload.hub_id ||
  String(r.data['Hub'] ?? r.data['geofence'] ?? r.data['Geofence'] ?? '').trim() ||
  null;
const hubId = rawHubRef ? (hubNameToId(rawHubRef) ?? null) : null;
if (!producto || !hubId) continue;
```

**After fix:** Run Recomputar for all weeks to repopulate `kpi_snapshots`.

---

### 2.2 MNA Number Verification

Manually computed MNA % from raw CSVs (3 hubs, week of 2026-04-30) using the same classifier + monetary formula. Results matched the site within rounding (1 decimal). Formula confirmed correct.

**Known discrepancy vs Retool:** Retool uses additional denominator data not available in the MNA CSV (full receiving/orders data). Site formula was intentionally adjusted to measure internal improvement trends. This discrepancy is accepted and not a bug.

| Hub | Total MNA | FyV | Carnes | Graneles |
|---|---|---|---|---|
| MH Guadalupe | 3.99% | 5.31% | 4.26% | 2.09% |
| MH Cumbres | 4.95% | 5.77% | 4.34% | 4.48% |
| MH Contry | 4.35% | 5.66% | 4.21% | 2.65% |

---

### 2.3 RecomputeButton Improvements (`components/RecomputeButton.tsx`)

Two improvements:
1. **"Recomputar todo (N sem)" button** — processes all weeks with uploads sequentially, oldest first. Shows live progress `Semana X / N`. Always shows "Listo" at the end regardless of stream errors.
2. **JSON parse fix** — API streams keepalive `\n` chars before the final JSON. Changed from `res.json()` to `res.text()` + `JSON.parse(text.trim())` with a graceful fallback when the stream closes early.

Weeks list is capped at 26 (half a year) in `upload/page.tsx`. The button count updates automatically each week.

---

### 2.4 UI Fixes

| File | Fix |
|---|---|
| `ComparativaTab.tsx` | Added `<XAxis dataKey="week" hide />` — chart was showing 0,1,2,3,4 as X-axis labels instead of hiding them |
| `PorKpiTab.tsx` | Chart legend + heatmap rows now sort by current week value (highest first). Custom `ChartTooltip` component re-sorts tooltip entries by each hovered week's values, so order changes dynamically as you scrub across weeks |

---

## 3. Files Changed This Session

| File | Change |
|---|---|
| `lib/kpi-compute.ts` | Hub resolution fallback in `extractMnaValues` |
| `components/RecomputeButton.tsx` | "Recomputar todo" button + JSON parse fix |
| `app/(app)/upload/page.tsx` | Pass `allWeeks` prop to `RecomputeButton` |
| `app/(app)/historicos/ComparativaTab.tsx` | Hide XAxis default indices |
| `app/(app)/historicos/PorKpiTab.tsx` | Sorted legend + custom per-week tooltip |
| `scripts/verify-mna.ts` | Verification script (local use only, not deployed) |

---

## 4. Next Task — Faltantes Armador Calculation Review

**Goal:** Verify that `faltantes_armador_pct` is being computed correctly, both at the hub-level snapshot and at the operator peer-comparison level.

**Relevant architecture (from `lib/kpi-compute.ts`):**

This KPI uses a split approach — two different data sources for snapshots vs peers:

- **Hub-level snapshots** (`computeFaltantesArmadorPct`):
  - Numerator: count of faltante events from `faltantes_armador` event log (keyed by `Hub` column → `hubNameToId`)
  - Denominator: total `num_assembled` across all operators for that hub (from `desempeno_operadores`, keyed by `geofence` column)

- **Operator-level peers** (`computeFaltantesArmadorPeerValues`):
  - Numerator: `num_orders_with_faltante_armador` per assembler row (from `desempeno_operadores`)
  - Denominator: `num_assembled` per assembler row
  - Operators with `num_assembled = 0` are skipped

**Potential issues to investigate:**
1. Does the `faltantes_armador` upload exist and is it validated? What is its `app_id`?
2. Does the `Hub` column in the faltantes event log match `hubNameToId` aliases?
3. Are hub-level values matching what ops expects, or are they systematically off?
4. Are operator-level peer values showing in the tile flip correctly?

**How to start:** Ask Jose to share a sample faltantes_armador CSV to inspect column names and a few rows, then compare computed values against known-good Retool numbers for the same week.

---

## 5. Open Items (Not This Session)

| Priority | Item |
|---|---|
| 🟡 | MNA % vs Retool discrepancy — accepted for now, root cause is exceptions-only CSV denominator |
| 🟡 | `current_week` table is empty — site falls back to latest kpi_snapshots correctly, but worth setting |
| 🟢 | New supplier onboarding — update `CARNES_SUPPLIERS` / `FYV_SUPPLIERS` in `lib/sku-classifier.ts` when new suppliers are added |
| 🟢 | `.env.local` points to wrong Supabase project — verify credentials if local scripts are needed |
