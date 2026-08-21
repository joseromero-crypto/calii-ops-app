# Implementation Plan — "Resumen operativo" tab (session 12)

**Feature:** new `/historicos` tab fed by the Retool hub-level weekly summary export.
**Prepared for:** Jose Romero — build instructions, not a spec discussion.
**Companion docs:** `HANDOFF.md` (§4a navigation, §9 compute, §12 footguns, §14 targets), `CONFIGURABLE_KPI_TARGETS.md`.

---

## 0. Decisions locked this session

| Question | Decision |
|---|---|
| Where does it live | 4th tab in `/historicos` — `📦 Resumen` |
| Upload scope | `per_city`, 4 files/week (Monterrey / Saltillo / Guadalajara / CDMX) |
| Overlapping columns | Existing KPIs stay authoritative. Overlap columns are **ingested but not registered as KPIs**. |
| Timestamp columns | `role = 'ignored'` — stored, nothing built on them |
| Focus | Orders + AOV, plus new reads that weren't possible before |
| View levels | **Total → 4 ciudades → 7 hubs**, expandable tree |
| Total row semantics | **True sum**, computed client-side — not the DB's mean-of-hubs global (§4a) |
| Por KPI tab | New KPIs **included** in selector + heatmap; excluded from top movers only (§5) |
| Rollout | Filter-only commit pushed first, then migrate, then test on localhost (**§9a — read before running anything**) |

Scope of the data: 4 city files per week covering 7 hubs — Monterrey (Contry, Cumbres, San Nicolás, Guadalupe), Saltillo (Avícola), Guadalajara (Zapopan), CDMX (Condesa). `MH San Pedro` and `CH Guadalupe general` appear in the Monterrey file but are excluded (§7).

The sample file (`table-data - 2026-07-31T123714.150.csv`) is the **Monterrey** export: MH Contry, MH San Pedro, CH Guadalupe general, MH Guadalupe, MH Cumbres, MH San Nicolás. That confirms the per-city split — the other three cities will each be a 1–2 row file.

---

## 1. Read this first — what the sample data actually says

I ran the column algebra across all four live hubs before designing the KPIs. Three findings change the design.

### Finding 1 — `Entregas fallidas (%)` **is** `Pendiente armado (#) ÷ Pedidos (#)`

Exact to 16 decimal places, all four hubs:

| Hub | Pendiente armado | Pedidos | ratio | `Entregas fallidas (%)` |
|---|---|---|---|---|
| MH Contry | 19 | 923 | 0.020585048754062838 | 0.020585048754062838 |
| MH Guadalupe | 22 | 613 | 0.03588907014681892 | 0.03588907014681892 |
| MH Cumbres | 21 | 806 | 0.026054590570719603 | 0.026054590570719603 |
| MH San Nicolás | 12 | 641 | 0.0187207488299532 | 0.0187207488299532 |

Not a coincidence. The column labelled `Pendiente armado (#)` is the **count of orders that were never delivered**, and `Entregas fallidas (%)` is that count over total orders. Two labels, one number.

Consequence: a `pct_pendiente_armado` KPI would be a byte-identical duplicate of a column that *already* overlaps `pct_undelivered`. **Cut from the catalog.** See §9 Q2 — worth asking Retool which label is the wrong one.

### Finding 2 — the two "retrasos" columns use a different denominator than everything else

`Retrasos armado (%)` and `Retrasos entrega (%)` divide by **delivered orders** (`Pedidos − Pendiente armado`), not by `Pedidos`. Recovered numerators are exact integers only with that denominator:

| Hub | `Retrasos entrega (%)` × (Pedidos − Pend. armado) | × Pedidos |
|---|---|---|
| MH Contry | 11.000000 ✓ | 11.231195 ✗ |
| MH Guadalupe | 3.000000 ✓ | 3.111675 ✗ |
| MH Cumbres | 2.000000 ✓ | 2.053503 ✗ |

Every other `%` column (faltantes armador, incidentes clientes, mala calidad, faltantes cliente, entregas fallidas) divides by `Pedidos` and recovers clean integers. Matters the moment anyone reconciles these against our computed KPIs — don't assume a shared denominator.

It also means `Pedidos − Pendiente armado` is a real, meaningful field: **delivered orders**. Registered below as `pedidos_entregados`.

### Finding 3 — `Pendiente entrega (#)` is 0 for every hub

All four live hubs, plus both dead rows. Either it's a mid-week snapshot field that's always empty in a Friday export, or it's not populated at all. **No KPI** — you can't validate one against a column that's constant zero. Ingest it; revisit after 3–4 weeks of files.

---

## 2. Column mapping

App id: **`resumen_operativo`**. All 20 CSV columns get an `app_columns` row (`coerceRows` drops anything not listed — HANDOFF §12).

| # | CSV header | type | role | required | Feeds |
|---|---|---|---|---|---|
| 0 | `Hub` | string | dimension | **true** | hub resolution |
| 1 | `Pedidos (#)` | int | metric | false | `pedidos_hub`, `ingresos_hub`, denominators |
| 2 | `Pendiente entrega (#)` | int | metric | false | — (Finding 3: always 0) |
| 3 | `Armadores (#)` | int | metric | false | `armadores_activos`, rate weighting |
| 4 | `Pedidos con faltantes armador (%)` | float | metric | false | — (overlap: `faltantes_armador_pct`) |
| 5 | `Retrasos armado (%)` | float | metric | false | — (overlap: `pct_armado_tardio`) |
| 6 | `Nro. de pedidos / armador / día` | float | metric | false | `pedidos_por_armador_dia` |
| 7 | `Comienzo armado` | datetime | **ignored** | false | — |
| 8 | `Finalización armado` | datetime | **ignored** | false | — |
| 9 | `Pendiente armado (#)` | int | metric | false | `pedidos_entregados` (subtrahend) |
| 10 | `Repartidores (#)` | int | metric | false | `repartidores_activos`, rate weighting |
| 11 | `Retrasos entrega (%)` | float | metric | false | — (overlap: `pct_tardias_reparto`) |
| 12 | `Nro. de entregas / repartidor / día` | float | metric | false | `entregas_por_repartidor_dia` |
| 13 | `Comienzo entregas` | datetime | **ignored** | false | — |
| 14 | `Finalización entregas` | datetime | **ignored** | false | — |
| 15 | `Pedidos con incidentes clientes (%)` | float | metric | false | — (overlap: `incidentes_manuales_pct`) |
| 16 | `Pedidos con mala calidad (%)` | float | metric | false | — (overlap: `incidentes_calidad_pct`) |
| 17 | `Pedidos con faltantes cliente (%)` | float | metric | false | — (overlap: `incidentes_faltantes_pct`) |
| 18 | `AOV` | float | metric | false | `aov_mxn`, `ingresos_hub` |
| 19 | `Entregas fallidas (%)` | float | metric | false | — (overlap: `pct_undelivered`; = col 9 ÷ col 1) |

### Why `required: false` on every metric — do not skip this

`MH San Pedro` and `CH Guadalupe general` come through as `0,0,0,,,,,,0,0,,,,,,,,,NaN`.

- `lib/parse.ts::coerce` maps `''`, `'NaN'`, `'null'`, `'Infinity'` → `null`. Fine.
- `lib/validate.ts:60`: `expectedNonNull = col.required && (int|float|bool|datetime)`. A `NaN` cell in a **required** float column raises `type_mismatch`, and >5% of them **hard-fails the whole upload**.

Empty cells (`''`) are skipped by the validator's `raw === ''` guard, but the literal string `NaN` is not. Mark every metric `required: false`; only `Hub` stays required.

Overlap columns keep `role = 'metric'` (not `ignored`) so a future reconciliation view — Retool's rollup vs. our entity-derived computation — costs no re-upload. Nothing reads them today.

---

## 3. New KPI catalog

Eight rows in `kpis`, all with `category = 'operacion'` — that's the routing key for the new tab (§5). `category` is plain `text`, no enum change needed.

| id | name_es | unit | direction | numerator | denominator | rolls up as | order |
|---|---|---|---|---|---|---|---|
| `pedidos_hub` | Pedidos (#) | `count` | higher_is_better | Pedidos | 1 | **sum** | 1 |
| `pedidos_entregados` | Pedidos entregados (#) | `count` | higher_is_better | Pedidos − Pend. armado | 1 | **sum** | 2 |
| `aov_mxn` | AOV | `currency_avg` | higher_is_better | AOV × Pedidos | Pedidos | **wtd avg** (by orders) | 3 |
| `ingresos_hub` | Ingresos estimados | `currency` | higher_is_better | AOV × Pedidos | 1 | **sum** | 4 |
| `pedidos_por_armador_dia` | Pedidos / armador / día | `rate` | higher_is_better | valor × Armadores | Armadores | **wtd avg** (by armadores) | 5 |
| `entregas_por_repartidor_dia` | Entregas / repartidor / día | `rate` | higher_is_better | valor × Repartidores | Repartidores | **wtd avg** (by repartidores) | 6 |
| `armadores_activos` | Armadores (#) | `count` | higher_is_better | Armadores | 1 | **sum** | 7 |
| `repartidores_activos` | Repartidores (#) | `count` | higher_is_better | Repartidores | 1 | **sum** | 8 |

`source_app_id = 'resumen_operativo'`, `parent_kpi_id = null`, `watched_globally = false`, `weight = 3` (the `kpis_weight_check` constraint requires 1–5 — HANDOFF §12), `active = true` for all eight.

**Cut:** `pct_pendiente_armado` (Finding 1 — duplicate), `pct_pendiente_entrega` (Finding 3 — constant zero).

### The genuinely new reads

1. **`ingresos_hub` (Pedidos × AOV)** — the dashboard has no scale or revenue metric today, so every quality KPI is unweighted: 10% MNA at Contry (923 orders, ~$1.08M) and 10% MNA at a small hub read identically. This is the denominator that makes hub comparison honest, and the prerequisite for any peso-denominated KPI later.
2. **`pedidos_por_armador_dia`** — complements `tasa_armado` (SKUs/hr, a *speed* metric) with throughput-per-head. Contry 6.28 vs Cumbres 8.22 on 21 vs 14 assemblers is a staffing signal `tasa_armado` alone doesn't surface.
3. **`aov_mxn`** — no basket-size metric exists anywhere in the app today. Range across Monterrey is $1,021–$1,171; a hub drifting down while orders hold flat is a mix problem nothing currently catches.
4. **`pedidos_entregados`** — falls out of Finding 2 for free and is the honest volume number (2,909 of 2,983 in Monterrey).

### Directions worth a second look before you seed

`pedidos_hub`, `pedidos_entregados`, `armadores_activos` and `repartidores_activos` are **demand/staffing facts, not performance**. `higher_is_better` is a convenience so σ-vs-own-baseline tile colouring reads sensibly (volume up = green), but don't configure `kpi_targets` rows for them — a "meta" on order count is meaningless.

---

## 4. Aggregation correctness — read before writing the extractor

`aggregateAllScopes` (kpi-compute.ts:663) sums `numerator` and `denominator` across entity values at hub, city and global scope, then calls `ratio()`. With one row per hub the hub scope is trivially right; **city and global are where naive numerator/denominator choices break.**

### AOV needs a new unit — `currency_avg`

AOV is an *average*, not a *total*. Both existing units give a wrong answer:

- `unit = 'currency'` → `ratio()` returns the numerator and city scope **sums hub AOVs**: Monterrey would display **$4,350** as its AOV instead of $1,096.
- `unit = 'rate'` → math correct, but `formatValue` renders `1096.2` instead of `$1,096`.

Add `'currency_avg'` to the `kpi_unit` enum and thread it through four places:

```sql
ALTER TYPE kpi_unit ADD VALUE IF NOT EXISTS 'currency_avg';
```

> Postgres will not let `ALTER TYPE ... ADD VALUE` run in the same transaction as a statement that uses the new value. Own migration file, before the seed migration.

| File | Change |
|---|---|
| `lib/kpi-compute.ts::ratio` (769) | `currency_avg` falls through to the `num/den` branch — must **not** join the `'count' \|\| 'currency'` early return |
| `lib/kpi-compute.ts::aggregateAllScopes` (736) | Nothing. The global branch tests `=== 'currency' \|\| === 'count'`; `currency_avg` lands in the weighted `else`, which is what we want |
| `historicos/_shared.ts::formatValue` (165) | `if (unit === 'currency_avg')` → same `$` formatting as `currency` |
| `PorHubTab.tsx::UNIT_MAX_CEIL` | add `currency_avg: 5_000` |
| `historicos/_shared.ts::toDisplayUnits` (131) | Nothing — only `pct` converts. Verify by reading, don't assume |

With `numerator = AOV × Pedidos` and `denominator = Pedidos`: hub = AOV exactly, city = Σingresos/Σpedidos (order-weighted), global = same. Correct at every scope, zero special-casing.

### Rate KPIs must be headcount-weighted

Do **not** store `numerator = 6.28, denominator = 1` for `pedidos_por_armador_dia`. City scope would sum the per-hub rates: **27.3** "pedidos por armador" for Monterrey instead of 6.76. Store `numerator = rate × Armadores`, `denominator = Armadores` — hub scope recovers the rate exactly, city and global become headcount-weighted averages.

---

## 4a. Where each of the three view levels gets its number

### The rule, in plain terms

Rolling a hub up to a city, and cities up to a Total, follows one of two rules depending on the KPI:

| Rule | KPIs | Monterrey example |
|---|---|---|
| **Sum** | Pedidos, Pedidos entregados, Ingresos, Armadores, Repartidores | 923 + 806 + 613 + 641 = **2,983 pedidos** |
| **Weighted average** | AOV, Pedidos/armador/día, Entregas/repartidor/día | $3,269,860 ÷ 2,983 = **$1,096 AOV** |

Never an unweighted average of the hub values. Monterrey's AOV is *not* (1171 + 1097 + 1061 + 1021) ÷ 4 = $1,088 — Contry's 923 orders have to count for more than San Nicolás's 641. The weights:

- **AOV** → weighted by orders. `Σ(AOV × pedidos) ÷ Σpedidos` = total revenue ÷ total orders.
- **Pedidos / armador / día** → weighted by **headcount**, not orders. `Σ(rate × armadores) ÷ Σarmadores` = 6.76 for Monterrey. A 21-assembler hub pulls the average harder than a 14-assembler one.
- **Entregas / repartidor / día** → same, weighted by repartidores. 9.91 for Monterrey.

**The rule that covers every weighted case: weight by whatever is on the bottom of the metric.** AOV is pesos *per order* → weight by orders. Pedidos/armador/día is orders *per assembler* → weight by assemblers. That's why the two rates weight by headcount and not by volume.

#### Worked example — why unweighted is wrong for AOV

Two hubs, very different sizes:

| | Orders | AOV | Revenue |
|---|---|---|---|
| Hub A | 100 | $1,300 | $130,000 |
| Hub B | 10 | $1,000 | $10,000 |
| **Combined** | **110** | **$1,272.73** | **$140,000** |

Weighted: `$140,000 ÷ 110 = $1,272.73`. Unweighted: `($1,300 + $1,000) ÷ 2 = $1,150`. An 11% error — Hub B carries a tenth of the orders but half the vote.

In the real 2026-07-24 Monterrey week the gap is only $8.70 ($1,096.17 weighted vs $1,087.47 unweighted) because the four hubs are similar sizes. **Do not take that as evidence it doesn't matter** — it grows at Total scope, where Saltillo/GDL/CDMX are single hubs of very different volume from the Monterrey four.

#### Worked example — why the rates weight by headcount

Same shape, different denominator:

| | Armadores | Pedidos/armador/día | Orders/day |
|---|---|---|---|
| Hub A | 21 | 6.3 | 132.3 |
| Hub B | 2 | 12.0 | 24.0 |
| **Combined** | **23** | **6.80** | **156.3** |

Weighted: `156.3 ÷ 23 = 6.80`. Unweighted: `(6.3 + 12.0) ÷ 2 = 9.15` — implying Monterrey assemblers are far more productive than nearly all of them actually are, on the strength of two people.

Real Monterrey week: 426.1 orders/day ÷ 63 armadores = **6.764** weighted, vs 6.825 unweighted. Note the weighted figure is *lower* here — Cumbres is the fast hub (8.22) but has only 14 assemblers, so correct weighting pulls it down.

§4's numerator/denominator choices exist precisely so `aggregateAllScopes` produces these two rules automatically at every scope. Get the numerator wrong and the city row silently becomes a sum of averages (27.3 pedidos/armador — see §4 "Rate KPIs must be headcount-weighted").

### Why the Total row still needs a client-side override

**Hub and city rows come straight from the DB and are already correct. The Total row is not — for the five `sum` KPIs.**

`aggregateAllScopes` writes `scope_level = 'global'` as the **mean of hub totals** for `count` and `currency` KPIs (kpi-compute.ts:736). That's deliberate and correct for the Por KPI trend line — a global *sum* of order counts would be 7× any hub line and make the reference line useless (HANDOFF §9). But it means the DB's global row for `pedidos_hub` is ~426, not 2,983+. Rendering that under a heading called "Total" would be wrong.

| KPI | unit | Hub row | City row | **Total row** |
|---|---|---|---|---|
| `pedidos_hub` | count | DB `hub` | DB `city` ✓ sum | ⚠️ **sum the 7 hub rows client-side** |
| `pedidos_entregados` | count | DB `hub` | DB `city` ✓ sum | ⚠️ **sum client-side** |
| `ingresos_hub` | currency | DB `hub` | DB `city` ✓ sum | ⚠️ **sum client-side** |
| `armadores_activos` | count | DB `hub` | DB `city` ✓ sum | ⚠️ **sum client-side** |
| `repartidores_activos` | count | DB `hub` | DB `city` ✓ sum | ⚠️ **sum client-side** |
| `aov_mxn` | currency_avg | DB `hub` | DB `city` ✓ weighted | DB `global` ✓ weighted |
| `pedidos_por_armador_dia` | rate | DB `hub` | DB `city` ✓ weighted | DB `global` ✓ weighted |
| `entregas_por_repartidor_dia` | rate | DB `hub` | DB `city` ✓ weighted | DB `global` ✓ weighted |

Client-side override, not a compute change. This is the **same pattern `PorKpiTab.allChartData` already uses** to override `__global__` for count/currency (HANDOFF §9) — it fixes every historical week without a recompute, and it leaves the Por KPI reference line untouched.

```ts
// ResumenTab — Total row value for one KPI in one week
function totalValue(kpi: Kpi, hubSnaps: Snapshot[], globalSnap?: Snapshot): number | null {
  if (kpi.unit === 'count' || kpi.unit === 'currency') {
    const vals = hubSnaps.map(s => s.value).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  }
  return globalSnap?.value ?? null;   // currency_avg / rate — DB is already weighted
}
```

Do **not** sum the four city rows instead of the seven hub rows. Identical for `count`/`currency`, but a hub whose `city` is null (see the San Pedro footgun in §7) lands in a hub row and no city row — summing hubs is the safer of the two.

⚠️ **The Total row now means something different here than "media global" does in Por KPI, for the same KPI id.** That's the deliberate trade accepted this session. Label it `Total` in Resumen and leave Por KPI's label as `Media global` — never let the two strings converge.

---

## 5. Routing the new KPIs to the new tab

**The step that breaks things if you skip it.** Five components map over the full `kpis` array with no filter, so all eight new KPIs appear in places you didn't intend the moment the migration lands:

| File | Line | Without a filter |
|---|---|---|
| `PorHubTab.tsx` | 138–139 | 8 new tiles in the Por Hub grid (only `REPORT_ONLY_KPI_IDS` is filtered) |
| `PorKpiTab.tsx` | 335 | 8 new entries in the KPI selector + heatmap — **wanted, leave unfiltered** |
| `PorKpiTab.tsx` | 74–88 | **Top movers gets hijacked.** Non-pct movers rank by *relative* change; volume and headcount KPIs swing far harder week-to-week than any quality pct and will own the top-5 strip permanently |
| `ComparativaTab.tsx` | 70 | 8 new rows in the hub-vs-hub grid |
| `GenerarReporte.tsx` | 140 | 8 new lines in `kpiSummary` → sent to Claude → they appear in the coordinator's Slack report |

Add one predicate to `historicos/_shared.ts` and use it everywhere — single source of truth, same lesson as `lib/hub-aliases.ts` (HANDOFF §12):

```ts
/** KPIs sourced from the hub-level Retool summary — rendered in the Resumen tab only. */
export const RESUMEN_CATEGORY = 'operacion';
export const isResumenKpi = (k: { category: string }) => k.category === RESUMEN_CATEGORY;
```

- `PorHubTab` tiles → `.filter(k => !REPORT_ONLY_KPI_IDS.has(k.id) && !isResumenKpi(k))`
- `PorKpiTab` selector + heatmap → **include** (decided). The 8 new KPIs get a per-hub trend line and a heatmap row like any other KPI — one line per hub plus the dashed global mean, no extra work.
- `PorKpiTab` top movers → **exclude**. This is the one place inside `PorKpiTab` that filters, so the exclusion is per-block, not per-component: apply `isResumenKpi` inside the `topMovers` useMemo (line 74–88) only, and leave the selector/heatmap arrays alone.
  The global mean line on those charts stays the DB's mean-of-hubs — correct in this tab, since it exists to be comparable to the hub lines. That's the same number the Resumen tab deliberately overrides with a sum (§4a). Both are right in their own context.
- `ComparativaTab` → exclude (the Resumen tab is the hub-vs-hub view for these).
- `GenerarReporte::buildBundle` → exclude by default. Adding volume context to the coordinator report is a separate, deliberate change with its own prompt work — don't let it happen by accident.

---

## 6. Build steps

### Step 1 — `supabase/migrations/20260731000001_kpi_unit_currency_avg.sql`

```sql
ALTER TYPE kpi_unit ADD VALUE IF NOT EXISTS 'currency_avg';
```

Own file. Nothing else in it.

### Step 2 — `supabase/migrations/20260731000002_resumen_operativo.sql`

1. `INSERT INTO apps` — `('resumen_operativo', 'Resumen operativo semanal', 'per_city', 4, 'Rollup hub-level semanal exportado de Retool')`.
   ⚠️ Production `apps` has `group_id` / `group_label_es` columns that **exist in no local migration file** (`app/(app)/upload/page.tsx:49` selects them). The migrations folder has drifted from production. Use an explicit column list and decide whether this app joins an existing upload-page group.
2. `INSERT INTO app_columns` — all 20 rows from §2, positions 0–19, exact header strings including accents and the spaces in `Nro. de pedidos / armador / día`.
3. `INSERT INTO kpis` — the eight rows from §3, `category = 'operacion'`.

Model the file on `20260506000001_faltantes_armador_hub_pct.sql` — closest precedent (hub-level Retool export → direct-read KPIs).

### Step 3 — `lib/kpi-compute.ts`

Add a KPI-id set and an extractor mirroring `extractFaltantesHubPctDirect` (line 594):

```ts
const RESUMEN_KPI_IDS = new Set([
  'pedidos_hub', 'pedidos_entregados', 'aov_mxn', 'ingresos_hub',
  'pedidos_por_armador_dia', 'entregas_por_repartidor_dia',
  'armadores_activos', 'repartidores_activos',
]);

/** [numerator, denominator] per KPI — see §4 for why the weights are what they are. */
const RESUMEN_FIELDS: Record<string, (d: Record<string, unknown>) => [number, number]> = {
  pedidos_hub:                 d => [toNum(d['Pedidos (#)']), 1],
  pedidos_entregados:          d => [toNum(d['Pedidos (#)']) - toNum(d['Pendiente armado (#)']), 1],
  aov_mxn:                     d => [toNum(d['AOV']) * toNum(d['Pedidos (#)']), toNum(d['Pedidos (#)'])],
  ingresos_hub:                d => [toNum(d['AOV']) * toNum(d['Pedidos (#)']), 1],
  pedidos_por_armador_dia:     d => [toNum(d['Nro. de pedidos / armador / día']) * toNum(d['Armadores (#)']), toNum(d['Armadores (#)'])],
  entregas_por_repartidor_dia: d => [toNum(d['Nro. de entregas / repartidor / día']) * toNum(d['Repartidores (#)']), toNum(d['Repartidores (#)'])],
  armadores_activos:           d => [toNum(d['Armadores (#)']), 1],
  repartidores_activos:        d => [toNum(d['Repartidores (#)']), 1],
};
```

Extractor contract:

- `entity_type: 'hub'`, `entity_key: hubId`, `hub_id: hubId`, `city: hubCity.get(hubId) ?? null` — identical to `extractFaltantesHubPctDirect`.
- Resolve via `hubNameToId(String(d['Hub'] ?? '').trim())`; `null` → `continue`. Drops `CH Guadalupe general` automatically (`ch_*` returns null — HANDOFF §8). Note the trailing space in `"MH Contry "` — `resolveHubId` trims, but keep the `.trim()`.
- **Skip zero-volume hubs:** `if (!Number.isFinite(pedidos) || pedidos <= 0) continue;`. Keeps San Pedro's all-zero/NaN row out of every scope. Without it, `ingresos_hub` for Monterrey gains a phantom $0 hub and the weighted KPIs get a 0/0.
- Skip a KPI when its denominator is 0 (`Armadores (#) = 0` → the rate is undefined, not zero).
- `toNum` (line 941) coerces null → 0; still guard `Number.isFinite` on the result.

Wire into `computeEntityValues` (line 202) **above** the `switch`, beside the existing `FALTANTES_HUB_PCT_KPI_IDS` branch:

```ts
if (RESUMEN_KPI_IDS.has(kpi.id)) {
  return extractResumenOperativoValues(kpi, rowsByApp, hubCity);
}
```

`computePeersForKpi` (line 847) **already handles `entity_type === 'hub'`** — it emits `within_city` and `global` peer rows with z-scores and ranks. Hub-vs-hub ranking comes free; no change needed, and no need for a `FALTANTES_SKU_KPI_IDS`-style skip at line 147 unless you want to suppress it.

### Step 4 — `app/(app)/historicos/page.tsx`

Likely **zero changes**. The snapshot query (53–57) filters `scope_level in ('hub','city','global')` with no KPI filter, and `kpis` is fetched with `active = true` only. Verify by reading.

### Step 5 — `ResumenTab.tsx`

New file beside the other tabs, same `Props` shape as `ComparativaTab` (`kpis, hubs, snapshots, peers, currentWeek, targets`).

**Shape: rows = scope, columns = KPI.** 8 KPI columns; 12 possible rows in an expandable tree.

```
▾ Total                    2,983…   2,909…   $1,096   $3.27M…   6.76   9.91   63…   43…
  ▾ Monterrey              2,983    2,909    $1,096   $3.27M    6.76   9.91   63    43
      MH Contry              923      904    $1,171   $1.08M    6.28  10.14   21    12
      MH Cumbres             806      785    $1,097    $884K    8.22   9.60    14    14
      MH Guadalupe           613      591    $1,061    $650K    6.26   8.76    14    10
      MH San Nicolás         641      629    $1,021    $654K    6.54  11.45    14     8
  ▸ Saltillo                 …
  ▸ Guadalajara              …
  ▸ CDMX                     …
```

Implementation notes:

- `const resumenKpis = useMemo(() => kpis.filter(isResumenKpi), [kpis])`
- Build the tree from `hubs` (already a prop, carries `city`), not from a hardcoded city list. `groupBy(hubs, h => h.city)` — `_shared.ts:207` already exports `groupBy`.
- Row values: hub and city rows read `snapshots` filtered by `scope_level`/`scope_key`; the Total row uses `totalValue()` from §4a. **Read §4a before writing this** — five of the eight KPIs must not read the DB global row.
- Expansion state: plain `useState<Set<string>>` of expanded city keys. Cities collapsed by default, Total always expanded. **Derived-state pattern if you ever reset it on week/hub change** — never `useEffect` (HANDOFF §12).
- WoW deltas: compute from the chronological snapshot array, **not** `snap.prev_week_value` — only populated for recent weeks (HANDOFF §7/§12). Same for `rolling_mean_4w`. The Total row's previous-week value has to be summed the same way as the current one; don't take a shortcut and read the DB global's `prev_week_value`.
- Reuse `formatValue`, `formatDelta`, `deltaClassForDirection`, `HUB_COLORS`. `formatValue` needs the `currency_avg` case from §4 or AOV renders unformatted.
- Indentation should be structural (nested `<tr>` groups or a `depth` prop driving `pl-*`), not manual spaces — 8 columns × 12 rows already needs `overflow-x-auto` on mobile, same as the tab bar (HANDOFF §7).
- Sticky first column (`sticky left-0 bg-white z-10`) so hub names stay visible while scrolling the 8 KPI columns horizontally.
- **Upload completeness indicator.** With 4 files feeding one Total, a missing city silently understates it. Derive `citiesPresent` = distinct `scope_level='city'` scope_keys for `currentWeek`; if `< 4`, show a banner on the Total row: `⚠️ 3 de 4 ciudades cargadas — el total está incompleto`. Cheap, and it prevents the whole class of "why did orders drop 25%" questions.
- If you add a chart, a `pedidos_hub` + `aov_mxn` dual-axis trend at the selected scope is the highest-value one. Recharts needs `allowDataOverflow={true}` on any YAxis you plan to zoom (HANDOFF §12).
- Targets: `resolveTarget(kpi.id, hubId, targets)` works on hub rows. City and Total rows have no `scope_key` in `kpi_targets` (the table is `global | hub` only — HANDOFF §14), so a target on those rows resolves to the global row. Fine for the two rate KPIs; just don't imply a per-city meta exists.

### Step 6 — `HistoricosClient.tsx`

Widen the tab union in **four** places — it's written out literally each time:

- line 22 `tab:` prop type
- line 36 `useState<...>`
- line 41 `syncUrl(tab: ...)`
- line 49 `switchTab = (t: ...)`

`'kpi' | 'hub' | 'cmp'` → `'kpi' | 'hub' | 'cmp' | 'res'`. Add `<Tab onClick={() => switchTab('res')}>📦 Resumen</Tab>` and `{activeTab === 'res' && <ResumenTab {...props} />}`.

Then `page.tsx:446` — the cast is `searchParams.tab as 'kpi' | 'hub' | 'cmp' | undefined`. Add `'res'` or `?tab=res` silently falls back to the KPI tab on a direct link or refresh.

⚠️ `syncUrl` uses `window.history.pushState`. **Never** `router.push` here — it re-runs `page.tsx` and all six Supabase batches (HANDOFF §4a, 4–5 second freeze).

### Step 7 — targets & config

Mostly free. `/config` → "Metas / Targets" reads every row in `kpis` (`config/page.tsx:11`, no filter), so the new KPIs get target inputs automatically and `resolveTarget`/`meetsTarget` work unchanged.

Two things to verify:

- `KpiTargetsSection` renders a unit suffix (`%`, `$`) at line 49 — add a `currency_avg` case or the AOV input shows no suffix.
- The comparator is derived from `lib/kpi-direction.ts::effectiveDirection` (HANDOFF §14). Confirm it passes the DB direction through for ids it's never seen.

Sensible first targets: `pedidos_por_armador_dia ≥ 7`, `entregas_por_repartidor_dia ≥ 10`. Leave AOV and the volume KPIs blank — absence of a row is how "no target" is expressed (HANDOFF §14), never `target_value: null`.

---

## 7. Footguns specific to this work

| Issue | Detail |
|---|---|
| `NaN` in required numeric columns | `coerce` returns null; `validate.ts` counts it as a type mismatch **only for `required` columns**, and >5% hard-fails the upload. `MH San Pedro` ships `NaN` in `Entregas fallidas (%)`. Mark every metric `required: false`. |
| `MH San Pedro` is not in the `hubs` table | It's in `HUB_ALIAS_MAP` (`lib/hub-aliases.ts:51`) but **not** in the `hubs` seed and **not** in `HUB_COLORS` (`_shared.ts:3-11`). Its rows resolve to `mh_san_pedro`, get `city: null`, write orphan snapshots no UI can render, and drop out of city aggregation. The `pedidos > 0` guard hides it today (all zeros). If San Pedro goes live: add to `hubs`, add a colour, re-verify. |
| `CH Guadalupe general` | Correctly dropped — `resolveHubId` returns null for `ch_*`. Expect a `[resolveHubId] unrecognised hub label` dev warning on first upload; that one is intentional. |
| City AOV would be a sum | §4. The single most likely thing to ship wrong — $4,350 instead of $1,096 for Monterrey. `currency_avg` + `numerator = AOV × Pedidos` is the fix. |
| Rate KPIs summed across hubs | Same class of bug — 27.3 instead of 6.76. Weight by headcount. |
| Total row = DB global row | §4a. For the 5 `count`/`currency` KPIs the DB global is a **mean of hubs** (~426 pedidos), not a sum (~5,000+). Reading it under a "Total" heading is the most visible way this feature can ship wrong. Sum the 7 hub rows client-side. |
| Partial week = silently wrong Total | 4 city files feed one Total. Upload 3 and the Total looks like a 25% business collapse. Show the `n de 4 ciudades cargadas` banner (Step 5). |
| Total prev-week value | The WoW delta on the Total row needs last week's value summed the same way. Reading `prev_week_value` off the DB global row mixes a summed current against a meaned previous. |
| "Total" vs "Media global" | The same KPI id now renders as a sum in Resumen and a mean in Por KPI. Deliberate, but keep the two labels distinct forever. |
| Top movers hijacked | Volume/headcount KPIs swing far harder in relative terms than quality pcts. Filter `isResumenKpi` out of `topMovers` (PorKpiTab:74-88) or the strip is useless from week one. |
| `ALTER TYPE ... ADD VALUE` transaction rule | Postgres refuses to use a new enum value in the transaction that added it. Separate migration file. |
| `apps.group_id` not in local migrations | Production schema has drifted. Explicit column lists in every INSERT. |
| Two different denominators in one file | Finding 2 — `Retrasos armado/entrega (%)` divide by delivered orders, every other pct divides by `Pedidos`. Do not assume a shared base when reconciling. |
| `Pendiente armado (#)` is mislabelled | Finding 1 — it's the undelivered count, not an assembly backlog. Do not build an "armado" KPI on it. |
| Overlap columns stay `metric`, not `ignored` | `coerceRows` stores anything listed in `app_columns` regardless of role, but marking them `ignored` signals the wrong intent for the reconciliation view later. |
| `expected_files_per_week = 4` | Drives the `/upload` slot grid (`CITIES` at `upload/page.tsx:7`). `per_city` renders exactly four slots — matches your export flow. |
| Friday `week_start` | Unchanged. The sample's timestamps span 2026-07-24 (Fri) → 2026-07-30 (Thu), already Friday-aligned. Upload route validates with local noon (HANDOFF §5). |

---

## 8. Verification checklist

1. `npx tsc --noEmit` — **not** `npm run build` while `npm run dev` is live (HANDOFF §12, corrupts `.next`).
2. Upload the Monterrey sample for week `2026-07-24`. Expect: validated, 6 rows stored, `CH Guadalupe general` and `MH San Pedro` absent from snapshots.
3. Recompute that week, then assert in `kpi_snapshots`:

| kpi_id | scope | expected |
|---|---|---|
| `aov_mxn` | hub / `mh_contry` | **1171.20** |
| `aov_mxn` | city / `Monterrey` | **1096.17** — must land inside the hub range 1020.67–1171.20, **not** 4350. This one assertion proves the `currency_avg` wiring. |
| `ingresos_hub` | hub / `mh_contry` | **1,081,017.41** |
| `ingresos_hub` | city / `Monterrey` | **3,269,860.34** |
| `pedidos_hub` | city / `Monterrey` | **2983** |
| `pedidos_entregados` | city / `Monterrey` | **2909** |
| `pedidos_por_armador_dia` | city / `Monterrey` | **6.7642** — inside the hub range 6.26–8.22, **not** 27.3 |
| `entregas_por_repartidor_dia` | city / `Monterrey` | **9.9103** |
| `armadores_activos` / `repartidores_activos` | city / `Monterrey` | **63** / **43** |

4. `peer_comparisons` — confirm `entity_type='hub'` rows exist at `within_city` + `global` with sane `rank` / `z_score`.
5. Upload the other three cities, recompute, then check the tree in the UI:
   - 7 hub rows, 4 city rows, 1 Total row. No `mh_san_pedro`, no `ch_*`.
   - Every city row equals the sum (count/currency) or weighted average (rest) of its own hubs. Monterrey is the one you can check by hand against the §8.3 table.
   - **Total `pedidos_hub` = the sum of all 7 hub rows**, and visibly larger than any single city. If it reads ~426, you're rendering the DB global mean — go back to §4a.
   - Total `aov_mxn` sits inside the min–max of the 7 hub AOVs. If it's ~$7,600, the `currency_avg` wiring didn't land.
   - Total `armadores_activos` = 63 + the other three cities' assembler counts.
6. Delete one city's upload, recompute, reload: the Total row must show `3 de 4 ciudades cargadas`. Re-upload before moving on.
7. Open `/historicos?tab=res` in a fresh tab — must land on the Resumen tab (proves Step 6's `page.tsx` cast). Expand/collapse a city, confirm the URL doesn't change and no refetch fires (Network tab stays quiet — HANDOFF §4a).
7. Confirm nothing leaked: Por Hub tile count unchanged, top movers has no `operacion` KPI, Comparativa row count unchanged, "Generar reporte" output identical to a pre-change run for the same week.
8. Set one target in `/config` (e.g. `pedidos_por_armador_dia = 7`), confirm it round-trips and the Resumen tab reflects it.
9. Run two consecutive weeks before trusting WoW deltas — `prev_week_value` is null on a first compute (HANDOFF §12).

---

## 9. Open questions for you

*Resolved 2026-07-31: the new KPIs appear in the Por KPI selector and heatmap (per-hub lines), excluded from top movers only — see §5. The `Pendiente armado` labelling question (Finding 1) was reviewed and parked; the plan does not depend on it.*

1. **`ingresos_hub` naming** — "Ingresos estimados" is deliberately hedged: does Retool's `Pedidos` mean placed or delivered? Given Finding 2, `Pedidos` includes the 74 undelivered Monterrey orders, so `Pedidos × AOV` overstates realised revenue by ~2.5%. Options: keep the hedge, or switch the numerator to `pedidos_entregados × AOV`.
4. **`Nro. de pedidos / armador / día`** — is "día" working days or calendar days, and is it consistent across hubs? If Retool divides by a fixed 7 regardless of operating days, cross-hub comparison is distorted.
5. **`HANDOFF.md` is stale.** Dated 2026-07-17 / session 11, but the repo already has `lib/generate-insights.ts`, `lib/classify-notes.ts`, `app/api/insights/*` and `/prioridades` — none documented. Worth a catch-up pass before session 12 adds more surface area.

---

## 9a. Local testing & rollout sequence — follow this order

### The constraint

**There is one Supabase project and no local stack.** `supabase/` contains only `migrations/` — no `config.toml`, no `supabase start`. `.env.local` points at the same `nxwpsvvfgygafjnhwccc` instance the deployed Netlify site uses.

Two consequences:

1. **Migrations are not local.** The moment the 8 `kpis` rows land with `active = true`, production sees them — and production is running code without the `isResumenKpi` filters, so they'd surface as tiles in Por Hub, rows in Comparativa, and lines in the coordinator's Slack report.
2. **Uploads from localhost write to production.** `npm run dev` + `/upload` inserts real `uploads` / `upload_rows` and real `kpi_snapshots`. There is no sandbox. That's acceptable here — you're uploading genuine weekly exports, not fixtures — but do not treat local uploads as throwaway. Re-uploading a slot is safe (delete-then-insert, §5 of HANDOFF), uploading the *wrong week* is what to avoid.

Code is not affected: `git commit` checkpoints without deploying; only `git push` triggers Netlify.

### Sequence (decided 2026-07-31)

**Phase 0 — write everything, deploy nothing.**
Build Steps 1–7 in full. `npx tsc --noEmit` clean. Commit locally. Do not push, do not run the migrations yet.

**Phase 1 — push the filter-only commit.**
Split out and push *only* the changes that are inert without the new KPIs:

- `_shared.ts`: `RESUMEN_CATEGORY`, `isResumenKpi`, the `currency_avg` case in `formatValue`
- `PorHubTab.tsx`: the `isResumenKpi` exclusion in `tiles`, `currency_avg` in `UNIT_MAX_CEIL`
- `PorKpiTab.tsx`: the `isResumenKpi` exclusion inside the `topMovers` useMemo **only**
- `ComparativaTab.tsx`: the exclusion
- `GenerarReporte.tsx`: the `kpiSummary` exclusion

With zero `category = 'operacion'` rows in the DB, every one of those filters matches nothing — a verified no-op. Confirm on the main Netlify URL (**not** a deploy-preview URL — HANDOFF §15) that the dashboard is byte-identical: same tile count, same top movers, same Comparativa rows. **Do not** include `ResumenTab.tsx` or the `HistoricosClient` tab button in this commit.

**Phase 2 — run the migrations.**
Supabase SQL editor, in order, as **two separate executions**: `20260731000001_kpi_unit_currency_avg.sql` first, then `20260731000002_resumen_operativo.sql`. Postgres will reject `currency_avg` if both run in one transaction (§4).

Seed `kpis.active = true`. Prod is protected by Phase 1 now. Expected visible change on production: one new card on `/upload` ("Resumen operativo semanal", 4 city slots), 8 new entries in the Por KPI selector and `/config`'s catalog. All correct and intended.

**Phase 3 — test on localhost.**

```bash
cd ~/Desktop/calii-ops-app
npm run dev          # long-lived; occupies the terminal (HANDOFF §15)
```

1. `localhost:3000/upload` → upload all 4 city files for the target Friday week. Watch for `[resolveHubId] unrecognised hub label` in the dev console — `CH Guadalupe general` is expected, anything else is a missing alias.
2. Hit "Recomputar snapshots" for that week.
3. Walk the §8 verification checklist. The two assertions that prove the design landed: **Monterrey `aov_mxn` = 1096.17** (not 4350) and **Monterrey `pedidos_por_armador_dia` = 6.764** (not 27.3).
4. Check the Resumen tree: 7 hubs, 4 cities, 1 Total. Total `pedidos_hub` must be the sum of all 7 hub rows, not ~426.
5. Confirm no leakage: Por Hub tile count unchanged, top movers has no `operacion` KPI, "Generar reporte" output matches a pre-change run for the same week.

**Phase 4 — push the rest.**
`ResumenTab.tsx` + the `HistoricosClient` / `page.tsx` tab wiring. The tab appears on production already populated, because Phase 2 and 3 filled the snapshots.

### Rollback

If something's wrong after Phase 2, `UPDATE kpis SET active = false WHERE category = 'operacion';` removes all 8 from every view and stops them being computed (`kpi-compute.ts:68`, `page.tsx:74`) without touching data or code. `/config`'s catalog list has no `active` filter, so they'll still be listed there — cosmetic only.

---

## 10. Phase 2 — parked, not in scope

- **`impacto_incidentes_mxn`** = `Pedidos × incidentes_clientes_pct × AOV`. With AOV available, every quality KPI can be expressed in pesos. Strongest follow-on, and the reason to ingest the overlap columns now.
- **Reconciliation view** — Retool's hub rollup vs. our entity-derived numbers for the six overlapping columns. A persistent gap means a hub alias miss or a stale upload; the data will already be stored, it just needs a page. Mind the two denominators (Finding 2).
- **Timestamp columns** — `ventana de armado` / `ventana de entregas` in hours. Deliberately deferred; `kpi_unit` already has an unused `'minutes'` value if you pick this up.
- **`Pendiente entrega (#)`** — revisit after 3–4 weekly files. If it's ever non-zero it becomes a real backlog KPI.
- **Volume-weighted global means** — with `pedidos_hub` available, the `count`/`currency` global scope could become order-weighted instead of an unweighted hub mean. Changes historical comparability, so it needs its own decision.
