# Calii Ops — Operations Context

**Why it exists:** `ASSISTANT_DESIGN.md` §2 showed that the most valuable half of an answer
— *"there might be an issue with the herbs cold room in Cumbres"* — cannot be derived from
any dataset. It requires knowing what is physically in a hub, who does what and when, and
what breaks. This file is where that lives.

Conventions as in `DATA_DICTIONARY.md`: ✅ CONFIRMED · ⚠️ CORRECTED · 🔶 ASSUMED · ❓ OPEN.

**Session 1 — 2026-09-09.** Personnel · cross-cover · layout · assembly process ·
delivery process. Source: José, direct.

---

## 1. Personnel ✅ CONFIRMED

Two shifts everywhere. Per hub:

| Role | Count | Responsibility |
|---|---|---|
| **Armador** | 4–9 **per shift** (scales with hub size) | Picking client orders |
| **Repartidor** | 5–9 **per shift** | Delivering to clients |
| **Auxiliar de inventarios** | 1 per hub | Inventory for **Graneles y Abarrotes + Carnes** (fresh & frozen) |
| **Auxiliar de calidad** | 1 per hub | Inventory for **Frutas y Verduras** only |
| **Auxiliar de turno (líder)** | 1 **per shift** | Direct supervisor of armadores + repartidores; the coordinator's eyes, ears and hands on the floor |
| **Coordinador** | 1 per hub, full shift | Supervising, auditing, coordinating, big picture |

### Auxiliar de inventarios — daily tasks
Daily confirmations · receiving product (from CH **and** external suppliers) via barcode
scanner + counting · organising the hub · placing product in exhibition · FIFO checks ·
expiry-date checks · **registering MNA for G&A and Carnes**.

### Auxiliar de calidad — daily tasks
Daily inventory check of **all** produce · receiving from CH · organising cold rooms ·
expiry checks · rejecting product below quality standard · **registering MNA for FyV**.

> **Two different people register MNA**, split by category. `aux_inventarios` owns G&A +
> Carnes; `aux_calidad` owns FyV. A category-specific MNA anomaly therefore points at a
> specific person in a specific hub. This matches the existing `kpis.owner_role_id`
> assignments — `mna_fyv_pct` → `aux_calidad`, the rest → `aux_inventarios`.

### Auxiliar de turno — what they actually do
Constantly helping when **an item is not found** · quality doubts · watching for assembly
delays · **re-assigning orders** · **refilling the ops room from stock rooms when it runs
out** · checking drivers' orders before departure (verifying correctness) · on call with
drivers.

There is also a **Driver Ops team** connecting clients with drivers, but drivers still lean
on the líder de turno heavily since that is their supervisor.

> **Three of these tasks are direct faltantes mechanisms** — see §4.

---

## 2. Cross-cover: who fills in for whom ✅ CONFIRMED

| Role | Also does |
|---|---|
| **Armador** | Owns one or more **assigned aisles or freezers** — keeps them stocked, checks expiry + FIFO, cleans. Secondary to picking, and does **not** exempt aux de inventarios from aisle setup. |
| **Aux de inventarios** | **Assembles when needed — and is the FIRST to be pulled in** when there are too many orders, absent armadores, or new armadores with low velocity. |
| **Aux de turno** | Can cover other auxiliares — receiving, confirming inventory, etc. |
| **All auxiliares** | Interchangeable in principle. |
| **Armadores ↔ Repartidores** | ❌ **Never.** Drivers don't assemble, assemblers don't drive. Rare driver-assembles cases exist — treat as non-existent. |

### Auxiliar headcount per hub ✅ CONFIRMED — the canonical rule

⚠️ **CORRECTED.** An earlier draft recorded "Auxiliar de Recibo" as a 7th role active only
at Zapopan and Condesa, on the strength of an `Auxiliar Recibo Contry` account in the data.
**Wrong on both counts.** The real rule is a headcount, and the account names are unreliable.

| Hub | Auxiliares (excluding líderes) |
|---|---:|
| **Zapopan** (GDL) | **3** |
| **Condesa** (CDMX) | **3** |
| Contry · Cumbres · San Nicolás · Guadalupe · Avícola | **2** |

Composition:

- **Auxiliar de Inventarios — every hub.** G&A + Carnes. Consistently named.
- **The FyV / receiving auxiliar — every hub.** ⚠️ **Named inconsistently**: *recibo*,
  *recepción*, *calidad*, or *recibo y calidad*, depending on the hub.
- **Zapopan and Condesa carry a third**, splitting receiving from the other two — they
  receive **mainly direct from suppliers** plus **one bulk order from MTY per week**.

Separately, and not counted above: **2 líderes de turno** (one per shift) and
**1 coordinador**, at every hub.

> ### Do not infer the role from the account name
>
> `Auxiliar Recibo Contry` is **Contry's FyV auxiliar**, not evidence of a third role at
> Contry. Contry has 2 auxiliares like every other MTY hub.
>
> **The role assignment comes from this table, not from parsing the string.** Account names
> should be used only to *detect that a row is a role account at all* — which is why the
> pattern in `scripts/role-accounts.ts` is deliberately broad. The census then becomes a
> **validation**: expect 2 role accounts per hub, 3 at Zapopan and Condesa. More means
> duplicate or stale logins; fewer means a hub is sharing one.

> **Two consequences, pulling in opposite directions:**
>
> 1. **More capacity** — an extra pair of hands on inventory-adjacent work, so all else equal
>    these hubs should show *better* inventory quality.
> 2. **A higher bar** — José: *"could mean more expected from them in regards to inventories
>    and other tasks."*
>
> Either way, **comparing Zapopan or Condesa against the MTY hubs on MNA, faltantes or any
> inventory-quality KPI without accounting for the extra headcount is not a like-for-like
> comparison.** Second concrete instance of the "hubs are not comparable" rule — after
> Guadalupe's layout, now staffing.

> ### The inbound supply chain also differs ⭐
>
> Zapopan and Condesa receive **mainly direct from suppliers + one weekly bulk order from
> MTY**. That is a fundamentally different replenishment rhythm from the MTY hubs
> (❓ their inbound cadence not yet captured).
>
> **A weekly bulk cycle changes what stock-cover numbers mean.** `Días de inventario`,
> `Consumo / día` and stockout risk all behave differently under weekly replenishment than
> under frequent top-ups — a hub on a weekly cycle *should* carry more days of cover, and a
> late or short weekly order has a whole week of consequences rather than a day's.
>
> This may be a better explanation for cross-hub MNA and faltantes differences than anything
> about the people, and it is currently invisible to every comparison the app makes.

### ⚠️⚠️ CORRECTED — aux assembly is SCHEDULED, not emergency flex

`Protocolo: Actividades de Auxiliares de Inventario y Calidad` (mod 2026-04-17) documents
aux assembly as a **planned weekly rota on high-demand days**, not a break-glass response.

**High-demand days ✅ CONFIRMED: weekends, Monday and Tuesday.**

| | Task | Hours | Orders |
|---|---|---:|---|
| **Mon–Tue · Aux Inventario** | **Armado (06:00–10:00)** | **4.00** | **16–18** |
| | Recepción y acomodo | 2.00 | |
| | Inventario, MNA | 1.50 | |
| | Comida | 0.50 | |
| | **Total** | **8.00** | |
| **Mon–Tue · Aux Calidad** | **Armado (12:00–15:00)** | **3.00** | **12–14** |
| | Recepción y acomodo | 2.00 | |
| | Inventario, MNA | 2.50 | |
| | Comida | 0.50 | |
| | **Total** | **8.00** | |
| **Sunday · Aux Inventario *or* Calidad** | **Armado (10:00–14:00)** | **4.00** | **16–18** |
| | Inventario, MNA | 2.50 | |
| | Comida | 0.50 | |
| | **Total** | **7.00** | |

Mechanics: profiles are flagged **`Armador temporal`** in Retool *Personal*; orders are
**auto-assigned** once they register attendance; and
**"estos perfiles activos no se sumarán al cálculo automatizado de capacidades de armadores"**
— they are excluded from the armador capacity calculation.

> ### What this does to the hypothesis
>
> **The mechanism survives, but the signal changes completely.**
>
> On Mondays and Tuesdays the Aux de Inventario spends **4 of 8 hours assembling and 1.5 on
> inventory and MNA** — by design. So inventory work is structurally squeezed on the two
> busiest weekdays, every week. That is a *systematic* pressure, not an incident.
>
> **The detectable signal is therefore DEVIATION FROM THE ROTA, not aux assembly per se:**
>
> - An aux assembling on a **Wednesday** — off-rota — is the real emergency signal.
> - An aux assembling **well beyond 16–18 orders** on a Monday is over-extension.
> - An aux **not** assembling on a Monday means someone else absorbed it.
>
> Treating any aux assembly as a stress marker would flag every hub every Monday and find
> nothing. **`scripts/role-accounts.ts`'s week-by-week grid is what separates rota from
> deviation** — and the daily pattern needs a day-level view the weekly files cannot give,
> which makes the rota itself a reason to want finer-grained data.
>
> It also predicts something testable and unexplored: **MNA and faltantes should show a
> weekday pattern tied to Mon/Tue**, since that is when inventory work is compressed.

### The chain itself

> **Rota (Mon/Tue/weekend) or off-rota pull-in → aux hours diverted from inventory →
> inventory tasks compressed → MNA ↑ and faltantes ↑ with a lag.**

Every link has data behind it:

| Link | Data available |
|---|---|
| Absences | `desempeno_operadores.num_absences` (unjustified) — currently inert |
| New / low-velocity armadores | `person_tenure` (286 rows, the Modo Entrenamiento ledger) + `tasa_armado` |
| Aux pulled to assembly | ✅ **CONFIRMED — the aux appears in `desempeno_operadores` as a normal armador row**, with their own `num_assembled`, `tasa_armado`, etc. |
| Inventory tasks skipped | ❓ no direct signal |
| Consequence | `mna_pct`, `faltantes_armador_pct`, with a lag |

> **The chain is measurable end to end, and no roster is needed.** ✅ CONFIRMED from the data:
> **auxiliares appear under role-named accounts, not personal names**, with the hub in the
> string. Observed in `desempeno_operadores.assembler`:
>
> - `Auxiliar Inventarios SN ("AI")`
> - `Auxiliar Calidad SN ("AC")`
> - `Auxiliar Recibo Contry ("AR Contry")`
>
> Also in `incidentes.Operador`: `Auxiliar Turno Vespertino Condesa`,
> `Coordinador MH Condesa`, `Auxiliar Turno Matutino Avícola`.
> And in `incidentes.Responsable`: `aux.turno.sn@calii.com`, `aux.inventario.sn@calii.com`.
>
> A name pattern (`^Auxiliar|^Coordinador|^Aux `) identifies them. **Contrast:**
> `faltantes_armador.Armador` (95 distinct) and `desempeno_repartidores.driver_name`
> (83 distinct) show **no** role-named accounts in their top values — those look like real
> people only.
>
> ### ⭐ Better than a flag: a continuous measure
>
> The aux accounts appear **4 times in a 4-week window — i.e. every week.** So the question
> is not *"was an aux pulled in?"* but **"how much did the aux assemble this week?"**
>
> **`num_assembled` on the aux row is a per-hub, per-week flex-intensity measure**, directly
> comparable across hubs and over time. A continuous signal, not a binary — much stronger
> input to the absences → MNA/faltantes hypothesis.

### ❓ Contradiction to resolve: do aux accounts generate faltantes?
`faltantes_armador.Armador` shows no role-named accounts in its top 8 (95 distinct total),
yet those accounts assemble every week. Either they appear further down the list, or
faltantes reported during aux-assembled orders are attributed elsewhere.

**This matters for the denominator.** If aux-assembled orders sit in `num_assembled` but
their faltantes land on someone else — or nowhere — then `faltantes_armador_pct` is
distorted at exactly the hubs and weeks where aux assembly is highest. Which is precisely
when the flex chain predicts problems.

**This is exactly the "cross the weekly files to find a root cause invisible in one view"
case from `ASSISTANT_DESIGN.md` §7.4.** It is the first testable multi-file hypothesis this
project has, and it comes with its mechanism already supplied.

---

## 3. Layout ✅ CONFIRMED

**Every hub has a distinct layout.** Calii did not build the warehouses and adapts to what
each has. Similarity is a goal, not a fact.

### Graneles y Abarrotes
- **Estantes** (racking), several types, mostly ~2 m tall, some wider than others.
- Level counts **vary per estante, and each hub configures its own** — a Coca-Cola and a
  cereal box need different level spacing, so uniform spacing wastes space.
- Product is displayed **piece by piece** — no boxes, no separators.
- High-count items may keep **a stock box on the top level of the same estante**.
- **Hubs that invested time here have fully optimised some aisles into pure exhibition with
  essentially no stock.** So exhibition capacity — and therefore how often something runs
  out mid-shift — **varies by hub and by how much optimisation work that hub has done.**

### Carnes
- **Cold room for frescos** (lácteos: cheese, yoghurt, butter) — target **1 °C**. Internally
  organised like G&A.
- **Freezers: 10–16 per hub**, horizontal (**ataúd**) type. Vertical freezers were rejected —
  *"they crash down a lot"*.
- Custom **vertical dividers** give roughly **21–24 SKU locations** per hub in frozen.
  → Frozen assortment is **capacity-bounded** and the bound differs per hub.

### Frutas y Verduras — 4 rooms per hub (except Guadalupe)

| Room | Temp | Purpose |
|---|---|---|
| **Stock 1** | 4 °C | Produce stock |
| **Stock 2** | 8 °C | Produce stock — two temperatures because products differ; the *coordinador de calidad* dictates what goes where |
| **Ops** | 12 °C | **Exhibition/picking room** — the largest refrigerated room, estantes + levels. **Aux de turno restocks it from the stock rooms when it runs out.** |
| **Hierbas** | 2 °C | **All herbs. Both stock AND exhibition.** Sits **inside** the ops room (all other rooms open onto the main warehouse floor) |

Some items live on the **main warehouse floor**, unrefrigerated — potatoes, jícama, etc.

> ### ⭐ The herbs room is a single point of failure
>
> **Hierbas is the only FyV room that is simultaneously stock and exhibition.** Every other
> category has a stock buffer behind its exhibition. Herbs do not.
>
> It also runs at **2 °C — the coldest FyV room**, and sits inside the 12 °C ops room rather
> than opening onto the floor.
>
> **Consequence: a temperature failure in hierbas hits the entire herb assortment at once,
> with no buffer.** That is precisely the signature in José's Cumbres example — *all* herbs
> spiking together in one hub, in one week. The hypothesis is structurally sound, not a
> lucky guess.

### ⚠️ Guadalupe is structurally different — do not peer-compare it on FyV

- **No stock rooms.** One huge ops room instead.
- **Hierbas shares with lácteos** → herbs sit at the lácteos target of **1 °C, not 2 °C**.
- **MH Guadalupe sits inside CH Guadalupe** — no walls, everything shared.
- Items like avocado are stored **"outside the MH"**, in the adjoining CH warehouse.

> **Encodable rule.** Any FyV comparison — merma, faltantes, stockouts — that ranks Guadalupe
> against the other six hubs is comparing different physical systems. Guadalupe has no stock
> buffer, a different herb temperature, and product held outside its own four walls. Flag or
> exclude it; never silently rank it.
>
> This is the first concrete instance of the "hubs are not comparable" caveat from
> `DATA_DICTIONARY.md`, and it is specific enough to implement.

---

## 4. The assembly process ✅ CONFIRMED

### 4.1 Timeline

| | Weekday | Weekend |
|---|---|---|
| **AM shift assembly** | 06:00 – 14:00 | 08:00 – 16:00 (single shift) |
| **PM shift assembly** | 14:00 – 20:00 | — |
| **Delivery windows** | 08:00–10:00, 10:00–12:00, … 20:00–22:00 | 10:00 – 18:00 |

- Each delivery window is **assembled up to 2 hours before** it opens.
- **Orders are assigned to an armador 1 hour before their assembly window begins** —
  05:00 for the 06:00 block, 07:00 for the 08:00 block, and so on.
- **Orders arriving mid-window are auto-assigned to whoever currently has the fewest.**
- Customers can order until **~10 minutes before a window opens** — order at 09:49 and you
  make the 10:00 window; at 09:51 you are pushed to 12:00.

> 🔶 **Derivable, and worth deriving:** assembly runs ~2 h ahead of delivery, so the AM shift
> (06:00–14:00) assembles roughly windows 1–4 and the PM shift (14:00–20:00) windows 5–7.
> Combined with the order code (§4.4) this gives **shift attribution per order** — far more
> precise than the `avg_start_time` approximation.

### 4.2 The assembly app — step by step

1. Armador selects an order and **starts** it.
2. Items appear sorted by **picking route: FyV → Carnes → G&A** (matches the physical layout).
3. Per item: select it → **scan barcode** (if available) → **type expiry date** (if available)
   → enter **number of pieces**.
4. If the barcode is wrong or unreadable, there is an **explicit option** for that.
5. On finish: bag everything, place in delivery boxes, enter **number of boxes**.
6. That **auto-prints `boxes + 1` labels** — one per box, one for the top bag. Each carries
   customer name, order id, a barcode (**not currently used**), and `1/n`.
7. Boxes go to their **assigned location in the ops room**.

### 4.3 Faltantes — the two types, and the authorization gap ⭐

| Type | What it means | Billing |
|---|---|---|
| **Faltante armador** | Item unavailable — wrong inventory, bad quality, expired, or fails the customer's specific notes | Customer **not charged** |
| **Faltante parcial** | Only part of the ordered quantity exists — the armador digitalises only what was picked | Charged for what shipped |

A **free-text note should always be added** when marking a faltante armador — this is
`faltantes_armador."Notas armador"` (95.3% filled, armador-typed, `DATA_DICTIONARY.md`).

> ### ⭐⭐ Faltantes % is partly an AUTHORIZATION-COMPLIANCE metric
>
> ✅ José, verbatim: *"it has to be authorized by the auxiliar de turno (they must look for
> it first or confirm it doesn't meet standards, **this is important for comparing one
> assembler with others, common issue is they don't confirm it and their % is way
> higher**)."*
>
> **This may be the single most important fact in this document.**
>
> The required flow is: armador finds nothing → **calls the aux de turno** → aux searches
> for it or confirms it fails standards → *then* the faltante is marked. An armador who
> skips that step registers faltantes the aux would have found, and their percentage rises
> **without any real difference in product availability.**
>
> So `faltantes_armador_pct` blends three different things:
>
> 1. Genuine stockout — `Inventario disponible = 0` (30.2% of events)
> 2. Genuine pick failure — product present but not findable
> 3. **Authorization non-compliance — the armador never asked**
>
> **This is a direct candidate answer to "why is Contry near 20% while others are below
> 10%?"** It could be a behavioural/process-compliance difference, not an inventory one —
> and it is testable *per armador*, since compliance is a personal habit and should cluster
> by person rather than by hub.
>
> ### ❌ The authorization is NOT recorded ✅ CONFIRMED
>
> It is a **verbal/physical step only** — the armador calls the aux, the aux searches, and
> nothing about that exchange enters the app. So an unauthorized faltante is **byte-for-byte
> identical** to a real one.
>
> **This is the highest-value missing field in the entire system.** One boolean —
> *"authorized by"* — on the faltantes record would split a top-5 KPI into a genuine
> availability problem and a behavioural one, and it would do so per armador. Worth raising
> with whoever owns the assembly app; everything below is a workaround for its absence.

### 4.3b Detecting unauthorized faltantes without the field 🔶 PROPOSED — not yet validated

Since compliance is a **personal habit**, it should cluster **by armador**, not by hub.
Three signals, in decreasing strength:

1. **Peer deviation within hub-week.** Restrict to `Inventario disponible > 0` (drop genuine
   stockouts), then compare each armador's faltante rate against their own hub's other
   armadores that same week. Same hub, same stock, same days — most confounders cancel.
2. **Product overlap.** Does armador A mark faltantes on products that nobody else at that
   hub fails on that week? A product only *one* person can't find is a person signal, not a
   stock signal.
3. **Persistence across weeks.** A habit is stable; a bad stock week is not. An armador
   consistently above their hub's peers over many weeks is the strongest available evidence.

> ⚠️ **Honest limitation.** We have the **failures** (`faltantes_armador` events) but not the
> **successes** — nothing records "armador B picked product P fine." So true exposure per
> armador per product is unknown, and these are **relative** comparisons, never rates.
> They can rank armadores by suspicion; they cannot say "X% of A's faltantes were avoidable."
>
> This keeps the Causal axis at 🔶 (`ASSISTANT_DESIGN.md` §3) no matter how clean the numbers
> look. The output must say so.

### 4.3c ⭐ Undeclared shortfalls — a metric that does not exist today

✅ CONFIRMED: **armador-marked and customer-reported faltantes are different things.**

| Column | File | Who says so |
|---|---|---|
| `num_orders_with_faltante_armador` | `desempeno_operadores` | **The armador**, at pick time — customer not charged |
| `num_orders_with_full_missing` · `num_orders_with_partial_missing` | `desempeno_operadores` | **The customer**, after delivery |

> **The gap between them is a quality signal nobody computes.** An order where the armador
> declared nothing but the customer later reported missing items is an **undeclared
> shortfall** — strictly worse than a declared faltante, because the customer was charged
> and then let down, rather than being told up front.
>
> A declared faltante is the process working. An undeclared one is the process failing
> silently. **Today both are buried inside separate KPIs and never compared.**
>
> ⚠️ Note this also means `incidentes_faltantes_completos_pct` and
> `incidentes_faltantes_parciales_pct` are **customer-outcome** KPIs, despite sharing the
> word "faltante" with the armador's in-app action. The naming collision is a real trap for
> anyone reading the dashboard.

### 4.4 Order ID structure ⭐ — an unexploited key

Format: **`W3-A4-1`**

| Part | Meaning |
|---|---|
| `W3` | 2 random alphanumeric characters |
| `A4` | **Location in the ops room** — aisle A, spot 4. Aisles `A`–`I`, spots `1`–`9`, all floor level, laid out for fast driver pickup. Assignment differs per hub. |
| `1` | **Delivery window** — `1` = 08:00–10:00 |
| `X` | **Express** delivery (in place of the window digit) |
| `U` | **App delivery** — Uber Eats, Rappi, Didi |

> **`incidentes.Notas` already contains these codes** — `INCIDENTES_ORDER_CODE_RE`
> (`/#?[A-Z0-9]{1,2}-[A-Z]\d-\d/i` in `lib/kpi-compute.ts:386`) matches them, and the
> `entregas_erroneas` KPI is built by regexing for exactly this pattern.
>
> **But only the presence of a code is used — never its content.** Parsing the third
> segment would immediately give, for every incident:
>
> - **the delivery window** it belongs to → are incidents concentrated in the 06:00 rush?
>   the last window of the day?
> - **whether it was express (`X`) or app-delivery (`U`)** → do Uber/Rappi/Didi orders fail
>   more than own-app orders? Nothing in the app can currently answer that.
> - **the ops-room location** (`A4`) → useful for driver-pickup analysis.
>
> ### ⚠️⚠️ CORRECTED 2026-09-09 — the `X` / `U` reading was wrong
>
> I proposed "X = express, U = app delivery, both replacing the window digit", José confirmed
> it, **and it was my framing that was wrong.** `Protocolo: Pedidos Express` gives the actual
> Express format:
>
> > *"Los IDs de los pedidos Express seguirán el siguiente formato:* `ZO-X1-U`
> > *[dos caracteres alfanuméricos aleatorios]-[**posición física**]-[**identificador de socio
> > repartidor**]"*
>
> So in an Express ID:
>
> | Segment | Normal order | Express order |
> |---|---|---|
> | 1st | random 2 chars | random 2 chars |
> | 2nd | ops-room position (`A4`) | **Express staging position (`X1`)** — `X` is a *position prefix*, not an order type |
> | 3rd | **delivery window 1–7** | **delivery-partner letter** (`U` = Uber) |
>
> **José's "U replaces the digit" is right. "X replaces the digit" is not** — `X` lives in the
> *position* segment because Express orders stage on their own shelf.
>
> 🔶 Rappi and DiDi presumably carry their own trailing letters (`R`, `D`?) — **documented
> only for Uber**. Extract the real distribution of third-segment values from
> `incidentes.Notas` before writing any parser.
>
> ✅ **Windows are sequential 1–7 for normal orders** — that part stands.
>
> ### ✅ The complete code scheme — José, 2026-09-09
>
> | Order type | 2nd segment (position) | 3rd segment |
> |---|---|---|
> | **Normal** | aisle + spot, `A5` / `B6` | **window `1`–`7`** |
> | **Express** | **`X`** + spot — Express has its own staging area | **always `U`** |
> | **Pickup** | aisle + spot, normal logic (`A5`, `B6`) | **`P`** |
> | **Marketplace** (Uber Eats / Rappi / DiDi) | — | **no code and no label at all** |
>
> ⚠️ **Marketplace orders are invisible, not differently-coded.** They never enter the Calii
> order system, get no label printed, and their stats live in the platforms' own tools. So
> they cannot be counted, filtered *or* excluded from our data — they simply are not in it.
> Any attempt to reconcile hub order totals against platform sales will fail for this reason.
>
> ✅ **`U` is always Uber for Express** — the earlier 🔶 speculation about Rappi/DiDi letters
> is void. There are no other partner letters.
>
> ⭐ **`P` for pickup is new** — a fourth population nobody has mentioned before, and one that
> presumably generates **no delivery record at all** (the customer collects). Any driver-side
> denominator built from hub order counts needs to exclude them. ❓ How large is pickup volume?
>
> | Code | Delivery window |
> |---|---|
> | `1` | 08:00 – 10:00 |
> | `2` | 10:00 – 12:00 |
> | `3` | 12:00 – 14:00 |
> | `4` | 14:00 – 16:00 |
> | `5` | 16:00 – 18:00 |
> | `6` | 18:00 – 20:00 |
> | `7` | 20:00 – 22:00 |
> | `X` | Express |
> | `U` | App delivery (Uber Eats / Rappi / Didi) |
>
> **The parser is trivial and the payoff is immediate** — every incident note carrying an
> order code yields a window, an order type, and (via §4.1) the shift that assembled it.
> Three dimensions the app has never had, from a regex it already runs.

### 4.5 ⚠️ `tasa_armado` measures assignment-to-completion, not picking speed

✅ José: *"Assembly rate is calculated **since the order is assigned, not when they start
it**, so if they leave an order waiting there one hour, that will heavily affect their
rate."* (Set before he joined; he is not sure he agrees with it.)

> **This confounds the KPI with queue depth.** An armador assigned six orders at 05:00 and
> working them sequentially accrues waiting time on numbers two through six — through no
> fault of their own. Assign more orders per person and the measured "rate" degrades even
> though the picking is identical.
>
> Consequences:
>
> - `tasa_armado` is **not** a clean speed measure. It mixes picking speed with **how many
>   orders were queued on that person** — which is a scheduling decision, not a performance one.
> - It is therefore **partly a measure of the assignment algorithm**, and comparing armadores
>   across hubs with different volumes per head is unfair in a direction nobody controls for.
> - **Modo Entrenamiento's ramped `tasa_armado` targets for new armadores** inherit this —
>   a new armador on a busy day looks worse for reasons unrelated to training.
>
### 4.5b 🔶 There appear to be TWO clocks, and the gap between them is waiting time

José does not know whether `total_num_min_of_assembly` uses the assignment-start clock.
**The audit numbers suggest the file contains both clocks side by side.** Means from the
4-week profile:

| Column | Mean | Implied min/order |
|---|---:|---:|
| `num_assembled` | 35.24 | — |
| `total_num_min_of_assembly` | 1,017 | **28.9** |
| `backcompat_avg_min_per_assembly` | 29.56 | 29.56 |
| `avg_min_per_assembly` | **7.56** | **7.56** |
| `normalized_num_assembly_minutes` | 570 | 16.2 |

`backcompat_avg_min_per_assembly` × `num_assembled` ≈ 1,042, against
`total_num_min_of_assembly` at 1,017 — close enough to suggest they are the same clock.
And `avg_min_per_assembly` sits at **a quarter of that**.

> **Hypothesis (🔶 — mean-level only, NOT validated):**
> `total_num_min_of_assembly` / `backcompat_avg_min_per_assembly` run on the
> **assignment clock** (~29 min/order), while `avg_min_per_assembly` is **hands-on picking
> time** (~7.6 min/order).
>
> If that holds, **roughly three quarters of the measured assembly time is an order sitting
> in a queue, not being picked** — and the difference between the two columns is a directly
> computable **waiting-time metric per armador per week**, which would isolate the queue-depth
> confound out of `tasa_armado`.
>
> ⚠️ These are means over columns with **different fill rates** (100% / 73.2% / 70.1%), so
> cross-multiplying them is indicative only. Added as `scripts/reverse-engineer.ts` targets —
> the 98% rule decides it, not this arithmetic.

### 4.6 Faltantes causes — now four, not three

From roles, layout and process combined:

1. **Ops room ran out, stock room has it** — restocking latency, owned by the **aux de turno**.
2. **Assigned aisle not kept stocked** — the **armador** who owns that aisle.
3. **Product misplaced or unfindable** — the aux de turno's "helping when an item is not
   found" task.
4. **⭐ Authorization skipped** — the armador never called the aux (§4.3). *Behavioural, and
   the only one that clusters by person rather than by hub.*

Cause 4 is separable from 1–3 **if** the authorization is recorded. `Inventario disponible`
already splits genuine stockouts (30.2%) from the rest. Causes 1–3 remain indistinguishable
without location or timing data.

---

## 5. The delivery process ✅ CONFIRMED

### 5.1 Route assignment

- Drivers arrive **07:30**; routes assigned **07:40**.
- Load depends on driver count vs order count, capped at roughly **8–9 orders per window per
  driver**. Occasionally more when short-staffed — **rare now that Uber Direct was added as
  a 3PL**.
- The driver app shows a list: customer name, order code, box count, address.
- Driver collects orders from the ops room **using the location segment of the order code**
  (`A4` in `W3-A4-1` — see §4.4), pushes them to the loading dock, loads the van.

> ### Uber Direct — ⚠️ CORRECTED: not a break, a permanent gap
>
> ✅ CONFIRMED: Uber Direct **pre-dates this data entirely (before March 2026)**. So there is
> **no discontinuity to mark** — good news, all 20 weeks are on the same footing.
>
> But the standing caveat remains: **`desempeno_repartidores` only ever sees Calii drivers.**
> Orders delivered by the 3PL are invisible there, permanently. So per-driver load understates
> true demand, and it understates it *most* in the busiest weeks — exactly the ones worth
> studying.
>
> ### ⭐ That gap is itself a derivable metric
>
> ```
> Uber Direct volume ≈ pedidos_entregados (resumen_operativo, all orders)
>                      − Σ num_orders across that hub's drivers
> ```
>
> Nobody computes this. It would give **3PL share per hub per week** — a direct read on how
> often a hub outran its own delivery capacity, and a natural thing to test against absences
> and staffing.
>
> ⚠️ Two cautions before trusting it: the `resumen_operativo` precedence rule
> (`DATA_DICTIONARY.md` — Retool is authoritative at hub level, ±1% tolerance), and **do not
> confuse Uber Direct with the `U` order code.** `U` = an order *placed* through Uber Eats /
> Rappi / Didi. Uber Direct = a Calii order *delivered* by a 3PL driver. Different things
> that share a word.

### 5.2 On route

- **The app's sequence is mandatory.** Skipping an order or starting out of order
  **generates an incidente**.

> `desempeno_repartidores.num_admin_incidents` (mean 0.15, 89% zeros, inert) counts
> **any administrative violation** ✅ CONFIRMED — route-sequence breaks are one kind, not
> the whole category.
>
> The matching JSON column **`admin_incidents`** (11.3% filled, ~1.35 entries each) should
> hold the categories. It is a `scripts/inspect-blob.ts` target — once we can see the
> category list, sequence violations become separable from the rest.
>
> Worth testing once split: **do sequence-skippers also produce more entregas erróneas?**
> Both are "not following the process at the handover step", and if they travel together
> that is one behaviour to coach, not two.
- At the customer: ring the bell and/or call.

### 5.3 Entrega fallida — a protocol with a verification burden

1. Wait **10 minutes**, call **3 times**.
2. **Notify Driver Ops before marking it.**
3. Upload **a photo of the house** and **a screenshot of the 3 failed calls**.
4. Return the boxes to the hub, unload them into the **assigned cold room**.
5. **The aux de turno verifies and disassembles them later.**

> ### ⭐ This closes the loop on the discrepancia devoluciones columns
>
> Step 5 is exactly the trio confirmed in `DATA_DICTIONARY.md`:
>
> | Column | Mean | Now understood as |
> |---|---:|---|
> | `Por devolver` | 1.17 | Failed deliveries returned but **not yet verified** by the aux de turno |
> | `Devoluciones confirmadas` | 0.45 | **Verified** back at the hub |
> | `Diferencia devoluciones` | 0.72 | **Returned to the van but never confirmed back at the hub** |
>
> **A cross-file consistency check falls out of this for free:**
> `desempeno_repartidores.num_undelivered_orders` (mean **0.91**) and
> `discrepancia."Por devolver"` (mean **1.17**) describe the same events from two different
> files. They are the same order of magnitude but not equal. Reconciling them per
> driver-week either validates both pipelines or finds a real gap — and nobody has ever
> compared them.

### 5.4 Entregas erróneas — confirmed cause ⭐

✅ José: at handover the driver must verify **name, order id and box count** against the box
labels. *"This is where errors usually come up, entregas erróneas are caused by not paying
attention, they grab another order or leave one box behind **when they have all the info
available**."*

Two distinct failure modes:

| Mode | What the customer experiences |
|---|---|
| **Wrong order handed over** | Someone else's groceries |
| **A box left behind** | Their order, incomplete — **reads as missing items** |

> ### ⭐⭐ Armadores are being scored for driver errors
>
> **A box left behind produces a customer complaint that is indistinguishable from an
> armador mis-pick.** Yet `incidentes_faltantes_pct`, `incidentes_faltantes_completos_pct`
> and `incidentes_faltantes_parciales_pct` are all computed from `desempeno_operadores` —
> i.e. **attributed to the armador**.
>
> **But the same columns exist on BOTH files:**
>
> | Column | operadores | repartidores |
> |---|---:|---:|
> | `num_orders_with_missing_items` | 0.62 | **1.12** |
> | `num_orders_with_partial_missing` | 0.14 | **0.33** |
> | `num_orders_with_full_missing` | 0.49 | **0.83** |
> | `num_orders_with_bad_quality` | 0.92 | **2.09** |
>
> So a complaint appears to be recorded against **both people who touched the order**, and
> only the armador side feeds a KPI. The driver side is entirely inert.
>
> ### The bipartite separation — a real method the data supports
>
> Every order links exactly one armador to one driver. That makes complaints a **bipartite
> graph**, and the two failure modes have opposite signatures:
>
> - A **driver** who leaves boxes behind accumulates complaints across **many different
>   armadores** → the complaint follows the *driver*.
> - An **armador** who mis-picks accumulates complaints across **many different drivers** →
>   the complaint follows the *armador*.
>
> Aggregate one week of pairings and the attribution separates statistically. **This is
> exactly the "cross the weekly files to find what one view cannot show" case** —
> and today the entire driver half of the evidence is unread.
>
> ❓ **Whether the same complaint is written to both rows is unknown** — José does not know,
> and it decides whether the bipartite method works at all.
>
> **The test is cheap and needs no new data.** If a complaint hits both rows, then for any
> hub-week:
>
> ```
> Σ num_orders_with_missing_items over that hub's ARMADORES
>   should ≈
> Σ num_orders_with_missing_items over that hub's DRIVERS
> ```
>
> Both sums count the same underlying orders, just grouped by the two different people who
> touched them. **If they match across 20 weeks and 7 hubs, they are the same complaint set
> and the bipartite separation is valid.** If they diverge systematically, they are different
> sets and the whole method is off the table.
>
> The observed ~2× ratio in the *means* is not evidence either way — a driver handles more
> orders per week than an armador assembles, so per-person means should differ even when the
> totals match. **Compare hub-week totals, never per-person means.**

> **Fix hiding in plain sight:** the printed label already carries a **barcode that is
> "not currently used"** (§4.2). Scanning at handover would make both failure modes
> structurally impossible. Not a data question — but the data would show the effect.

### 5.5 Cash handling and the discrepancia loop

- Customer pays **cash or card (Clip)**.
- Amount owed = the digital total → `discrepancia."Cálculo digital efectivo"`.
- Cash goes to the **coordinador**, who **counts it in front of the driver** and registers it
  in Retool → `discrepancia."Conciliación manual"`.
- Card payments appear automatically.
- **If there is a discrepancy the driver should add a note.**
- **No explanation → 24 hours to make up the money, or an *acta administrativa* and loss of
  bonus.**

> So `discrepancia_mxn` = `Cálculo digital efectivo` − `Conciliación manual` is a **cash
> shortfall with real consequences attached** — not a bookkeeping curiosity. That justifies
> its `watched_globally` status.
>
> ⚠️ **The explanation notes exist in Retool but are not in the exported view** ✅ CONFIRMED.
> The 15 discrepancia columns include no notes field.
>
> Those notes are the difference between *"this driver is short 400 pesos"* and *"this driver
> is short 400 pesos and cannot say why"* — the exact distinction the 24-hour rule and the
> acta administrativa turn on. **One column added to the export makes an existing KPI
> materially better.** See §6.

---

## 5b. The protocol library ⭐⭐ — and what it contradicts

Drive folder **`1c2y0zWkl1USHyv3XvJ3P4AW5oCrXm2WJ`** holds **50+ protocol documents**, owner
mostly david@calii.com. Seven were read on 2026-09-09. José's warning — *"not all of them
are fully updated"* — is correct and matters: **where a doc and José disagree, the doc's
modification date decides who to believe, and neither wins automatically.**

Docs read: `Faltantes armador` (2025-12-01) · `Recepción, calidad, inventario y acomodo`
(2025-06-11) · `Registro de asistencia y actividad` (2025-06-11) · `Conciliación de efectivo,
vales y pedidos fallidos` (**2026-08-21, newest**) · `Tasas de armado > 100 SKUs/hora`
(2026-06-19) · `Bono de Excelencia y Propinas` (2026-04-16) · `Plan ante afectaciones de
suministro eléctrico` (2026-08-19).

### ⭐⭐ The faltante authorization may be recorded after all — in Slack

The `Faltantes armador` protocol describes something quite different from §4.3:

- A faltante fires an **automated Slack alert in `#hub_fa`**, carrying
  **Fecha/Hora · Producto · Operador · Inventario · Sorting · order ID · Cliente**.
- The `Inventario` field is **quantity plus an MNA reason code** — attested example:
  `Inventario: 9 pz  MNA por cad`.
- The **Aux. de Turno replies within 10 minutes** with a two-field verdict:
  **`Inventario: Correcto / Incorrecto`** and **`Sorting: Correcto / Incorrecto`**.

> **If this is live, it is a per-event, root-caused, parseable dataset — and it is the
> "missing authorization field" from §6.1.** It would not need a schema change at all,
> only ingestion.
>
> **But three things must be checked before believing it:**
>
> 1. ❌ **`#hub_fa` is not visible from this session's Slack connection** (only
>    `#coordinadores_hubs` returned). Different name, no access, or does not exist.
> 2. ⚠️ **José said the authorization is verbal and unrecorded.** He runs these hubs. A
>    protocol can describe a process nobody follows.
> 3. ⚠️ **It is post-hoc, not pre-authorization.** The doc has the aux *reacting to an
>    alert within 10 min*, not gating the faltante beforehand.
>
> ### ✅ RESOLVED — both steps exist. The protocol only documents one of them.
>
> José, 2026-09-09: the channel and the protocol are **live**, but they describe a
> *different* step from the one he originally meant. **Both are real:**
>
> | Step | When | Recorded? |
> |---|---|---|
> | **1 · Pre-verification** — armador can't find it → asks the aux → **the aux looks for it, or green-lights marking it faltante if the operation is tight** | Before the faltante is marked | ❌ **Nowhere.** Verbal only. |
> | **2 · Post-hoc confirmation** — faltante is marked → alert fires in `#hub_fa` → aux replies in-thread with `Inventario: Correcto/Incorrecto` and `Sorting: Correcto/Incorrecto` | Within 10 min (protocol) | ✅ **Slack thread** |
>
> ⚠️ **Direct read of the protocol confirms: step 1 is NOT documented anywhere in it.** The
> doc is entirely post-hoc — alert → 10-minute note → root cause → correct before orders
> leave for delivery. There is no written instruction that the armador must consult the aux
> first. **The gating practice is real and undocumented.**
>
> ⚠️ **And practice diverges from protocol on step 2**: José says auxiliares *"sometimes
> answer and verify inventory until the end of the shift"* rather than within 10 minutes.
>
> ### So there are two separable measurements, pointing at two different people
>
> | Measure | Points at | Available from |
> |---|---|---|
> | Faltantes marked without the aux having been consulted | **Armador** | ❌ Not recorded — needs the §4.3b statistical proxy |
> | **Reply latency on the `#hub_fa` thread** (10 min vs end of shift) | **Auxiliar de turno** | ✅ Slack timestamps — alert ts vs reply ts |
> | **Verdict distribution** (Inventario Correcto/Incorrecto × Sorting Correcto/Incorrecto) | Root cause per event | ✅ Slack thread text |
>
> The second is genuinely new: **a supervisor-responsiveness metric that nothing currently
> measures**, computable from message timestamps alone.

### The `#hub_fa` alert is richer than the CSV export ⭐

Verbatim example from the protocol:

```
Faltante armador
Fecha/Hora: 07/09 14:41 PM
Producto:   Alimento líquido de almendra Nature's Heart 946ml
Operador:   Blanca Estela González Arguiano ("Blanca")
Inventario: 9 pz  MNA por cad
Sorting:    [B-2-4] Correcto
ID:         1014
Cliente:    Flora Garcia
```

Two fields here do not exist in `faltantes_armador` at all:

- **`Sorting: [B-2-4] Correcto`** — the SKU's **physical location** plus a correctness
  verdict. This is the missing piece for separating faltantes causes 1–3 in §4.6: a
  faltante with `Sorting: Incorrecto` is a *misplaced product*, not a pick failure.
- **`Inventario: 9 pz MNA por cad`** — quantity **plus an MNA reason code**. So stock can be
  non-zero and still genuinely unavailable because it was MNA'd. ⚠️ **This means the "30.2%
  have `Inventario disponible = 0`" split understates genuine unavailability** — the honest
  denominator is *zero **or** MNA'd*, and the CSV export carries no MNA flag.

**The alert also scopes itself to exactly the subset we care about**: the aux is required
to respond only to *"faltante armador **con inventario positivo**"* — the same
`Inventario disponible > 0` filter §4.3b arrived at independently.

> **Ingesting `#hub_fa` is now the highest-value data project available**, ahead of
> everything in §6. It needs no schema change upstream, only a Slack reader.

### ✅ The official faltante root-cause taxonomy — adopt, do not invent

Exactly three categories, with the owning response for each:

| Cause | Meaning | Response |
|---|---|---|
| **Error del armador** | The item was there; the armador missed it | Notify armador, add product to order, update Calii Armador |
| **Error de inventario** | The stock record was wrong | Adjust inventory, with Aux. Recepción y Calidad + Aux. Inventario |
| **Error del sistema** | The in/out-of-stock flag was wrong | Adjust system parameters |

> **This supersedes the guessed buckets in `scripts/faltantes-probe.ts`.** Second-level
> detail comes from **MNA reason codes** (`MNA por cad` = caducidad attested; the full enum
> lives in Retool). Any free-text taxonomy over `Notas armador` should map onto these three
> plus the MNA codes, not a new invention.

### ⭐ Targets — the gap in `DATA_DICTIONARY.md` is largely fillable

23 of 29 KPIs had no target. The protocols carry these:

| Target | Source |
|---|---|
| **Mala calidad < 1.50%** | Recepción/calidad protocol |
| **Out-of-stock < 5.00%** | " |
| **Auditorías = 100%** | " |
| **Recepción · toma de inventario · sorting backlog = 0** (daily) | " |
| **Faltantes armador = 0 when stock exists** | Faltantes protocol |
| **> 2 unjustified faltantes/week → armador loses bonus** | Recepción/calidad protocol |
| **Tasa de armado ≥ 100 SKUs/hora** | Tasas de armado doc |
| **Incidentes efectivo / vales / pedidos fallidos = 0** | Conciliación protocol |
| 45 min to register a receipt · 5 min lateness tolerance · 10 min faltante-confirmation window · 10 min post-assembly correction window | various |
| Discrepancy flag at **> 50%** (Recepción−Envío, and Manual−Auto) | Recepción/calidad protocol |

> ⚠️⚠️ **José's ruling, 2026-09-09: these targets are outdated — they "outdate me even".**
> They are used **as reference only. The biggest reference is week-over-week.**
>
> This confirms the design call in `DATA_DICTIONARY.md`: a fixed-threshold target system is
> the wrong shape. **Load these as a secondary reference band, never as the verdict.** The
> primary signal stays *the hub against its own recent history*.

### Real tasa de armado by hub (2026-06-19)

| Hub | SKUs/hora | vs 100 target |
|---|---:|---|
| San Nicolás | 146 | ✅ |
| Cumbres | 118 | ✅ |
| Avícola | 105 | ✅ |
| Guadalupe | 101 | ✅ |
| **Contry** | **89** | ❌ |
| **Zapopan** | **89** | ❌ |
| **Condesa** | **81** | ❌ |

> **Contry is below target on assembly rate *and* is José's example of high faltantes.**
> Worth holding both facts together — though see the caveat: the doc's *individual* top
> performers are quoted at ~110 SKUs/hr, **below two of the hub averages**, so the two
> figures were computed differently. **Do not mix them.**

### `tipo_incidente` is confirmed dead as a taxonomy field
Both the quality protocol and the cash protocol explicitly route their real incidents to
**"Otros"**. Combined with the audit (Inasistencia 2,017 · Llegada tardía 879 · Otro 115),
the picture is complete: the categorical column carries only the two auto-generated
attendance types, and **every human-entered incident lands in Otros with the meaning in the
free text.** Any taxonomy must come from the text.

### ⚠️ Contradictions requiring José's adjudication

| # | Topic | José said | Protocol says | Doc date |
|---|---|---|---|---|
| 1 | **Faltante authorization** | Verbal, not recorded | Structured Slack confirmation in `#hub_fa`, 10-min window | 2025-12-01 |
| 2 | **Cash handover** | Coordinator counts it **in front of the driver** | Driver bags it with a **handwritten slip** (date, name, bills, coins, discrepancy explanation) into a **bolted safe**; coordinator reconciles the **previous day's** cash in Retool **before 11am**. No face-to-face count. | **2026-08-21** |
| 3 | **Discrepancy deadline** | 24 hours to make up the money | Daily **12pm** HR Ops Central audit + 12pm Slack alert; standard is **"explicación satisfactoria"**, not elapsed time | **2026-08-21** |
| 4 | **Temperature logs** | "Logged somewhere, just not uploaded" | **Zero** temperature readings or logging requirements across all 7 docs — including the power-outage plan, whose entire purpose is protecting cold rooms | 2026-08-19 |
| 5 | **Cold-room spec** | stock1 4° / stock2 8° / ops 12° / hierbas 2° / frescos 1° | Not stated in any doc; the one figure present (4 °C return room) sits oddly against frescos at 1 °C | — |
| 6 | **Faltante review** | Aux de turno only | **A second loop**: the **Coordinador** reviews faltantes per SKU at end of shift in Retool and logs unjustified ones as Incidentes/Otros, with the >2/week bonus penalty | 2025-06-11 |

### ✅ Rulings — José, 2026-09-09. **His word overrules the docs.**

| # | Ruling |
|---|---|
| 1 | **Both steps exist** — see §5b above. Pre-verification is real and undocumented; the Slack confirmation is real and often late. |
| 2 | **Both practices are real.** *"If coordinator is not present this is the practice; if available they do it live."* So the handwritten-slip-into-safe route is the **fallback**, not the norm — but it does occur, and those explanations never reach any dataset. |
| 3 | **The 12pm audit is protocol, not practice.** José's 24-hour account is what actually happens. |
| 4 | ✅ **Temperature IS recorded** — there is a **dedicated Retool site** for it, plus a **daily 8pm Slack alert in the main hub channel** showing the registry. **The docs were simply silent, not authoritative.** ⭐ This restores the ceiling on equipment analysis: cold-room causes can be **confirmed with a date**, not merely suggested. |
| 5 | **José's cold-room spec stands.** The protocols never state temperatures; silence is not contradiction. |
| 6 | ❓ Still unaddressed — does the Coordinador end-of-shift faltante review happen in practice? |

> ### ⚠️ Where does "temperatura y activos" get filled in?
>
> José asked whether the aux de turno's activity list includes filling out *temperatura y
> activos*. **Direct read of `Protocolo: Actividades de Auxiliares de Inventario y Calidad`
> (2026-04-17): it does not** — that doc covers only the assembly rota (see §2). So the
> temperature-logging task lives in some other protocol not yet read, or in the Retool app
> itself rather than a written procedure.
>
> ❓ Worth finding, because **who owns the reading determines whether a missing reading is
> itself a signal** — a cold room with no entry for two days may be the earliest warning
> available.

### Other data sources named in the protocols

Retool apps that exist and are not ingested: **Registro de recepción · Registro de salida ·
Registro de inventario** (has a *Faltante armador* filter and per-SKU minimum shelf-life) ·
**Registro de merma · Sorting hubs** (physical location strings, feeds the armador app) ·
**Registro de efectivo, vales y devoluciones** (with a `Notas` field and a *Devuelto Calii*
checkbox) · **Fotos mala calidad**.

Slack channels named: `#hub_fa` (faltantes) · `#mh_<hub>_aa` (attendance) ·
`#mh_<hub>_ef` (failed orders) · `#mh_<hub>` (general) · `#mh <hub> efectivo`.

### ⚠️ The bonus rule has no written successor
`Protocolo: Bono de Excelencia y Propinas` is an **empty stub** — title and one heading,
created and abandoned within 41 minutes on 2026-04-16. Three bonus names circulate across
the corpus: **"bono semanal PAD"**, **"bono de desempeño"**, **"Bono de Excelencia y
Propinas"**. This corroborates `DATA_DICTIONARY.md`'s reading of `receives_bonus` as the
output of a retired formula — **and confirms there is no documented replacement anywhere.**

---

## 5c. Full protocol sweep — 83 of 83 documents ⭐⭐

The first pass read **7 of 50+** and wrote absence claims from it. That was wrong and José
caught it. The folder was then enumerated to exhaustion: **66 top-level items = 63 docs +
3 subfolders** (`Recetario` 11 · `Calii Repartidor` 3 · **`Calii Armador` 6** — the third was
not previously known). **83 documents, all read.**

### ✅ Temperature IS recorded — and José's cold-room spec is exactly right

Assigned in **`Protocolo: Auditoría de hub`**, final section *"3. Registros de temperaturas
y activos"* — the last line of the document, which is why the first pass missed it.

> *"**Todos los días.** Antes de las 8pm, el **Coordinador del MH** registrará las
> temperaturas de los cuartos fríos y el estado de los extractores y congeladores, y el
> **líder de turno** registrará los insumos en [Temperaturas y activos]."*

> ⚠️ **CORRECTED — José, 2026-09-09: the doc is outdated on the owner.**
> **It is the AUX DE TURNO's job, not the coordinador's.** The task and the registry are
> real and current; only the assignment in the protocol is stale.
>
> This matters for attribution: a missing or out-of-range reading points at the **aux de
> turno**, and a missing reading may itself be the earliest available warning.

**Retool app `Temperaturas y activos`** — id `05dc1c4e-0bf8-11ef-b129-47cd115eefa8`, folder
`Ops`. Its source spec sheet gives the **exact target temperatures**:

| Row | Target |
|---|---|
| `Cuarto ops` | **12 °C** |
| `Cuarto hierbas` | **2 °C** |
| `Cuarto lácteos` | **1 °C** |
| `Cuarto stock 1` | **4 °C** |
| `Cuarto stock 2` | **8 °C** |
| `Extractores funcionales` · `Congeladores funcionales` | count / state |
| `Cajas agrícolas` · `Hieleras` · `Ice packs` | count (líder de turno) |

> ⚠️ **José's spec was correct in every particular and I was wrong to flag it as
> unsupported.** The earlier "no temperature anywhere" claim came from reading 7 documents
> and generalising. The 4 °C figure that *did* surface is `Cuarto stock 1` — one of five.
>
> ⭐ **This is the biggest unlock in the corpus.** Daily per-room readings plus extractor and
> freezer status, per hub, going back to the app's creation (2024-05). The Cumbres-herbs
> hypothesis becomes **confirmable with a date** rather than permanently 🔶.
>
> ❓ **No tolerance band is documented anywhere** in 83 docs — no ± range, no escalation
> threshold. It may be configured inside the Retool app. Absence here is weak evidence.
> ❓ The 8pm Slack alert is confirmed as a **design note** in the spec sheet
> (`Integrate w/ 8pm Slack alert`) but **the channel is named in none of the 83 docs.**

### ⭐ The `tasa_armado` formula is documented — and it is neither of my two clocks

`Protocolo: Armado de pedidos`:

> *"**Tasa (SKUs/hora):** Número de SKUs armados dividido entre el rango **menos minutos sin
> pedidos pendientes** y **menos descanso proporcional**"* — descanso = **45 min per 8-h
> shift** (30 comida + 15 otros).

So the denominator is elapsed range **minus time with no pending orders, minus a pro-rata
break**. That is *not* raw assignment-to-completion and *not* pure hands-on picking — it
sits between them, and it **already removes the "no work available" idle** that §4.5b
assumed was inflating the number.

> ⚠️ **This weakens the "three quarters of measured time is queue waiting" hypothesis.** The
> formula deliberately excludes empty time. What it does *not* exclude is time when orders
> **were** pending and the armador hadn't started them — which is still José's stated
> concern, and still a real confound with queue depth. `scripts/reverse-engineer.ts` remains
> the way to settle which column implements this formula.

### ⚠️⚠️ Express and marketplace orders are two separate populations — and both distort armador metrics

**Express** (`Protocolo: Pedidos Express`, Retool app `Envíos Express`):

- **Sub-60-minute SLA**, not a 2-hour window. The 30-min lateness KPI does not apply.
- **Delivered by socios repartidores — Uber, Rappi, DiDi. No Calii driver.** So Express
  orders generate **no** entregas tardías, no entregas fallidas, no incidentes de cliente,
  no cash reconciliation, no Onfleet route, and **no `desempeno_repartidores` row.**
  → **Any driver-KPI denominator that includes them is wrong.**
- ⭐ **They jump the assembly queue** — *"Los pedidos Express aparecerán con **prioridad** en
  el orden de pedidos de los armadores."* ⚠️ **CORRECTED (José): they do NOT interrupt an
  order mid-assembly.** They go **to the top of the queue of whoever they were assigned to**.
  So the displaced scheduled orders wait longer, and — since the `tasa_armado` denominator
  excludes only time with *no pending orders* — the armador who receives one carries extra
  queue depth that the metric does not account for. A real confound, milder than
  mid-pick interruption.

**Marketplace** (`Protocolo: Entregas a través de plataformas de marketplace`) — a *third*
population again:

- **Narrower hours than the hub**: Mon–Fri 08:00–21:00, **Sat–Sun 08:30–15:45** while the hub
  runs past 18:00. Any weekend day-part comparison is structurally skewed.
- ⭐ ***"Se determinará **un armador de cada turno** para el armado de pedidos de estas
  plataformas"*** — one designated armador per shift handles all of them, deliberately, so
  incidents can be attributed. **Marketplace incidents therefore concentrate on one person by
  design. Never read that as individual performance.**
  ⭐ **José: in most hubs that designated armador is the AUX DE TURNO** — so marketplace work
  is another undocumented draw on aux hours, alongside the Mon/Tue/Sun assembly rota (§2).
  ⚠️ But their stats *"don't appear anywhere in our system"* — they live in the platforms'
  tools. So this load is **invisible**: the aux spends hours on orders that generate no row
  anywhere, which will make their apparent productivity look worse than it is.
- Orders live in the platforms' own tools (EatsOrders / Soy Shopper / Didi Tienda) — no Calii
  order lifecycle, no ETA, no driver record.

### ✅ San Rafael Puebla is a real operating hub — `MHSR`

Not an unmapped label. Confirmed four ways: a CFE service number in the electrical protocol
(modified **2026-08-19**), cashier IDs in the cash-audit protocol, a dedicated **`PUE`** fuel
reconciliation sheet, and the purchasing mailbox `compras05@calii.com`. Its short code is
**`MHSR`**, per the Driver Ops Onfleet naming example *"Eduardo (MHSR)"*.

> ⚠️⚠️ **CORRECTED — José, 2026-09-09: San Rafael is DEACTIVATED and has been for years.**
> *"Might appear in system but not real."*
>
> **So do NOT add it to `lib/hub-aliases.ts`.** The infrastructure references that made it
> look live — the CFE meter, cashier IDs, the PUE fuel sheet, the purchasing mailbox — are
> **stale infrastructure records for a closed hub**, exactly like MH San Pedro's.
>
> ⭐ **Lesson worth generalising: infrastructure records are a bad liveness signal.** A CFE
> meter and a bank account outlive an operating hub by years. Two hubs now confirmed
> deactivated while still appearing across the protocol corpus.
>
> The `[resolveHubId] unrecognised` warnings are therefore **correct behaviour** — the rows
> should be dropped. They are noisy, not wrong.

### MH San Pedro — closed March 2024, status now ambiguous

`Protocolo: Plan ante afectaciones por clausura de MH San Pedro` (created 2024-03-07, never
modified): closed over the **landlord's** expired land-use licence.

> *"Actualizaremos los geofences para que el geofence de MH San Pedro sea **absorbido por
> MH Contry y MH Cumbres**"*

⭐ **Contry absorbed part of San Pedro's territory.** That is worth holding next to José's
*"Contry is more orders, bigger orders"* — the volume difference has a documented origin.

Evidence is contradictory on whether it reopened: still listed in the CFE table (2026-08-19)
and the cash-audit IDs (2026-04-27), but **absent from the BBVA deposit table** (2026-05-05,
which lists every other Monterrey hub) and from all Pickup rollout stages. The census found
`Coordinador MH SPGG` with **4 weeks and 0 orders assembled** — consistent with a dormant
account. **A coordinator account is not evidence the hub is live.**

### ⚠️ Targets conflict across documents — do not merge them

| Metric | Values found | Note |
|---|---|---|
| **Tasa de armado** | **80** (interim bonus gate) · **90** (`Armado de pedidos`) · **100–110** (capacity assumption) · "100+, up to 120" (carritos doc) | Four numbers. The 100 I reported is the capacity assumption, not the protocol target. |
| **Mala calidad** | **1.5%** hub-level (`Recepción/calidad`) vs **3.0%** armador-level (`Armado de pedidos`) | ⚠️ **Different denominators — I merged them incorrectly.** Observed hub values run 1.94–4.65%. |
| **Entregas tardías** | **5%** >30 min and **1%** >60 min (`Reparto`, Dec 2025) vs **10%** (`Funcionamiento de MH`) | Newer doc supersedes |
| **Entregas fallidas** | **1%** (Dec 2025) vs **2.5%** (older) | " |
| **Audit incidents** | **<5** (`Funcionamiento de MH`) vs **<10/week** (`Auditoría de calidad`) | Two gates |

Plus armador targets not previously captured: **incidentes total 6.00%** (malas calidades
3.00% · faltantes completos 2.50% · faltantes parciales 0.50%) · códigos de barra incompletos
**5.00%** · fechas de caducidad incompletas **5.00%** · faltantes armador **5.00%** · pedidos
con retraso **5.00%**.

> This is the clearest possible vindication of José's ruling that **week-over-week is the
> primary reference and targets are secondary.** The corpus cannot agree with itself.

### Other data sources catalogued

**31 Retool apps** named across the corpus. The four newest and most likely missing from the
CSV pipeline: **`Temperaturas y activos`** · **`Auditoría de hub`** · **`Envíos Express`** ·
**`Imprimir Etiquetas`**. Also `Faltantes armador`, `Estatus armadores`, `Entregas fallidas`
(Customer Success), `Capacidades`, `Rutas`.

**A Google Form outside both Retool and the CSVs:** the per-shift auxiliary audit runs on
`Auditoría: Calidad e Inventario de Microhub (MH)` — `forms.gle/Xg7qdu9Zmhy3zD349`.

**Slack channels:** `#mh_<hub>` · `#mh_<hub>_express` · `#mh_<hub>_monitoreo` ·
`#zona_<n>_monitoreo` · `#zona_<n>_capacidades` · `#ciudad_mna` · `#ciudad_driver_ops` ·
`#hub_ef` (entregas fallidas) · `#hub_va` (armado re-assignments) · `#hub_fa` (faltantes).

### Corpus quality issues worth knowing

- **`Protocolo: Optimizaciones para entregas on-time` returns completely empty.** Two other
  protocols cite it for the *"última ventana del turno"* balancing rules — **those rules are
  currently undocumented and unreadable.**
- `Protocolo: Turnos ` (trailing space) contains a verbatim copy of
  `Protocolo: Abastecimiento de microhubs`, not shift content.
- `Protocolo: Seguimiento de bajas HR Ops` has ~60% of `Actualización de estructura` pasted
  into its tail.
- ⚠️ **Meat transport temperature conflicts**: **1 °C** in the MNA protocol vs **2 °C** in
  `Abastecimiento`. Same fleet.

---

## 6. Upstream changes worth requesting ⭐

Four things sit just outside the app, each small, each unlocking something the analysis
cannot otherwise reach. Ordered by payoff per unit of effort.

| # | Ask | Owner | Unlocks |
|---|---|---|---|
| 1 | **Record who authorized a faltante armador** — one field on the faltantes record | Assembly app team | Splits `faltantes_armador_pct` into a real availability problem and a behavioural one, **per armador**. §4.3 — the single highest-value missing field in the system. |
| 2 | **Add the discrepancy note to the discrepancia export** — the column already exists in Retool | Whoever owns the Retool view | Separates an honest counting error from an unexplained shortfall. §5.5 |
| 3 | **Export the temperature logs** — they are already recorded, just not uploaded | Facilities / whoever owns the sensors | Moves equipment causes from *suggested* to *confirmed with a date*. Raises the ceiling on the entire Cumbres-herbs class of question (`ASSISTANT_DESIGN.md` §3, Causal axis). Likely a handful of sensors per hub — far smaller than `registro de inventario`'s 49 files/week. |
| 4 | **Scan the label barcode at handover** — it is already printed and unused | Driver app team | Makes both entrega-errónea failure modes structurally impossible rather than merely measurable. §5.4. A process fix, not a data one — but the data would show the effect immediately. |

> None of these block the current work. All four are worth raising while the reasoning is
> fresh, because each has a long lead time and #1 in particular would change what the
> faltantes analysis can honestly claim.

### 5.6 End of route
Return to hub, unload boxes, icepacks and coolers, wait for the next window if unassigned.
Failed deliveries go to the assigned cold room for aux de turno verification (§5.3).

---

## 7. Data implications ⭐

| Finding | Consequence |
|---|---|
| Aux de inventarios is the flex resource | The absence → MNA/faltantes chain is testable and has a stated mechanism |
| Two roles register MNA, split by category | Category-specific MNA anomalies point at one named person per hub |
| Hierbas = stock + exhibition + coldest + enclosed | Structural single point of failure; grounds the Cumbres example |
| Guadalupe has no stock rooms, herbs at 1 °C, product outside the MH | **Exclude or flag GPE in every FyV peer comparison** |
| Aisle optimisation varies by hub | Exhibition capacity differs → run-out frequency differs → not a fair peer comparison |
| Freezers cap frozen assortment at ~21–24 SKUs | Frozen availability is capacity-bounded, per hub |
| Armadores own aisles | `total_idle_time_min` (confirmed: "any time without an order opened") is **where aisle upkeep happens** — grounds example B's "free time used for organising aisles" |

---

## 8. Answers from round 1

### Aux assembling is visible in the data ✅ CONFIRMED
See §2. Blocked only on an aux roster.

### Temperature IS logged — just not uploaded ✅ CONFIRMED
Same situation as `registro de inventario`: the data exists outside the app.

> **This changes the ceiling on equipment analysis.** Without it, a cold-room hypothesis can
> only ever be *suggested* — permanently capped at 🔶 on the Causal axis
> (`ASSISTANT_DESIGN.md` §3). With it, *"there might be an issue with the herbs cold room"*
> becomes *"hierbas ran above target on Tuesday and Wednesday"* — a confirmed cause with a
> date.
>
> Unlike `registro de inventario` (49 files/week, rejected), temperature is plausibly small:
> a handful of sensors per hub. ❓ Needs shape and cadence before judging feasibility.

### Shift is derivable from `avg_start_time` ✅ CONFIRMED — with a caveat
`desempeno_operadores.avg_start_time` (73.2% filled, currently inert) should separate AM
from PM for people who work one shift consistently.

⚠️ **Weekend distortion:** Saturday and Sunday run a **single 08:00–18:00 shift**. Since the
column is a *weekly average*, anyone working weekends has their average pulled toward the
middle, blurring the AM/PM split.

So shift is **derivable but approximate**. Good enough to test shift-level effects (a weak
AM líder, a bad handover), not good enough to assert an individual's shift as fact.

### `mh_guadalupe` is the hub described ✅ CONFIRMED
The MH **physically sits inside CH Guadalupe** — no walls, shared refrigeration. It is one
of the 7 analysed hubs and appears in all the data. **The FyV exclusion rule in §3 applies
to a real, live hub_id.**

Not to be confused with `CH Guadalupe`, which the original registry seed excludes entirely.

---

## 9. Still open

- **Aux roster** — who are the auxiliares, by name and hub? Unblocks the flex chain. → asked
- **Temperature log shape** — sensors per hub? cadence? exportable? → asked
- Is aisle-to-armador assignment recorded anywhere?
- Is the stock-1 / stock-2 product allocation documented, or does it live with the
  coordinador de calidad?
- Weekend vs weekday: is Saturday/Sunday volume comparable to a weekday? (Affects every
  per-day figure, including the "420 vs 250 minutes" style comparison.)

---

## Still to cover

Assembly process (incl. faltantes) · delivery process · schedules and shift times · peak
days · protocols · known history and hub-specific quirks.
