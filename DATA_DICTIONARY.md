# Calii Ops — Data Dictionary

**What this is.** What each column actually *means* operationally, and what its values
mean — answered by José, not inferred from the data. `DATA_AUDIT.md` says what exists and
how much of it. This file says what it means. Neither the app nor a future Claude session
can guess this, so it is the prerequisite for every analysis feature.

**Status legend**

| | |
|---|---|
| ✅ **CONFIRMED** | José answered directly. Safe to build on. |
| ⚠️ **CORRECTED** | An earlier answer was revised. The current reading is the one below. |
| 🔶 **ASSUMED** | My inference from the data. **Not yet confirmed — do not build on it.** |
| ❓ **OPEN** | Asked, not yet answered, or needs someone other than José. |

**Rule for this file:** always name the file a column belongs to. `num_absences` exists on
both `desempeno_operadores` and `desempeno_repartidores` and means different things in
different contexts; a bare column name is unusable.

Started 2026-08-21. Rounds 1–2 recorded.

---

## `faltantes_armador`

One row per item an armador reported missing while picking. 11,434 rows / 20 weeks.

### `Inventario disponible` ✅ CONFIRMED
**System stock at the moment the armador reported the faltante.**

Therefore:

| Value | Meaning | Share |
|---|---|---|
| `= 0` | Genuine stockout. There was nothing to pick. **Not the armador's fault** — supply side. | 30.2% |
| `> 0` | System believed stock existed. Pick failure, misplaced product, or wrong inventory. **Ops side.** | ~68% |
| `< 0` | 46 events, min −8. ❓ OPEN — meaning unknown. | ~1.8% |
| null | 41 events | 1.6% |

> **This is the single most valuable confirmed fact in the audit.** It splits the
> `faltantes_armador_pct` KPI — currently one undifferentiated number — into a Compras
> problem and an Ops problem, with no model and no new data.

### `Notas armador` ✅ CONFIRMED
**The armador types it freely on the picking app.** No dropdown, no official category
list. First-hand — the person who found the problem wrote it.

95.3% filled, 578 distinct values over 2,528 rows (4-week window). Observed clusters:
`Agotado`/`Producto agotado`/`0 en stock`/`Sin stock` (~536 rows), `Merma` (~148),
`Error de inventario` (~78), `Producto no localizado`.

Consequences:

- **578 distinct values are spelling variants of a small number of real reasons.**
  Normalising them is our job and nobody else's — there is no canonical list to adopt.
- The taxonomy must be **derived from the full value list and confirmed by José**, not
  invented. Next step: dump all 578 with counts, agree the buckets, then encode them.
- Because it is free text from the armador, it reflects *what the armador believed*,
  which may differ from what `Inventario disponible` says. That disagreement is
  informative, not noise — e.g. note says "agotado" but system stock > 0 means the
  inventory record was wrong.

### `error de recepción` ✅ CONFIRMED — NOT IN THIS DATASET
Used by **inventaristas** to justify a delta when confirming inventory. It lives in the
**`registro de inventario` worksheet**, which is **daily, per hub** — 49 files/week.

**Decision: not ingesting it.** Not worth 49 uploads/week to reach one field. Park it.
If recepción-driven faltantes ever become the priority, the question is whether that
worksheet can emit one weekly rollup per hub — not whether we can upload it as-is.

⚠️ This invalidates the `error_recepcion` rule I put in `scripts/faltantes-probe.ts`.

---

## `desempeno_operadores`

One row per armador per week. 2,477 rows / 20 weeks, 41 columns.

### `num_absences` ⚠️ CORRECTED → ✅ CONFIRMED
**Unjustified absences only.** Excludes vacations and incapacidades.

Observed: mean **2.11 per armador per week**, 55% zeros, max 6. Among armadores with any
absence, the average is ~4.7 unjustified absences in a single week.

> ⚠️ **This reading makes the number much more serious than the first pass suggested.**
> Round 1's initial answer was "calendar days without assistance, includes incapacities
> and vacations", corrected in round 2. Worth an empirical sanity check before it anchors
> a KPI — 4.7 unjustified absences in a week is a lot.

### `num_absences_including_justified` ✅ CONFIRMED
Same, **plus** vacations, incapacidades and other justified absence. Mean 2.41.

The gap (2.41 − 2.11 = **0.30**) is the justified portion — i.e. roughly **86% of all
recorded absence is unjustified**. Confirm before quoting.

### `num_tardy` / `num_tardy_including_justified` ✅ CONFIRMED
Same unjustified/justified split. Means 0.74 and 0.95.

### `num_idle_days` ❓ OPEN — under investigation
Mean 2.27, 39% zeros, max 5. José: no known meaning.

**Method agreed:** reverse-engineer it from other columns rather than guess. Accept a
derivation **only at ~100% match** (98%+ where floats and rounding are involved). Below
that threshold it stays OPEN. `scripts/reverse-engineer.ts` runs the test battery.

### `total_idle_time_min` ✅ CONFIRMED
**Any time during the shift without an order opened.**

Mean 769 min/armador/week vs `total_num_min_of_assembly` at 1,017 min.

> ⚠️ **Correction to `DATA_AUDIT.md` §4.4.** I framed the 43% as a capacity finding —
> "idle is 43% of assembly-room time". That over-claims. By this definition idle time
> includes breaks, restocking, receiving, moving around the hub, and anything else done
> between orders. It is *shift time minus order-open time*, not *time spent waiting for
> work*. It is still worth analysing, but it is not evidence of overstaffing on its own,
> and it can't be turned into a productivity KPI without a way to separate legitimate
> non-order work from genuine waiting.

❓ OPEN: the −12.86 minimum. Likely overlapping order timestamps, but unconfirmed.

### `num_orders_with_faltante_armador` ✅ CONFIRMED
**Counts ORDERS containing at least one faltante — not the faltantes themselves.**

The `faltantes_armador` file counts **items**. One order with three missing items is
1 here and 3 rows there. Both are correct at different grains:

| Question | Use |
|---|---|
| "What share of orders were affected by a faltante?" | `num_orders_with_faltante_armador` / `num_assembled` |
| "How many items went missing, and which ones?" | `faltantes_armador` event rows |

The existing `computeFaltantesArmadorPeerValues` uses the orders grain over `num_assembled`
— correct, and now documented. The ratio between the two grains (items per affected order)
is itself a metric nobody computes today.

---

## `incidentes`

14,440 rows / 20 weeks. **Two different things share this file.** ✅ CONFIRMED

| Kind | `Tipo de incidente` | `Notas` | Who creates it |
|---|---|---|---|
| **Automatic** | `Inasistencia`, `Llegada tardía` | empty | Generated under `robertott@calii.com` (the ops monitor account) |
| **Manual** | `Otro` | filled | A person, describing what happened |

Counts in the 4-week window: Inasistencia 2,017 · Llegada tardía 879 · Otro 115.
`Notas` non-empty = 115, exactly matching the Otro count.

### Consequences

1. **`Tipo de incidente` is the routing key for this file** and no code reads it. Every
   consumer should branch on it first.
2. **The automatic rows duplicate `desempeno_operadores.num_absences`** — ✅ CONFIRMED same
   events, same upstream source. So attendance can be read at *event grain with dates*
   here, or at *weekly count grain* there. The event grain is strictly richer.
3. `lib/kpi-compute.ts` already excludes `robertott@calii.com` in `extractIncidentesValues`
   — that exclusion is now understood: it is filtering out the automatic rows to isolate
   the manual ones. The rule is correct; it was just undocumented.
4. **`entregas_erroneas`** (a globally-watched KPI) is therefore derived from the ~115
   manual rows per 4 weeks — a genuinely small base. Not wrong, but worth knowing.

---

## `mna`

670,430 rows / 20 weeks — 96% of the whole database. 22 columns, 7 read.

### Grain ✅ CONFIRMED
**One row per SKU per hub, per week.** ~4,800 rows per hub per week against ~5,000
distinct products, so this is effectively a **full catalog snapshot per hub**, not a
merma log.

That reframes two numbers that looked alarming in `DATA_AUDIT.md`:

| Observation | What it actually means |
|---|---|
| `MNA ($)` is 95% zeros | Most SKUs simply had no waste that week. Normal, not a data problem. |
| `Recibido` is 60% zeros | Most SKUs received nothing that week. Also normal. |

So `mna` is a **weekly inventory-state snapshot that happens to carry merma**. It can
answer stock questions, not just waste questions — which is the more valuable read.

### `Kg/Pz` + `Recibido` + `Inventario` + `Consumo / día` ⚠️ UNIT HAZARD ✅ CONFIRMED
**`Recibido` is denominated in whatever unit `Kg/Pz` names for that row.** Values seen:
`Pz`, `Kg`, `kg` (note the casing inconsistency — normalise before grouping).

**Rules that follow, and they are not optional:**

- ❌ **Never sum `Recibido`, `Inventario`, `MNA (kg/pz)` or `Consumo / día` across SKUs**
  without splitting by unit. Adding kilos to pieces produces a number that means nothing.
- ✅ **Money is safe.** `Recibido × Source price` is pesos regardless of unit, so
  `mna_pct` (which uses `MNA ($) / (MNA ($) + Recibido × Source price)`) aggregates
  correctly — **provided `Source price` is per the `Kg/Pz` unit.** ❓ OPEN, asked next round.
- ✅ **Same-unit ratios are safe.** `Inventario ÷ Consumo / día` cancels the unit.

### `Tiers` ✅ CONFIRMED
**Product category hierarchy — family.subfamily.** 100% filled, 88 distinct values,
formatted `5.1`, `5.2`, `4`.

> **This is a direct upgrade to three shipped KPIs.** `mna_fyv_pct`, `mna_carnes_pct`
> and `mna_graneles_pct` are all driven by `lib/sku-classifier.ts`, which infers the
> category from supplier name with a product-name keyword fallback. Its own docstring
> states the coverage:
>
> - 6 exclusive FyV suppliers → **161 SKUs**
> - 57 exclusive Carnes suppliers → **~600 SKUs**
> - everything else (**~4,160 of 4,925 SKUs, ~85% of the catalog**) falls through to
>   keyword matching, and unknown suppliers default to `abarrotes` — "correct ~79% of
>   the time", by the file's own admission.
>
> Meanwhile `Tiers` carries the real family.subfamily hierarchy on **100% of rows** and
> is read by nothing. Mapping the 88 codes to categories replaces an 85%-of-catalog
> guess with the actual taxonomy, and gives finer breakdowns than three buckets.
>
> ❓ OPEN: the tier code → category-name mapping. Needed before this is usable.
> Once we have it, the migration is worth doing carefully — the three KPIs have 20 weeks
> of history computed under the old classifier, so recomputing changes historical values.

### `Días de inventario` ✅ CONFIRMED intent, 🔶 value suspect
**Days of stock cover at current consumption**, i.e. `Inventario ÷ Consumo / día`.

85.4% filled, stored as a **string**, 4,987 distinct values — but the three most common
are `0`, `90` and `45`, which look like caps or fallbacks rather than measurements
(likely what gets written when `Consumo / día` is 0 and the division is undefined).

**Do not use the shipped column until verified.** Testable: recompute
`Inventario ÷ Consumo / día` and check what fraction reproduces the stored value, and
what the `0`/`90`/`45` rows have in common. Added to `scripts/reverse-engineer.ts`.

---

## Open items for someone other than José

- `faltantes_armador.Inventario disponible < 0` — 46 events, min −8. What produces a
  negative available stock?
- `registro de inventario` — could it emit one weekly per-hub rollup instead of 49 daily
  files? Owner: inventaristas / whoever maintains that worksheet.

---

## Corrections this file has already forced

| Where | What was wrong |
|---|---|
| `scripts/faltantes-probe.ts` | `error_recepcion` cause rule — that cause lives in a dataset we don't ingest. Rule must be removed. |
| `DATA_AUDIT.md` §4.1 | Framed `incidentes` as "an attendance log". More precisely: it is two datasets in one file, split by `Tipo de incidente`, and the manual half is the part `entregas_erroneas` uses. |
| `DATA_AUDIT.md` §7 Q1 | Answered: `num_absences` is unjustified-only. The "is this a naming trap?" question resolved the *opposite* way from the benign reading — it makes the number worse, not better. |
