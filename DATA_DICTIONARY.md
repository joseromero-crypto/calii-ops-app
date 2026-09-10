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

Started 2026-08-21. Rounds 1–9 recorded.

---

# Operating context — how these numbers get used

Answered by José. **This governs everything below it.** A column's meaning is only half the
context; the other half is what decision it feeds and when.

## What the app is for ✅ CONFIRMED

**A decision-support tool for performance judgements that used to be automatic.** Bonuses
were once calculated by formula (`desempeno_operadores.receives_bonus` is that formula's
output); the rules changed, and the dashboard exists to support the human decision that
replaced it.

So the target of every feature is: *help a person decide something about a specific
armador, repartidor or hub* — not describe last week.

## The weekly rhythm ✅ CONFIRMED

```
FRIDAY            data lands  →  José reviews  →  reports shared with coordinators
                  ↓ same day, ideally
                  areas to improve flagged, with plans attached
MONDAY            coordinators start working those plans
```

**This is the reporting rhythm, and it is already solved.** The existing "Generar reporte"
Slack output gathers the week's data into a few sentences. It works.

> ⚠️ **Do not design the new work around this rhythm.** The chat assistant is **not** a
> Friday report generator — see `ASSISTANT_DESIGN.md` §2. It is an on-demand investigation
> tool used any day of the week, whenever José is digging into a specific hub or KPI. The
> Friday report is one of several things that might *trigger* an investigation, not the
> deliverable the assistant produces.

## What makes a number "bad" ✅ CONFIRMED — and it is not a fixed threshold

There are some `kpi_targets` goals, and **they are outdated**. The real drivers, in order:

1. **The hub against its own recent history** — is it deteriorating? *(primary signal)*
2. **The hub against the other hubs** — valuable, but **dangerous: the hubs are not
   comparable**. Different sizes, cities, catalogs, staffing. Use it, flag the caveat.

> **Design implication.** A target system that only supports fixed numbers is the wrong
> shape. It needs three modes — absolute threshold, self-trend, and peer-relative — and
> most KPIs will use the last two. The 7 existing `kpi_targets` rows should be treated as
> stale until reviewed, not as ground truth.
>
> This also means **peer comparisons need normalising before they're trustworthy.** Raw
> cross-hub ranking on a count is close to meaningless; rates and per-volume figures are
> the minimum, and even then the "hubs aren't the same" caveat should ride along with the
> comparison rather than being dropped.

## How to prioritise ✅ CONFIRMED

**No fixed ranking. Pareto.** Surface the vital few driving most of the problem, whatever
category they fall in — not a weighted scoring model across money / customer / trend.

> **This fits the data unusually well**, which is a good sign the rule is right:
>
> - `mna.MNA ($)` is **95% zeros** — merma lives in ~5% of SKUs.
> - Faltantes concentrate hard in a small set of products.
> - `desempeno_operadores.percent_assembled_late` is ~93.5% zeros — 23 non-zero values in
>   485 rows.
>
> A Pareto-first engine — "what few things account for most of this number" — matches both
> the decision rule and the shape of the data. It also sidesteps the ranking problem
> entirely: concentration is measurable, priority weightings are arguable.

## What an output should be ✅ CONFIRMED

**Finding + evidence + suggested action.** All three. José decides; the suggestion is
input to that decision, not a directive.

| Part | Must contain |
|---|---|
| **Finding** | What is true, stated plainly, scoped to a hub or person |
| **Evidence** | The actual numbers, the comparison basis, and which file they came from |
| **Suggested action** | Something a coordinator could start on Monday |

The suggested action is what makes this harder than reporting — it needs the protocol and
process knowledge, not just the data. That is the part most likely to be confidently wrong,
so it should be clearly marked as a suggestion and always shown alongside the evidence that
produced it.

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

### `num_idle_days` ❓ STILL OPEN — no derivation found
Ran against 2,845 rows / 23 weeks / 25 candidate columns. **No hypothesis cleared 98%.**
Range 0–5, 6 distinct values.

Correlations only (**weak signal — not a meaning**): `total_num_min_of_assembly` **−0.868** ·
`total_idle_time_min` **−0.856** · `num_assembled` **−0.801** ·
`num_absences_including_justified` **+0.689** · `num_absences` **+0.635**.

Reads as *days not working* — strongly negative with every work-volume column, positive with
absences — but **it is not equal to absences**, so it is something adjacent and undefined.

> ⚠️ **The cross-file test never actually ran for this file.** The name join to `incidentes`
> matched **0 of 2,845** person-weeks, because `desempeno_operadores.assembler` carries the
> nickname form `Nombre Completo ("Nick")` while `incidentes.Operador` is a plain name, and
> `normalizeName()` does not strip the parenthetical. **So "no derivation" does not rule out
> the incidentes hypothesis — that hypothesis was never tested.** The driver file joined fine
> (1,113 / 1,813) because `driver_name` has no nickname suffix.
>
> **Fix the normaliser and re-run before calling this closed.**
>
> ✅ **Fixed and re-run (Phase 0, `lib/normalize.ts`).** The join now matches 2,280/2,845
> person-weeks (80%, up from 0). The incidentes hypothesis was tested at row level across
> all `Tipo de incidente` values (including `*` = all tipos combined) and **found no
> derivation at ≥98%** — so this stays ❓ OPEN, but now genuinely tested rather than a false
> negative. `lib/tenure.ts`'s ledger was diffed before/after the fix and is unchanged
> (`scripts/tenure-dry-run.ts`).

### ⚠️ `total_num_min_of_assembly` is a LEGACY metric ✅ CONFIRMED by derivation

Row-level, 100.00% match (n=2,240), **both directions**:

```
total_num_min_of_assembly      = num_assembled × backcompat_avg_min_per_assembly
backcompat_avg_min_per_assembly = total_num_min_of_assembly / num_assembled
```

That is one identity stated twice — so those two columns are **the same quantity**, and the
derivation says nothing about which clock produced it.

**`avg_min_per_assembly` is a genuinely independent third measurement.** No derivation found,
and it correlates with `total_num_min_of_assembly` at only **r = −0.097** — essentially
unrelated. Mean **7.56 min/order** against the other pair's **~29**.

> **The column name is the evidence: `backcompat_` means backward compatibility.**
> So `backcompat_avg_min_per_assembly` is the **retired** formula, `avg_min_per_assembly` is
> the **current** one — and `total_num_min_of_assembly` is computed from the retired one.
>
> ⚠️ **This undercuts the "43% of assembly-room time is idle" claim in `DATA_AUDIT.md` §4.4**,
> which divided `total_idle_time_min` by `total_num_min_of_assembly` — a legacy denominator.
> Treat that figure as unreliable until re-derived against `avg_min_per_assembly`.
>
> It also fits the documented formula (`OPS_CONTEXT.md` §5c): *rango − minutos sin pedidos
> pendientes − descanso proporcional*. A ~7.6 min/order current figure is plausible for that;
> ~29 min/order is not. 🔶 Which column implements the formula is inference, not proof.

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
- ✅ **Money is safe. `Source price` is the price per the row's own `Kg/Pz` unit** —
  ✅ CONFIRMED. So `Recibido × Source price` is pesos on every row regardless of unit, and
  `mna_pct` (`MNA ($) / (MNA ($) + Recibido × Source price)`) aggregates correctly.
  **No bug here** — the unit hazard is real but the shipped KPI happens to sidestep it by
  only ever working in money.
- ✅ **Same-unit ratios are safe.** `Inventario ÷ Consumo / día` cancels the unit.

### `Tiers` ⚠️ CORRECTED → ✅ CONFIRMED
**A sales-velocity rank, not a product taxonomy.** 100% filled, 88 distinct values.

- **1 = best-selling, running down to ~8 = slowest.**
- Decimals are sub-ranks under the same logic: **`5.1` moves more than `5.2`**.

> ⚠️ **Correction.** An earlier round of this interview recorded `Tiers` as a
> "product category hierarchy (family.subfamily)". **That was wrong.** It is an ABC-style
> velocity ranking. The `5.1` / `5.2` format is rank and sub-rank, not family and
> subfamily.
>
> **Consequence: `Tiers` does NOT replace `lib/sku-classifier.ts`.** That classifier
> assigns `fyv` / `carnes` / `abarrotes` — what a product *is*. `Tiers` says how fast it
> *sells*. Different axes. The sku-classifier accuracy problem below stands unfixed.

**What `Tiers` is actually worth** — an ABC dimension the app has never had, on 100% of
670,430 rows:

- Is merma concentrated in fast movers or slow movers? (`MNA ($)` is 95% zeros — knowing
  *which* tier the non-zero 5% sits in changes what you do about it.)
- Do faltantes hit tier-1 items disproportionately? A stockout on a best-seller costs far
  more than one on a tier-8 item, and today both count the same in `faltantes_armador_pct`.
- Should slow-moving tiers be stocked at these hubs at all?

❓ OPEN: whether tier is assigned globally or per hub, and how often it is recalculated.
A SKU that changes tier between weeks would break any trend built on it.

### `1 en N pedidos` ✅ CONFIRMED — and it is what `Tiers` is built from
**Popularity: the SKU appears in 1 of every N orders.** 100% filled, mean 1,984, hard
ceiling at exactly 20,000 (the floor for items that essentially never sell).

**`Tiers` is derived from this column.** That gives a clean two-level structure:

| | Use for |
|---|---|
| `1 en N pedidos` (raw) | Analysis — continuous, finer-grained, no bucket boundaries to argue about. **Lower = more popular.** |
| `Tiers` (bucketed) | Grouping and reporting — 88 codes, matches how the business already talks about velocity. |

Prefer the raw number when ranking or correlating; use `Tiers` when the output needs to
line up with how people discuss the catalog. And since one derives from the other, they
can never disagree — no reconciliation needed.

### `Hubs out of stock` ⚠️ SUSPECT — DO NOT USE without verification
100% filled, mean 1.46, max 5 — but only 7 MHs exist, and the max never reaches 6 or 7.

José: this figure is **meant to be read on the by-city view** of the Retool report. He
uploads the **per-hub view**, which likely leaves the value computed in the wrong scope.

> **Treat this column as invalid until proven otherwise.** It is present and numeric on
> every row, which makes it dangerous — it looks usable. A network-wide stockout count
> would be the single best early warning for cross-hub faltantes, so it is worth getting
> right, but the fix is upstream: either export the by-city view alongside, or confirm
> what the per-hub export actually puts here.

❓ OPEN for whoever owns the Retool report.

### `lib/sku-classifier.ts` accuracy 🔶 UNRESOLVED
Separate from `Tiers`, and still a live problem. `mna_fyv_pct`, `mna_carnes_pct` and
`mna_graneles_pct` all depend on it, and its own docstring states the coverage:

- 6 exclusive FyV suppliers → **161 SKUs**
- 57 exclusive Carnes suppliers → **~600 SKUs**
- everything else (**~4,160 of 4,925 SKUs, ~85% of the catalog**) falls through to keyword
  matching, and unknown suppliers default to `abarrotes` — "correct ~79% of the time", by
  the file's own admission.

❓ OPEN: is there a real product-type field anywhere — in the MNA export, the catalog, or
a Comercial system — that would replace the keyword guess? `Tiers` is not it.

### `Días de inventario` ✅✅ CONFIRMED — derivation proven at row level

```
Días de inventario = Inventario / (Consumo / día)      100.00% match (n = 42,758)
```

⚠️ **My "0 / 90 / 45 look like caps" reading was wrong.** No cap exists — the real range is
**−8.46 to 5,730**. Those three values dominated the audit's *string-sorted* top-values list,
which is a display artifact, not a distribution. Negative values come straight from negative
`Inventario`.

*(superseded reading below, kept for the record)*

### ~~`Días de inventario`~~ 🔶 previous suspicion
**Days of stock cover at current consumption**, i.e. `Inventario ÷ Consumo / día`.

85.4% filled, stored as a **string**, 4,987 distinct values — but the three most common
are `0`, `90` and `45`, which look like caps or fallbacks rather than measurements
(likely what gets written when `Consumo / día` is 0 and the division is undefined).

**Do not use the shipped column until verified.** Testable: recompute
`Inventario ÷ Consumo / día` and check what fraction reproduces the stored value, and
what the `0`/`90`/`45` rows have in common. Added to `scripts/reverse-engineer.ts`.

---

## `desempeno_repartidores`

One row per repartidor per week. 1,587 rows / 20 weeks, 30 columns, 9 read.

### Is there a "delivered" column? ✅ ANSWERED — **no.**
José asked directly. Here is every order-count column on the file:

| Column | Mean | Max | Zeros |
|---|---:|---:|---:|
| `num_orders` | 52.21 | 129 | 8% |
| `num_assigned_orders` | 52.21 | 129 | 8% |
| `num_undelivered_orders` | 0.91 | 5 | 49% |
| `num_late_orders` | 1.24 | 16 | 61% |
| `num_early_orders` | 0.0099 | 1 | 99% |

**There is no delivered/entregadas column.** But José's instinct is exactly right:

```
delivered = num_assigned_orders − num_undelivered_orders
```

That value is **derivable today and computed nowhere.** It is also the honest denominator
for most driver quality questions — an order that was never delivered cannot be late, and
cannot generate a customer complaint.

### `num_orders` vs `num_assigned_orders` 🔶 IDENTICAL ON EVERY SUMMARY STAT
Same mean, max, min and zero-rate. Either one is a copy of the other, or they diverge so
rarely it does not show in aggregate.

**Not yet proven at row level** — added as a target to `scripts/reverse-engineer.ts`,
where hypothesis H1 tests `num_orders = num_assigned_orders` across all 20 weeks. If it
matches 100%, one column is redundant and we standardise on `num_assigned_orders`.

Live consequence either way: `pct_tardias_reparto` divides by `num_orders` while
`pct_undelivered` divides by `num_assigned_orders`. If they are the same column under two
names, that is harmless but confusing. If they are not, one of those two KPIs has the
wrong denominator.

### The egg columns ✅ CONFIRMED
`num_driver_orders_with_eggs` (mean **18.5** per driver-week, 8% zeros) and
`num_issues_with_eggs` (mean 0.28, 77% zeros). Both unread.

**Eggs break constantly — it was a tracked problem**, and these columns are the
instrumentation that was added for it. A KPI `eggs_issue_rate` was seeded in migration
`20260427000003` but is **absent from the live registry** (29 KPIs, no eggs), so it was
deleted at some point.

Exposure is large: 18.5 of a typical ~52-order driver-week contain eggs, about a third.
The issue rate implied by the two columns is roughly 1.5%.

❓ OPEN: was the problem solved, or did the KPI just get dropped? If it is still live,
reinstating it is nearly free — both columns are 100% filled with 20 weeks of history.

### `orders_data` ⭐⭐ RESOLVED — per-order delivery lateness, in minutes

**The single largest data find in this project.** 200 sampled driver-weeks yielded **10,213
order entries**. Every entry:

| Key | Fill | Example |
|---|---|---|
| `user_name` | 100% | `Jorge Sandoval` |
| **`delivered_at`** | **98%** | `2026-08-07T16:54:02.412-06:00` |
| `delivery_date_str` | 100% | `Ago-7` |
| **`delivery_window_start_date_time`** | 100% | `2026-08-07T15:59:59.999-06:00` |
| **`delivery_window_time`** | 100% | `4pm - 6pm` |
| **`minutes_delivered_late_or_early`** | **100%** | `0` |

⚠️ **CORRECTED (Phase 1 ETL, 2026-09-09).** The `0` example above is misleadingly round —
**the field is NOT integer minutes.** Every one of 92 validated `desempeno_repartidores`
uploads produced fractional values (e.g. `6.198328833350001`), almost certainly a
day-fraction multiplied out with float residue. `order_deliveries.minutes_late` is `numeric`,
not `int` (see `20260909000002_order_deliveries_minutes_late_numeric.sql` — the first
migration typed it `int` off this table's single rounded example and had to be corrected
before the backfill would write a single row). Anything computing the >30/>60-min protocol
thresholds should round only at the final bucketing step, not when storing the value.

Scale: ~57 entries per driver-week × 1,813 driver-weeks ≈ **100,000 order-level delivery
records**, 23 weeks deep, sitting in a column marked `role: 'ignored'`.

> ### What this unlocks
>
> `pct_tardias_reparto` is `num_late_orders / num_orders` — **a binary count**. The blob has
> **the actual minutes**, per order, with its window.
>
> - **Lateness as a distribution, not a count.** Ten orders 2 minutes late and ten orders
>   90 minutes late are identical today.
> - **The protocol's own thresholds become computable**: `Reparto de pedidos` (2025-12-27)
>   targets **>30 min ≤ 5%** and **>60 min ≤ 1%**. Neither can be measured from the weekly
>   files. Both fall out of this field directly.
> - **Lateness by delivery window** — `delivery_window_time` gives the 1–7 window per order.
>   Is the 8pm window structurally worse? Nothing can answer that today.
> - **Early deliveries too** — the field is signed. `num_early_orders` is 99% zeros, which
>   looks like a broken column; the blob would say whether early delivery is real.
>
> ⚠️ Values are **strings with timezone offsets** (`-06:00`) and a **Spanish month
> abbreviation** in `delivery_date_str` (`Ago-7`). Parse `delivered_at` and
> `delivery_window_start_date_time`, ignore the display strings.

### ✅ `num_late_orders`' own threshold, derived from the backfill (Phase 1, 2026-09-09)

Reconciled `order_deliveries` (the flattened `orders_data`) against `num_late_orders` across
7 driver-weeks: **`num_late_orders` = count of orders with `minutes_delivered_late_or_early`
> 10**, exact match every time (14=14, 3=3, 11=11, 3=3, 5=5, 4=4, 15=15). `> 0` overcounts
by 1–4 orders per driver-week (a handful of 1–8-minute-late deliveries that don't count as
"late" in this system); `> 5` was closer but still occasionally off by one. Per-driver-week
order counts also matched `num_orders` exactly in every case (123=123, 94=94, 57=57, 36=36,
50=50, 64=64, 78=78).

⚠️ **This is Retool's own operational "late" cutoff, not the protocol's >30/>60-min targets**
(`Reparto de pedidos`, 2025-12-27, `OPS_CONTEXT.md` §5b). They answer different questions —
`deliveryLateness` (Phase 2) should expose both, not collapse them into one bucket.
🔶 Confirmed at 7 driver-weeks, not yet proven at 98%+ across full history — worth a proper
`reverse-engineer.ts`-style row-level check before leaning on it hard.

### `client_issues_for_driver` ✅ full complaint records
Sparse (8 entries in 200 rows) but complete: `id`, `message`, `subject`, `order_id`,
`patient_id`, `created_at`, `app_location` (e.g. `Pedido entregado > Problema con el
repartidor`). `user_name` and `user_cellphone` are always empty. **`order_id` is the join key
to everything else.**

### `admin_incidents` ✅ RESOLVED — the full incident record
37 entries in 200 rows. Fields: `id`, **`notes`** (free text), **`created_by`** (email),
`fault_date`, `operator_id`, `is_tardy`, `is_absence`, `is_deleted`, `created_at`,
`updated_at`. Real notes: *"NO SOLICITA PERMISO PARA SALIR A COMPRAR COMIDA"*, *"No cuenta
con ticket de gasolina"*. Created by `aux.turno.sn@calii.com`, `abdiel.gonzalez@calii.com`.

**This is the same record `incidentes` holds — with `is_tardy` / `is_absence` booleans that
disambiguate the type, and the author's email.**

### `num_admin_incidents` ✅✅ RESOLVED — it IS the `incidentes` "Otro" count

```
num_admin_incidents = count of incidentes rows [Otro] for this person-week
                                                        99.39% match (n = 1,813)
```

So the two files are **joined**: the driver file's admin-incident count is exactly the
manual-incident rows from `incidentes`. The `admin_incidents` JSON above is those same
records, with the free-text note and author attached.

⭐ Practical consequence: **`incidentes.Tipo de incidente = "Otro"` means an administrative
violation against a person** — permits, missing fuel tickets, procedure breaches — not a
delivery incident. That further narrows what `entregas_erroneas` is drawing from.

---

## `issues_comments` — both files ✅✅ FORMAT CONFIRMED AT SCALE

**The earlier n=9 caveat is resolved.** `scripts/inspect-blob.ts` extracted **375 items** from
200 armador rows and **572 items** from 200 driver rows. **Every sampled entry matches
`Categoría | Producto | Comentario`.**

Extrapolated: ≈ **10,000 product-level customer complaints** across the history, each with a
category, a named product, and the customer's own words — a `split('|')` away.

Categories observed: `Mala calidad`, `Faltante`. Real entries:

```
Mala calidad | Piña miel cortada Calii Fresh 500g | Esta fermentado
Mala calidad | Blueberries caja 170g | Al sacar las frutas, una ya venía aplastada y con moho…
Mala calidad | Naranja nacional | Todas las naranjas completamente verdes y duras
Faltante     | Limón ahorramás | No llego el limón
```

> **This is the product-level quality dimension the dashboard has no KPI for.** Complaints by
> product, by category, by hub, by week — and the driver-side column (the richer of the two at
> 80.1% fill) is read by nothing at all.
92.1% filled, averaging **56.7 entries per driver-week**, stored as JSON, marked
`role: 'ignored'`. José: per-order detail — times, status, possibly items.

This is **the finest grain in the entire database.** If it carries delivery timestamps it
can answer window and lateness questions that nothing else can — `desempeno_repartidores`
otherwise only has weekly counts.

`scripts/inspect-blob.ts` dumps the real structure so we can stop guessing.

---

## `discrepancia`

One row per repartidor per week. 1,718 rows / 20 weeks, 15 columns, 5 read.

### The rails ✅ CONFIRMED
Two live reconciliations, one dead column. The pattern is
`Cálculo digital X` (what the system says the driver collected) vs the counted amount.

| Rail | System says | Counted | Difference | Status |
|---|---|---|---|---|
| **Efectivo** (cash) | `Cálculo digital efectivo` (9,505) | `Conciliación manual` (8,823) | — | ✅ live · **the only one the app uses** |
| **Vales** | `Cálculo digital vales` (5,623) | `Conciliación Clip` (5,746) | `Diferencia vales` (−123) | ✅ live · **read by nothing** |
| Panamericano | — | `Conciliación Panamericano` (**0 in all 330 rows**) | `Diferencia Panamericano` | ❌ **dead / unused** |

**`Conciliación Clip` is how vales get reconciled** ✅ CONFIRMED — that is why the naming
looks asymmetric. There is no `Conciliación vales` or `Cálculo digital Clip`; Clip *is* the
vales counterpart.

> ⚠️ **Correction to `DATA_AUDIT.md` §5 item 1.** I flagged Panamericano as a broken
> reconciliation leg. It is not broken — **the rail is dead and unused.**
> `Diferencia Panamericano` equalling `Cálculo digital efectivo` is just
> `efectivo − 0`. Nothing to fix; the columns should be dropped, not repaired.

### `Diferencia vales` ✅ CONFIRMED (mean-level), 🔶 pending row-level
`= Cálculo digital vales − Conciliación Clip`. José's hypothesis, and the arithmetic holds
exactly: 5,623.20 − 5,746.44 = **−123.24**, which is `Diferencia vales`' mean to the
4th decimal.

**Sign is meaningful.** Negative = Clip counted more than the system expected. Range
−15,002 to +20,025, so both directions occur at real magnitude.

> **There is a whole second discrepancy here that the dashboard never shows.**
> `discrepancia_mxn` covers cash only. The vales/Clip rail moves comparable money
> (5.6k vs 9.5k mean) and is invisible.

### The devoluciones trio ✅ CONFIRMED — **failed deliveries, not payments**
These are counts of merchandise coming back from failed deliveries, not money.

| Column | Mean | Meaning |
|---|---|---|
| `Por devolver` | 1.17 | Failed deliveries **not yet confirmed** as returned to the hub |
| `Devoluciones confirmadas` | 0.45 | **Confirmed** back at the hub |
| `Diferencia devoluciones` | 0.72 | The gap — *went out, never confirmed back* |

`1.1727 − 0.4485 = 0.7242` = `Diferencia devoluciones`' mean exactly. ✅ Derivation
confirmed at mean level, pending row-level check.

**Owner: the Auxiliar de turno (líder) confirms these.** ✅ CONFIRMED

> **This is an accountability metric with a named owner and no KPI.** `Diferencia
> devoluciones` averaging 0.72 per driver-week means roughly 62% of failed-delivery
> merchandise is never confirmed back at the hub. That is either shrinkage or a
> confirmation-process failure, and either way it maps to a specific role.
>
> ❓ OPEN: cross-check against `desempeno_repartidores.num_undelivered_orders` (mean 0.91)
> — same concept, different file, different number. Which is authoritative?

### `ID efectivo` ❓ OPEN
95.8% filled, 84 distinct values, formatted like `1004`, `1007`, `1010`. Looks like a cash
bag or envelope identifier. Unread.

### `Apodo` ✅ low-stakes
Driver nickname, 100% filled, 77 distinct. Marked `free_text` but it is an identifier —
useful for name-joining across files alongside `lib/normalize.ts`'s `normalizeName()`.

---

## `resumen_operativo`

Weekly Retool rollup, one row per hub. 210 rows / 15 weeks (starts 2026-05-01), 20 columns,
8 read.

### ⭐ PRECEDENCE RULE ✅ CONFIRMED

This is a governance rule, not a column definition, and it applies to **any** analysis that
could answer the same question two ways:

> **Global and hub-level numbers → use the `resumen_operativo` Retool figures.**
> **Per-armador, per-repartidor, or any individual measurement → use our entity-derived
> metrics from the person-level files.**
>
> **Tolerance: a mismatch under ~1% is noise — ignore it.** Decimal-level differences are
> not worth chasing. A gap above ~1% is real and worth investigating.

Seven Retool percentage columns duplicate metrics we compute from person-level files, and
all seven are unread today:

`Pedidos con faltantes armador (%)` · `Retrasos armado (%)` · `Retrasos entrega (%)` ·
`Pedidos con incidentes clientes (%)` · `Pedidos con mala calidad (%)` ·
`Pedidos con faltantes cliente (%)` · `Entregas fallidas (%)`

**This makes them a standing correctness check on the whole pipeline** — 15 weeks × 7 hubs
× 7 metrics of ground truth already sitting in the database, against which our computed
hub numbers can be validated automatically. Anything drifting past 1% is a bug signal.

### `Hub` — the CH rows ✅ CONFIRMED
14 distinct `Hub` values for 7 MHs. The extras are **CHs (centros de distribución)**:

- **Only `CH Guadalupe` is active**, and it serves **internal supply only** — it does not
  assemble customer orders.
- **All other CHs are deactivated** and still emit rows.

So dropping every CH row is **correct**, and explains the uniform 50% fill on the percentage
columns (deactivated hubs have no orders). This is documented behaviour now, not a defect.
Matches the original seed comment "CH Guadalupe excluded entirely".

`Pendiente entrega (#)` being 0 in all 56 rows is consistent with this.

---

## `desempeno_operadores` — process compliance

### `num_orders_with_missing_barcode` · `num_orders_with_missing_expiration_date` · `num_orders_with_pending_confirmation` ✅ CONFIRMED
**Steps the armador skipped while picking.** All three 100% filled, all three unread.

| Column | Mean | Max |
|---|---:|---:|
| `num_orders_with_missing_barcode` | 1.11 | 36 |
| `num_orders_with_pending_confirmation` | 1.19 | 36 |
| `num_orders_with_missing_expiration_date` | 0.23 | 35 |

This is a **process-discipline dimension with an unambiguous owner** — the armador — and
the app has no KPI for it. It is also a plausible **leading indicator**: an armador skipping
scans is more likely to produce faltantes and mala calidad downstream, and that is testable
against the existing per-person history.

❓ OPEN: all three share a max near 36, which suggests a shared ceiling (probably orders
assembled that day/week). Worth confirming they are bounded by `num_assembled` before
treating them as independent.

### `receives_bonus` ⚠️ LEGACY — reflects an obsolete formula ✅ CONFIRMED
100% filled, boolean, unread.

**Bonuses used to be calculated automatically, and this column is the output of that old
calculation.** The parameters and rules have since changed, which is *why* the KPI
dashboard exists — to support the human decision that replaced the automatic one.

> **Do not read this as current bonus eligibility.** It records what the retired formula
> would have decided. It could still be interesting as a historical comparison — "what
> would the old rule have paid, versus what the new rules imply" — but never as a live
> signal.

> **This also states the app's purpose, which is worth writing down:** the dashboard is a
> *decision-support tool for performance and bonus judgements that used to be automatic.*
> That is the frame the task-suggestion and chat features should be designed against —
> the output has to support a decision a person is about to make about a specific
> armador, repartidor or hub, not just describe last week.

### `order_total_multiplier` ❓ OPEN
73.2% filled, range 0.43–1.04, mean 0.98, never zero, hard ceiling just above 1.
José: unknown. Already a `scripts/reverse-engineer.ts` target — the tight range and hard
ceiling should make it identifiable from the other columns.

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
