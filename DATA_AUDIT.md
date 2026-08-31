# Calii Ops — Data Audit

**Generated:** 2026-08-21 · **Covers:** 20 weeks (2026-03-27 → 2026-08-07)
**Method:** `scripts/data-audit.ts` (read-only Supabase inventory) + static trace of every
declared column through the repo + an independent verification pass over 10 load-bearing claims.

Companion read-only artifact (same content, formatted):
https://claude.ai/code/artifact/4dae8e57-8d4d-4ee3-b3f5-a6ea001795d8

> **Purpose.** Establish what data actually lands in this database every week and how much
> of it reaches anything, before planning the "chatbox + richer task suggestions" work.
> This is a findings document, not a task list.

---

## 0. Corrections to HANDOFF.md

Apply these when HANDOFF.md is next touched — a future session will read it first and believe it.

| HANDOFF says | Reality |
|---|---|
| §3: `desempeño_repartidores` is the "driver roster — used to zero-fill drivers with no incidents in `extractIncidentesValues`". Repeated in §9. | That table has **0 rows** and **no code reference**. `extractIncidentesValues` builds `driverHub` from `rowsByApp.get('desempeno_repartidores')` (kpi-compute.ts:428) — i.e. that week's `upload_rows`, no ñ. The mechanism works; the documented source is wrong. |
| §3 `upload_rows`: "Only columns defined in `app_columns` for the app are stored" | True, and worth stating in both directions: `coerceRows` (parse.ts:68-76) writes **every** declared column regardless of `role` — including `role='ignored'`. 28 of 29 ignored columns hold real values today. Undeclared CSV columns are dropped silently and irrecoverably. |
| `lib/classify-notes.ts:3` — "Drives the derived KPI `entregas_erroneas`" | **False.** `entregas_erroneas` is derived by regex rules in `extractIncidentesValues` (kpi-compute.ts:419-500): responsable exclusion, `INCIDENTES_ORDER_CODE_RE`, then an allowlist or `INCIDENTES_DELIVERY_RE`. `classify-notes.ts` is not involved. |
| `lib/generate-insights.ts:5` — bundle includes "classified incident labels" | **False.** `buildDataBundle` selects only `data` (lines 256, 291). The `labels` column is never read. |
| §19 lists the resumen_operativo overlap reconciliation as parked | Still parked, and now quantified — see §4.5 below. |

---

## 1. Headline numbers

| | |
|---|---|
| Weeks of history | 20 (no gaps; all 560 uploads `validated`) |
| Rows in `upload_rows` | 700,444 |
| Upload datasets (`apps`) | 11 |
| Declared columns (`app_columns`) | 160 |
| Live KPIs | 29 |
| `kpi_snapshots` rows | 36,247 |
| `peer_comparisons` rows | 195,579 |

**Column classification — the core finding:**

| State | Count | Meaning |
|---|---|---|
| Computed | 64 | Feeds a KPI, peer ranking, or chart |
| Sampled only | 3 | Reaches the weekly AI prompt as a text excerpt, capped at 10 items. Never counted or trended. |
| **Inert** | **93** | Stored every week since March. Read by nothing, anywhere. |

The 3 sampled-only columns: `desempeno_operadores.performance_alerts`,
`desempeno_operadores.issues_comments`, `faltantes_armador."Notas armador"`.

---

## 2. Measurement caveats

Carry these into any decision made from this document.

1. **Column fill rates and value distributions come from a 4-week profiling window**
   (2026-07-17 → 2026-08-07), not all 20 weeks. Row counts, week coverage and snapshot
   stats do cover the full history.
2. **The `mna` profile hit the 12,000-row cap** against 670,430 total rows. Its fill
   percentages describe a slice. Every other app was profiled complete.
3. **"Read by no code" = no static reference in the repo.** It cannot see ad-hoc queries
   run by hand in the Supabase console.
4. Summing per-upload declared `row_count` gives 702,856 vs 700,444 rows actually stored
   — a 0.3% gap, probably re-uploads. Confirm before quoting exact totals.

---

## 3. The eleven datasets

| App | Rows (20wk) | Files/wk | Cols | Read | KPIs | Grain |
|---|---:|---:|---:|---:|---:|---|
| `mna` | 670,430 | 7 | 22 | 7 | 4 | SKU × hub × week |
| `incidentes` | 14,440 | 4 | 5 | 3 | 1 | event × person × date |
| `faltantes_armador` | 11,434 | 1 | 11 | 7 | **0** | event × product × armador |
| `desempeno_operadores` | 2,477 | 4 | 41 | 16 | 8 | armador × week |
| `discrepancia` | 1,718 | 1 | 15 | 5 | 1 | repartidor × week |
| `desempeno_repartidores` | 1,587 | 4 | 30 | 9 | 3 | repartidor × week |
| `faltantes_hub_*_pct` ×4 | 560 | 4 | 16 | 12 | 4 | hub × week |
| `resumen_operativo` | 210 | 4 | 20 | 8 | 8 | hub × week |

Notes:
- **MNA is 96% of the database** and drives 4 KPIs off 6-7 columns.
- **`faltantes_armador` produces no KPI.** `faltantes_armador_pct` is read from the
  separate `faltantes_hub_general_pct` Retool export (`extractFaltantesHubPctDirect`).
  The 11,434 event rows are stored and never aggregated. Assembler-level faltante rates
  come from `num_orders_with_faltante_armador` on the *operadores* file, via
  `computeFaltantesArmadorPeerValues` — and land in `peer_comparisons` **only**, never
  in `kpi_snapshots`. So there is no per-person faltantes trend.
- `resumen_operativo` starts 2026-05-01 → 5 missing weeks vs every other app.

---

## 4. The five seams

### 4.1 `incidentes` is an attendance log — and has no KPI

| Evidence | Value |
|---|---|
| `Tipo de incidente` fill | 100%, exactly 3 distinct values |
| — Inasistencia | 2,017 rows (4wk) |
| — Llegada tardía | 879 rows |
| — Otro | 115 rows |
| `Notas` fill | 115 / 3,011 = **3.8%** |
| `Tipo de incidente` consumers | **none** |

`Notas` non-empty (115) equals the `Otro` count (115) exactly — notes are written only
when type is Otro. The 96.2% empty rate is structural.

`entregas_erroneas` (watched_globally) is derived by regex over those 115 rows. The
2,896 attendance events beside them drive nothing.

Attendance arrives redundantly on the armador file — all inert:
`num_absences` (mean 2.11/wk, 55% zeros), `num_absences_including_justified` (2.41),
`num_tardy` (0.74), `num_tardy_including_justified` (0.95), `num_idle_days` (2.27).
Same on the driver file: `num_absences` (0.63), `num_tardy` (1.07).

`/prioridades` ships an **"Asistencia" category tab with no KPI behind it**
(`CATEGORIES` in `app/(app)/prioridades/page.tsx`).

### 4.2 Faltantes root cause is in two unread columns

| Column | Fill | Distribution | Read by |
|---|---|---|---|
| `Inventario disponible` | 98.4% | **30.2% zeros**, min −8 (46 negatives) | nothing |
| `Notas armador` | 95.3% | 578 distinct / 2,528 rows | prompt sample only |
| `Item ID` | 100% | 1,088 distinct | nothing |

`Inventario disponible = 0` splits a faltante into genuine stockout (Compras) vs pick
failure (Ops). `Notas armador` top clusters: `Agotado ` 185, `Producto agotado ` 124,
`Agotado` 91, `Merma` 84, `Error de inventario ` 78, `0 en stock ` 73, `Merma ` 64,
`Sin stock` 64 — normalizable to a small taxonomy without a model.

`Item ID` being inert is what blocks joining a faltante back to its MNA record.

**Open question:** what does a negative `Inventario disponible` mean?

### 4.3 `issues_comments` — delimited customer complaints, unparsed

| | operadores | repartidores |
|---|---|---|
| Fill | 48.9% (237/485) | 80.1% (242/302) |
| Avg items per row | 4.35 | 4.04 |
| Read by | `generate-insights` takes `issues[0]` of ≤10 rows | **nothing** |

Items appear to follow `Categoría | Producto | Comentario`.
**⚠ Evidence is thin: only 9 complete items were recoverable from audit samples; 9/9 matched.**
Categories seen: `Mala calidad` ×8, `Faltante` ×1. Validate across a full raw week before
building a parser.

~2,000 items in the 4-week window ⇒ order of 10,000 across the history. If the shape
holds this gives complaint counts by product × category × hub × week from a string split.

### 4.4 Shift and idle time — all inert

| Column | Fill | Mean |
|---|---|---|
| `total_num_min_of_assembly` | 100% | 1,017 min/armador/week |
| `total_idle_time_min` | 100% | 769 min/week (**min −12.86**) |
| `avg_start_time` / `avg_finish_time` | 73.2% | — |
| `normalized_num_assembly_minutes` | 70.1% | 570 |
| `num_skus_assembled` | 70.1% | 908 |
| `avg_min_per_assembly` | 73.2% | 7.56 |
| `resumen_operativo` Comienzo/Finalización armado + entregas | 50%* | — |

Idle is ~43% of logged assembly-room time and nothing reads it.
*The 50% is the CH-row artifact — see §5.

**Open question:** what does negative idle time mean?

### 4.5 MNA — 96% of the DB, 6 columns used

Consumed: `Producto`, `Proveedor`, `MNA ($)`, `Recibido`, `Source price`, `city`,
`Inventario` (tile flip in page.tsx only).

`MNA ($)` is **95% zeros** — merma concentrates in ~5% of SKUs. That Pareto is nowhere in the UI.

Well-filled and inert: `1 en N pedidos` (100%), `Consumo / día` (100%),
`Hubs out of stock` (100%, mean 1.46), `Días de inventario` (85.4%), `Tiers` (100%, 88 distinct),
`Disponible en app` (100%), `Represanta X% de merma total` (100%), `MNA (kg/pz)` (100%),
`SKU Calii` (100%), `Código de barras` (92.5%), `SKU Proveedor` (80.8%), `Kg/Pz` (99.4%).

Sparse — treat with care: `Out-of-stock (%)` 17.2%, `Compra deshabilitada` 11.0%, `MNA (%)` 41.7%.

Remember the 12,000-row cap on these figures.

### 4.6 Also inert, smaller

- **Driver-side quality has no KPI.** `num_orders_with_bad_quality` (mean 2.09, 26% zeros),
  `total_num_missing_items` (1.68), `num_orders_with_three_or_more_wrong` (0.16).
  Quality is measured on armadores only.
- **`orders_data`** — 92.1% fill, avg **56.7 entries per driver-week**. Per-order
  granularity inside a JSON blob nobody opens. Same for `orders_for_driver_ids`.
- **`client_issues_for_driver`** — 2.3% fill (7 rows / 4wk) but severe content
  (harassment complaint, theft allegation). Should never be sampled — surface all.
- **Discrepancia's other legs** — `Cálculo digital vales`, `Diferencia vales` (mean −123 MXN),
  `Conciliación Clip`, `Por devolver`, `Devoluciones confirmadas`, `Diferencia devoluciones`:
  all 100% filled, all inert.
- **`km_per_hr` / `total_driving_distance_km`** — 12.6% fill. Too sparse to build on.
- **`receives_bonus`**, **`order_total_multiplier`** (73.2%, mean 0.98) — inert, semantics unknown.
- Armador process-compliance metrics, all 100% fill and inert:
  `num_orders_with_missing_barcode` (mean 1.11), `num_orders_with_missing_expiration_date` (0.23),
  `num_orders_with_pending_confirmation` (1.19).

---

## 5. Broken / stale / drifted

| # | What | Evidence | Impact |
|---|---|---|---|
| 1 | Panamericano leg never populated | `Conciliación Panamericano` = 0 in all 330 rows. `Diferencia Panamericano` identical to `Cálculo digital efectivo` on every statistic (min 0, max 37403.63, mean 9505.08, 56 zeros) | A "difference" that always equals the full amount |
| 2 | "Delivered" measures assembled | `pedidos_entregados` = `Pedidos (#)` − `Pendiente armado (#)`. `Pendiente entrega (#)` is 0 in all 56 rows | `ingresos_hub` inherits the same subtraction |
| 3 | Dead classifier | `classify-notes.ts` writes `labels`; no KPI/chart/prompt reads it. Also `await`ed on the upload request path despite the comment saying otherwise (`app/api/upload/route.ts:248`) | Small spend (~115 rows/upload) + upload latency |
| 4 | Two false docstrings | `classify-notes.ts:3`, `generate-insights.ts:5` | See §0 |
| 5 | Empty ghost table | `desempeño_repartidores` — 0 rows, no code reference | See §0 |
| 6 | 23 of 29 KPIs have no target | Only 7 `kpi_targets` rows; `tasa_armado` duplicated | Every number on screen lacks a verdict. Feature is built and shipped, just unpopulated. |
| 7 | No feedback loop | `insight_feedback` = 0, `annotations` = 0, `saved_views` = 0. 27 `ai_insights` in 20 weeks | The insight-quality signal has never been collected |
| 8 | Near-constant KPI | `pct_armado_tardio`: 332 zeros of 355 non-null (93.5%) + 130 nulls. 23 non-zero values in 485 rows, mean 0.33 | Occupies a tile + chart, carries almost no information |
| 9 | CH rows in a MH dataset | `resumen_operativo` has 14 distinct `Hub` values for 7 MHs (CH Guadalajara, CH Saltillo, …); half the rows discarded downstream | Explains uniform 50% fill on that file |
| 10 | Redundant column | `num_orders` ≡ `num_assigned_orders` on every statistic (min 0, max 129, mean 52.21, 8% zeros) | `pct_tardias_reparto` and `pct_undelivered` use different ones as denominators believing them different |
| 11 | Orphaned KPI | `eggs_issue_rate` seeded in `20260427000003` but absent from the live registry (29 rows, no eggs) | `num_issues_with_eggs` / `num_driver_orders_with_eggs` consequently inert |
| 12 | `tasa_armado` coverage | `num_skus_per_hour_assembly_rate` fill 340/485 = 70.1%. But `num_assembled` has 130 zeros — so ~27% is structurally undefined (no volume), only ~3% is real volume with a missing rate | Not as bad as raw fill suggests; state it correctly |

---

## 6. Implications for the chatbox / task-suggestion work

Three findings that should shape the design session:

1. **The bottleneck is not retrieval — the explanatory data was never computed.** A chatbox
   over `kpi_snapshots` can rank Contry's faltantes against six hubs today (the insight
   generator roughly does this). It cannot say *why*, because the why lives in 93 columns no
   aggregation has touched. A meaningful share of the work is upstream of the chat: deriving
   stockout-vs-pick-failure, attendance, complaint-by-product and shift-window into queryable
   form. Building the chat first yields a fluent assistant with nothing to be fluent about.

2. **Most of the missing analysis needs no model.** Faltantes cause split = compare to zero.
   Notes taxonomy = normalizer over 578 strings. Attendance KPIs = counts. Complaint-by-product
   = string split (if the delimiter holds). Reserving model calls for genuinely ambiguous work
   keeps the token question small and makes the numbers deterministic and testable.

3. **Targets are why the dashboard is hard to live in.** 23 of 29 KPIs have no threshold, so
   every number is a number without a verdict. Small, high-leverage, independent of everything
   else here.

---

## 7. Open questions

1. **What does `num_absences` actually count?** Mean 2.11/person/week, 55% zeros. Either a
   serious attendance problem or the column counts scheduled-off days. Decides whether §4.1
   is the biggest operational finding in this audit or a naming trap.
2. **Is `Inventario disponible` the stock at the moment of the faltante?** If yes, the 30%
   zero rate is a clean stockout/pick-failure split. And what does −8 mean?
3. **Does `Tipo de incidente` ever carry values beyond the three observed?** If not, the file
   is purely attendance and `entregas_erroneas` needs a rethink about its source.
4. **Can you export one raw week of the armador + repartidor CSVs?** Needed to (a) confirm the
   `Categoría | Producto | Comentario` shape beyond 9 samples, and (b) check for source columns
   never declared in `app_columns` — dropped silently, and the one category of data this audit
   cannot see.
5. **Which questions do you most want answered on a Monday morning?** Two or three real ones
   beyond the faltantes-in-Contry example, so the design works backwards from answers rather
   than forwards from the schema.

---

## 8. Reproducing this

```bash
cd ~/Desktop/calii-ops-app
npx tsx scripts/data-audit.ts
```

Read-only. Writes `data-audit-report.json` + `data-audit-summary.txt` to the project root.
Tunables at the top of the script: `PROFILE_WEEKS` (default 4) and `PROFILE_ROW_CAP`
(default 12,000 — raise it to profile MNA completely, at the cost of runtime).
