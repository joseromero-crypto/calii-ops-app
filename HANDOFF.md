# Task Transition — Calii Ops Weekly Dashboard
**Date:** 2026-05-06
**Project:** Calii Ops Weekly Dashboard (Next.js 14 + Supabase, deployed on Netlify)
**Prepared for:** Jose Romero / next session handoff

---

## 0. Rules for the Next Claude Session

### ⚠️ Netlify Credit Strategy — Read This First
Every `git push` triggers a Netlify deploy and burns credits. Deploys are not free. The rule is:

- **Batch changes.** Work on several fixes in one session, commit each separately, push once at the end.
- **Never push to check if something "looks right"** — verify logic in code first.
- **Before writing any code, confirm the request is 100% clear.** If there is any ambiguity — ask. Do not guess. A wrong deploy that requires a correction deploy doubles the cost.

**Real example of what NOT to do:** Jose asked to fix sparkline slopes because "they all look the same." Claude interpreted this as "make them flatter" and set `domain={[0, 1]}`. Jose wanted the opposite — steeper. This caused 2 deploys for 1 change. Ask first.

### Clarification Checklist — Ask Before Coding
When Jose describes a visual or behavioral change, confirm:
1. Is the desired direction clear? ("bigger" / "smaller" / "remove" / "add")
2. Is the comparison basis clear? ("vs other hubs" vs "vs own history" vs "vs last week")
3. If sorting: ascending or descending? Best on top or worst on top?
4. Which tab / which component exactly?

If any of these are ambiguous, ask before touching code.

---

## 1. Project Overview

Internal Next.js 14 App Router dashboard showing weekly KPI snapshots for all Calii hubs (Monterrey, Saltillo, Guadalajara, CDMX).

**Stack:** Next.js 14 App Router · Supabase (PostgREST) · TypeScript · Tailwind CSS · Netlify

**Repo:** `~/Desktop/calii-ops-app`
**Git remote:** GitHub (PAT saved in macOS Keychain — push works from terminal)
**Deploy:** Netlify auto-deploys on push to `main`

**Key Supabase tables:**

| Table | Purpose |
|---|---|
| `kpi_snapshots` | Pre-computed KPI values per week × scope (hub / city / global) |
| `peer_comparisons` | Z-scores and rankings per operator / driver entity |
| `uploads` | Weekly file uploads per app (one row per file) |
| `upload_rows` | Individual CSV rows from each upload, with `is_excluded` flag |
| `kpis` | KPI registry — id, unit, direction, source_app_id, display_order, etc. |
| `hubs` | Hub registry — id, display_name, city |
| `apps` | Upload app registry — id, name_es, scope, expected_files_per_week, group_id |
| `current_week` | Single-row table for active week (currently empty — site falls back to latest kpi_snapshots) |

**Canonical hub slugs:**
`mh_contry`, `mh_cumbres`, `mh_san_nicolas`, `mh_guadalupe`, `mh_avicola` (Saltillo maps here too), `mh_zapopan`, `mh_condesa`, `mh_san_pedro`

**Hub colors (used throughout charts):**
```ts
mh_contry: '#0ea5e9', mh_cumbres: '#22c55e', mh_san_nicolas: '#a855f7',
mh_guadalupe: '#ef4444', mh_avicola: '#f59e0b', mh_zapopan: '#06b6d4',
mh_condesa: '#ec4899'
```

---

## 2. Key Files Map

```
app/(app)/historicos/
  page.tsx              ← Server component: fetches all data, aggregates MNA + faltantes SKUs
  HistoricosClient.tsx  ← Client shell: tab routing
  PorKpiTab.tsx         ← "Por KPI" tab: top movers, line chart, heatmap
  PorHubTab.tsx         ← "Por Hub" tab: KPI tiles with sparklines + tile flips
  ComparativaTab.tsx    ← "Comparativa" tab: multi-hub line charts
  _shared.ts            ← Shared types, formatters, color helpers

app/(app)/upload/
  page.tsx              ← Upload page: dropzone tiles grouped by app group_id

components/
  UploadDropzone.tsx    ← Individual file drop slot
  RecomputeButton.tsx   ← Triggers kpi-compute for one or all weeks

lib/
  kpi-compute.ts        ← Core KPI computation engine (called by /api/recompute)
  sku-classifier.ts     ← classifyMnaProduct(producto, proveedor) → 'fyv'|'carnes'|'abarrotes'
  supabase-server.ts    ← Server-side Supabase client

supabase/migrations/    ← All DB migrations in order
```

---

## 3. Cumulative Work Done (Both Sessions)

### Session 1 (2026-05-05)

**3.1 MNA Hub Resolution Bug Fixed (`lib/kpi-compute.ts`)**
MNA uploads at city level have `hub_id = null`. `extractMnaValues` was skipping all rows because it only looked at `r.upload.hub_id`. Added fallback to read `Hub` / `geofence` / `Geofence` column from row data and run through `hubNameToId()`.

**3.2 RecomputeButton (`components/RecomputeButton.tsx`)**
- Added "Recomputar todo (N sem)" that processes all weeks sequentially, oldest first
- Fixed JSON parse from streaming API response (`res.text()` + `JSON.parse(text.trim())`)

**3.3 UI Fixes**
- `ComparativaTab`: hidden XAxis default number labels
- `PorKpiTab`: chart legend + heatmap rows sort by current week value; custom `ChartTooltip` re-sorts tooltip dynamically per hovered week

---

### Session 2 (2026-05-06)

**3.4 Faltantes Armador — Full Architecture Redesign**

Previous approach computed hub-level % from the raw event log (approximating Retool's formula using assembler×second deduplication). Values were close but rankings were occasionally wrong for hubs within ~1% of each other.

New approach — direct Retool exports:

- **5 upload slots** added to the upload page under "Faltantes Armador" group:
  - `faltantes_armador` — Todos los faltantes (breakdown) — existing, renamed
  - `faltantes_hub_general_pct` — % General — new
  - `faltantes_hub_fyv_pct` — % FyV — new
  - `faltantes_hub_carnes_pct` — % Carnes — new
  - `faltantes_hub_graneles_pct` — % Graneles y Abarrotes — new

- **3 new KPIs** in the database:
  - `faltantes_fyv_pct` (display_order 41, parent: `faltantes_armador_pct`)
  - `faltantes_carnes_pct` (display_order 42)
  - `faltantes_graneles_pct` (display_order 43)

- **Column schema** for all 4 hub % files: `Geofence ID` (ignored) · `Hub` (dimension) · `Ciudad` (dimension) · `Faltante armador (%)` (metric)

- **`extractFaltantesHubPctDirect`** in `lib/kpi-compute.ts` reads `Faltante armador (%)` directly — no formula, exact Retool values

- **Migration file:** `supabase/migrations/20260506000001_faltantes_armador_hub_pct.sql`

**3.5 Faltantes SKU Tile Flips**

The 3 subcategory KPIs (`faltantes_fyv_pct`, `faltantes_carnes_pct`, `faltantes_graneles_pct`) have a tile flip in Por Hub tab showing top SKUs by faltante event count.

- SKU data comes from the breakdown upload (`upload_rows` for `app_id='faltantes_armador'`)
- Category resolved by cross-referencing product name against MNA rows (which carry `Proveedor` for accurate classification). The MNA file has ALL catalogue items even if waste = 0, so cross-reference coverage is very high (tested: 4,926 / 4,927 items resolved via MNA, 1 via keyword fallback)
- **3-minute sliding window deduplication** (implemented in `page.tsx`): same (hub, assembler, SKU) events within 180s of the previous one are counted as 1 incident. Algorithm: group → sort by timestamp → session breaks when gap > 180s. Replaced broken second-level dedup that was undercounting.
- `FaltantesSku` interface in `_shared.ts`

**3.6 Upload Page Grouping**

Added `group_id` / `group_label_es` columns to `apps` table. Apps sharing a `group_id` render as one `GroupedAppTile` card instead of separate cards. Faltantes armador's 5 slots are grouped under "Faltantes Armador". Upload page now fetches `group_id, group_label_es` in the apps query.

**3.7 UI Changes (Historicos)**

| Component | Change |
|---|---|
| `ComparativaTab` | Custom `CompareTooltip`: sorts hubs by value on hover (highest on top) — was alphabetical |
| `PorHubTab` | Tile colors: now WoW vs own 4-week rolling avg using σ threshold (see detail below) |
| `PorHubTab` | Sparkline reference line: now shows `rolling_mean_4w` (was global peer mean) |
| `PorHubTab` | Tile footer: "4w avg: X" (was "Peer: X") with tooltip "Promedio de las últimas 4 semanas" |
| `PorKpiTab` | Removed "Acercamiento por entidad · esta sem." section (operator/driver drill table) entirely |

**Tile Color Logic (current):**
```
Baseline = rolling_mean_4w from kpi_snapshots (stored server-side)
σ = std dev of last 4 prior data points in this hub's trend
Threshold = 0.75σ

Green  → current > baseline + 0.75σ in the "better" direction
Red    → current > baseline + 0.75σ in the "worse" direction
White  → within ±0.75σ (normal noise)

Fallback when σ = 0 or < 3 data points: ±5% relative threshold
```
This replaces the old "vs peer mean ±10%" logic. Each hub is judged against its own history, not against other hubs with different operations.

---

## 4. Git Push Instructions (Full Copy-Paste)

**Standard push — run this in Terminal:**
```bash
cd ~/Desktop/calii-ops-app
rm -f .git/HEAD.lock .git/index.lock
git push origin main
```

**If you need to stage and commit first:**
```bash
cd ~/Desktop/calii-ops-app
rm -f .git/HEAD.lock .git/index.lock
git add <file1> <file2>
git commit -m "description of change"
git push origin main
```

**Check what's pending before pushing:**
```bash
cd ~/Desktop/calii-ops-app
git log --oneline origin/main..HEAD
```

**Note:** The sandbox Claude works in can't push directly (proxy blocks GitHub). Always run git push from your own terminal. The `rm -f` lines clear lock files that the sandbox occasionally leaves — safe to run even if the files don't exist.

---

## 5. Post-Push QA Checklist

After each deploy, verify these on the live site:

### Faltantes SKU dedup (3-min window)
- Por Hub → Contry → flip FyV, Carnes, or Graneles tile — confirm Frijoles Chata (Contry, ~13:18) and Tomate Cidacos (Contry, ~06:45) each appear once with lower count than before the fix

### Comparativa tooltip
- Comparativa tab → hover any week on any KPI chart → hubs should appear highest value on top, lowest on bottom (not alphabetical). Test both a `lower_is_better` KPI and a `higher_is_better` KPI.

### Tile colors (WoW vs 4w avg)
- Por Hub → check several tiles: footer should say "4w avg: X" not "Peer: X"
- Hover the "4w avg" label → tooltip says "Promedio de las últimas 4 semanas"
- Sparkline dotted reference line sits at the 4w avg, not the old peer mean
- A hub with a genuinely good week → green; stable week → white. Small deltas (0.1pp) should not trigger red

### Entity drill removal
- Por KPI → select tasa de armado or faltantes armador → no "Acercamiento por entidad" table between the chart and heatmap. Page should flow cleanly chart → heatmap.

### Sparklines
- Por Hub → KPI tiles should have visible slopes (auto-scale fills height). All tiles should NOT look flat.

---

## 6. Open Items

| Priority | Item |
|---|---|
| 🔴 | After pushing, upload the 4 new Retool hub % files each week (% General, % FyV, % Carnes, % Graneles) alongside the existing breakdown file |
| 🟡 | `current_week` table is empty — site falls back correctly to latest kpi_snapshots, but worth setting explicitly |
| 🟡 | MNA % vs Retool discrepancy is accepted — Retool uses full receiving data, site uses MNA CSV only. Not a bug. |
| 🟢 | New supplier onboarding → update `CARNES_SUPPLIERS` / `FYV_SUPPLIERS` in `lib/sku-classifier.ts` |
| 🟢 | `.env.local` points to wrong Supabase project — verify if local scripts are ever needed |
