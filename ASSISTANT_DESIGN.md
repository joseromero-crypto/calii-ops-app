# Calii Ops — Assistant Design

**Status:** principles only. No architecture, no implementation plan yet.
**Companion docs:** `DATA_AUDIT.md` (what data exists) · `DATA_DICTIONARY.md` (what it means,
plus the operating context that governs interpretation).

This file records the *behavioural* requirements for the analysis assistant — the chat and
the task suggestions. It exists because these requirements came out of conversation and
would otherwise be lost, and because they constrain the architecture more than the
architecture constrains them.

Single user: **José.** ✅ CONFIRMED. Coordinators receive the *output* (the Friday report)
but do not use the tool. No multi-user provenance, no contradiction resolution between
people, no permissions model.

---

## 1. The three requirements

Stated by José, 2026-09-08:

1. **Every response declares how certain it is.** If something is assumed, say so.
2. **Ask when in doubt. Do not guess.**
3. **Keep learning** — from conversations, case studies, problems solved. There is far more
   day-to-day context than any interview will surface, and some of it will only come up
   when a real situation forces it.

> **These are not new behaviours to invent.** They are what this project's own interview
> sessions have been doing by hand: the ✅ / ⚠️ / 🔶 / ❓ legend in `DATA_DICTIONARY.md` *is*
> a certainty meter, and nine rounds of asking rather than guessing produced five
> corrections to conclusions that would otherwise have shipped as fact. The job is to make
> that mechanical, not to design it from scratch.

---

## 2. What this is: on-demand investigation, not a report

⚠️ **Corrected 2026-09-08.** An earlier draft framed this around the Friday deadline. Wrong.

**The Friday report already exists and works** — "Generar reporte" gathers the week's data
into a few sentences. The assistant is a different thing:

> A tool José opens **any day of the week**, when he is working a specific hub or KPI and
> wants to know *why* — going past the numbers on the dashboard into what produced them.

The Friday report is one of several things that might *trigger* an investigation. It is not
what the assistant produces.

Consequence: **latency is not the binding constraint.** José is at his desk, mid-thought,
when he asks. A minute of analysis is fine if the answer is good. This also makes the
"stop and ask before continuing" rule (§5) far cheaper than it looked — he is present to
answer.

### The two worked examples

These are José's own, and they are the specification.

**A. Friday, the report shows Cumbres MNA up 6% on its 4-week average.**

> **"What's happening in Cumbres? Why do they have so much MNA?"**
>
> *Expected:* "Cumbres has a lot of MNA registered for papa blanca — but so do all the
> other hubs in Monterrey. However, I'm noticing a pattern among **herbs**: this week is
> way higher for all of them, and this is not seen in other hubs. There might be an issue
> with the herbs cold room in Cumbres."

**B. Wednesday, working on faltantes armador.**

> **"Why is Contry constantly near 20% while all the other hubs are below 10%?"**
>
> *Expected:* "First, of the 130 faltantes registered, **65 have inventory 0** — an app
> problem, not operations. With that in mind it's closer to 10%. **However, the same
> applies to other hubs, so that doesn't answer why it's so far off.** One thing I do
> notice is assembler availability: Contry's assemblers average **420 minutes a day
> assembling** while the next highest hub averages **250**. Other hubs have far more free
> time, used for organising aisles, doing inventory, etc. That may well be a cause…"

### The method both examples follow

| # | Step | In example A | In example B |
|---|---|---|---|
| 1 | **Decompose** the aggregate into components | Hub MNA → per-SKU | Hub faltantes → per-event |
| 2 | **Normalise against peers** | Papa blanca vs other MTY hubs | Inventory-0 rate vs other hubs |
| 3 | **Discard what does not discriminate** | Papa blanca is everywhere → drop it | Inventory-0 is everywhere → *"doesn't answer why"* |
| 4 | **Find what remains that IS specific** | Herbs, only in Cumbres | Nothing in the faltantes data itself |
| 5 | **Group emergently**, beyond the schema | "Herbs" is not a Tier or a category field | — |
| 6 | **Reach into other datasets** for candidates | — | Assembly minutes, from a different file |
| 7 | **Propose a physical cause**, hedged | "might be the herbs cold room" | "may well be a cause" |

> ### Step 3 is the intellectual core
>
> **Both examples explicitly dismiss their own first finding.** That is what separates these
> answers from what the dashboard already does. Papa blanca is a big number and irrelevant;
> inventory-0 is a real and confirmed insight and *still doesn't explain the gap*.
>
> An assistant that surfaces the largest component and stops would produce a confident,
> useless answer in both cases. **The discriminating question is always: does this component
> explain the difference, or is it just large?**

### What is buildable now, and what is not

| Step | Status |
|---|---|
| 1–4 · decompose, normalise, discriminate | ✅ **Pure computation over `upload_rows`.** No model needed. Nothing blocks this. |
| Example B's inventory-0 split | ✅ **Ready** — `Inventario disponible` is CONFIRMED |
| Example B's assembly minutes | ✅ Data exists — `total_num_min_of_assembly`, currently inert |
| 5 · emergent grouping ("herbs") | 🔶 **Model territory.** No herbs field exists. Given SKU-level deltas, a model can notice cilantro/perejil/romero moving together — this is what it is genuinely good at. But it is the step that must be trusted, so it needs the confidence machinery of §3 hardest. |
| 7 · physical cause ("the herbs cold room") | ❌ **Not derivable from any data we have.** |

> ### The gap José's own example exposes
>
> **"There might be an issue with the herbs cold room in Cumbres"** requires knowing that
> Cumbres *has* a herbs cold room, that herbs are stored there, and that a cold-room failure
> causes merma. **None of that is in any dataset, and no amount of data work will produce it.**
>
> This is the facility, protocol and process knowledge that has not been interviewed. His
> example proves it is not a nice-to-have — it is the difference between "herbs are up in
> Cumbres" (a fact) and "check the herbs cold room" (an action). Step 7 is where the
> assistant earns its keep, and it is entirely unbuilt.
>
> **Highest-value remaining interview: hub physical layout, equipment, and what breaks.**

---

## 3. Confidence is four axes, not one number

**A single percentage would mislead.** A finding can be exact on the number and worthless on
the reason. These four are independent and each can fail alone:

| Axis | The question | Real example of it failing |
|---|---|---|
| **Coverage** | Is the data present for this hub / week / person? | `num_skus_per_hour_assembly_rate` is 70% filled — `tasa_armado` simply does not exist for ~30% of armador-rows |
| **Meaning** | Is the column CONFIRMED in the dictionary, or still ASSUMED? | Any finding built on `num_idle_days` is unfounded — nobody knows what it counts |
| **Statistical** | Is n large enough? Is the gap outside normal variation? | `entregas_erroneas` rests on ~115 manual rows per 4 weeks |
| **Causal** | Is the "why" a traced mechanism, or a correlation? | "Faltantes rose because absences rose" — plausible, unproven |

### The rule

> **Overall confidence = the weakest axis. The output names which axis is weak.**

Never average the axes — averaging hides exactly the failure that matters. "High confidence
in the number, low confidence in the cause" is something José can act on. "72% confident"
is not.

### Worked shape

```
FINDING    Contry: 41% of faltantes had stock available vs 12% network average
           Coverage    ✅ Inventario disponible 98.4% filled for this hub-week
           Meaning     ✅ CONFIRMED — system stock at moment of report
           Statistical ✅ n=387 events over 8 weeks
           Causal      🔶 ASSUMED — the picking-failure reading is inference,
                          not traced. Could also be an inventory-record problem.
           → Confident in the split. Not confident in the explanation.
```

---

## 4. Provenance, not just confidence

Confidence says *how sure*. Provenance says *who says so*. Both are needed, because the
learning loop's failure mode is the assistant accumulating **its own guesses as facts**
until they harden into ground truth.

| Tier | Source | May be quoted as fact? |
|---|---|---|
| **P1 — Stated** | José said it in conversation | ✅ Yes |
| **P2 — Derived** | Reproduced from data at ≥98% match (José's threshold) | ✅ Yes, with the derivation shown |
| **P3 — Inferred** | The model concluded it | ❌ Never without a hedge |
| **P4 — Open** | Known unknown, question outstanding | ❌ Blocks anything depending on it |

**P3 can never be promoted to P1 or P2 by the model itself.** Only José confirming it, or a
derivation clearing 98%, moves a fact up a tier.

---

## 4b. ⭐ Evidence by default, and the three layers of context

### The question José actually asks

✅ José, 2026-09-09: *"I dont see myself asking what does … mean and referring to a column,
rather than asking what does … mean and referring to a data point, meaning, how did we get
there and why."*

This is load-bearing, and it demotes the idea of a "look it up" reference tool.

Take his own Contry case. He asked why there were 130 faltantes. The useful answer was that
65 of them had `Inventario disponible = 0`, and that column is **system stock at the moment
of the report** — so those items were already out of stock before an armador touched them,
and they are not an assembly failure at all. He never asked what the column meant. **The
column meaning *was* the causal answer.**

So `DATA_DICTIONARY.md` is not a reference work to be consulted. It is the **raw material of
every "why"**, and it has to arrive attached to the number.

### Therefore: three layers, and only one of them is optional

| Layer | What it holds | Fetched by |
|---|---|---|
| **1 — Always-on core** | The traps that would poison *any* answer: the `Kg/Pz` unit hazard · Guadalupe not comparable on FyV · Zapopan/Condesa's extra auxiliar · marketplace invisible · `tipo_incidente` dead · **`receives_bonus` is a defunct formula** · protocol targets stale | Nobody — it is always in the prompt |
| **2 — Caveats attached to results** | Every analysis function returns `{ data, confidence, caveats, provenance, claims }`. A column's caveat ships with the number derived from it. | The function itself, in code |
| **3 — `lookupColumn` / `lookupContext`** | Everything else in the docs, in full | The model, *if it chooses to* |

**Layer 3's reliability is not load-bearing, and must never be made so.** The model looks up
what it knows it does not know. It will not look up `receives_bonus`, because the name reads
as self-explanatory. The failure mode is not *"could not find the caveat"* — it is *"did not
know there was one to look for"*, which pasting all 100 KB into the prompt does not fix
either. Only layer 2 closes it.

**Maintenance rule:** every fact learned from here on gets a *placement decision* — core
warning, function caveat, or dictionary-only. Only the third is exposed.

### Evidence is attached to every claim, not produced on request

✅ José, 2026-09-09: *"I would def like clickable claims in the responses that open up
evidence (either the csv with highlighted rows or a graph showing the data analyzed that
backs the response)"*, and he expects to want it in **~90% of answers**.

That settles always-on versus on-request. Each analysis function emits, alongside its
numbers, a `claims[]` array where each claim carries a **re-runnable reference** to the rows
or population behind it (`ARCHITECTURE.md` §4). The model's only job is to carry the claim
`id` into its prose.

Three properties this must preserve:

1. **Generated in code, in the same pass as the number.** Not narrated by the model
   afterwards — a narrated derivation can be wrong about itself.
2. **Rows are never sent to the model.** The reference is resolved by the UI on click. So
   evidence exists for every claim but is materialised only for the one opened.
3. **Persisted with the thread.** Resuming a month-old conversation must still open the
   evidence (`ARCHITECTURE.md` §6, `claims` table).

---

## 5. Ask, and block

✅ CONFIRMED: when the assistant has a doubt, it **stops and asks before continuing**,
rather than answering around the gap.

This was chosen knowing the Friday deadline cost. It is defensible because:

- **Blocking cost decays.** The same doubt must never block twice. Once answered and
  stored, it is resolved permanently. High friction in month one, near zero by month six.
- **The fix for the deadline is scheduling, not weakening the rule.** Run the analysis the
  moment data lands Friday morning, not at report time — doubts then surface with hours to
  answer them, and the report is assembled after.
- The alternative — answering with an unstated assumption — is precisely the failure this
  whole audit exists to prevent.

**Design obligations that follow:**

1. A doubt must be **specific and answerable in one line.** "What does `num_idle_days`
   count?" blocks productively. "Tell me about your operation" does not.
2. **Never re-ask a stored question.** Requires the knowledge base be checked before asking.
3. The assistant must **distinguish load-bearing doubts from cosmetic ones**, and only
   block on the former — a doubt that changes the conclusion, versus one that changes a
   footnote.

---

## 6. The learning loop

✅ CONFIRMED: **propose → José approves → store.** Nothing enters the knowledge base without
human confirmation. This is what keeps the P1 tier meaningful; auto-storing model output
would fill the base with P3 entries wearing P1 clothes.

### The storage layer already exists and is unused

This is the significant finding. The app already has an editable, versioned knowledge base
feeding the AI prompt — `lib/prompts/system-context.ts`'s `assembleSystemPrompt()` reads it
on every generation:

| Table | Rows today | Role |
|---|---:|---|
| `context_sections` | 6 | Operating-context prose |
| `behavior_rules` | 9 | How the assistant should behave |
| `scope_rules` | 5 | What to flag to Compras / Comercial / Tecnología vs act on |
| `headline_examples` | 4 | Few-shot examples |
| `prompt_versions` | **1** | Versioning — **never bumped since the initial seed** |
| `insight_feedback` | **0** | Capture hook — **never written to** |
| `annotations` | **0** | **Never written to** |

**Storage, versioning and a read path are all built. What is missing is a write path and a
reason to use it.** So this is not "build a learning system" — it is "wire up the one that
is already there, and give it a UI."

`insight_feedback` is the natural capture point: the moment José corrects a finding is the
highest-value context the system will ever get, and that table was designed to hold it.

### What gets captured

| Kind | Example | Destination |
|---|---|---|
| Column meaning | "`Inventario disponible` is system stock at the moment of the report" | `DATA_DICTIONARY.md` + `context_sections` |
| Operating rule | "Retool for global, ours for per-person, ignore <1%" | `behavior_rules` |
| Correction | "That's wrong — `Tiers` is velocity, not category" | `insight_feedback` → promoted on approval |
| Protocol | "When faltantes spike on FyV, first check the recepción" | `context_sections` |
| Precedent | A case study: what was decided, and what happened after | ❓ needs a home — see §8 |

---

## 7. Non-negotiables

Distilled from what this session has actually produced:

1. **Every number carries its source file and column.** `DATA_DICTIONARY.md` exists because
   a bare column name is unusable — `num_absences` means different things on two files.
2. **A correction beats an addition.** Five conclusions were overturned mid-interview
   (`Tiers`, `num_absences`, `total_idle_time_min`, Panamericano, `error de recepción`).
   The system must make it easy to say "that's wrong" and have the wrong version die.
3. **Silence about an assumption is the failure mode.** Not being wrong — being wrong
   *invisibly*.
4. **Never surface what a CSV sort would find.** ✅ José, 2026-09-08: *"I don't want the
   obvious big-number first issue anyone can find by opening up a CSV file and filtering by
   top $."* Largest-component answers are the failure mode, not the goal. **The point is to
   cross the ~29 weekly files — wherever crossing them makes sense — to find root causes
   invisible in any single view.** If an answer could have come from one file sorted
   descending, it is not worth returning.
5. **A caveat that has to be fetched will eventually not be fetched.** ⭐ Anything the model
   must *decide* to look up is not a safeguard. Caveats travel attached to the numbers they
   qualify (§4b, layer 2); the lookup tool is a fallback, never the guarantee.
6. **Every claim carries its own evidence.** ✅ José: clickable, opening the highlighted rows
   or the chart behind the number — in ~90% of answers he will want it. A number with no
   openable evidence behind it should not be in the prose.
7. **Context arrives late and by accident.** ✅ José: the biggest missing pieces surface only
   when a real situation forces them — exactly how the herbs cold room appeared, mid-example,
   in §2. The system must assume its knowledge is incomplete **by default**, and make capture
   cheap at the moment of discovery, rather than treating the knowledge base as something
   that ever gets finished.

---

## 8. Open design questions

- **Where do case studies and precedents live?** José raised that some context only appears
  when a real situation forces it. None of the existing tables hold "here is what happened
  and what we did about it". Probably needs a new one.
- **How does the assistant know what it does not know?** ⚠️ *Partly resolved by §4b.* For
  known unknowns it is now mechanical: anything touching a ❓ OPEN column gets
  `meaning: 'OPEN'` attached by the function, with no decision required of the model. What
  remains open is the **unknown** unknown — a column whose name reads as obvious and whose
  meaning we have not yet questioned. `receives_bonus` was one, and was caught only because
  José happened to mention it. There is no systematic detector for the next one; the mitigation
  is the placement discipline in §4b plus periodic audit passes.
- **How is `prompt_versions` used once the base starts changing?** It exists and has never
  been bumped. If knowledge accrues weekly, findings need to record which version produced
  them, or old findings become unreproducible.
- **What is the review burden?** Propose-then-approve is right, but if it generates twenty
  approvals a week it will be abandoned. Needs batching, or a threshold below which things
  are not worth proposing.
