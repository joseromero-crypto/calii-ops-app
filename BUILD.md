# BUILD — Analysis Assistant

**Audience: a Claude Code session running inside this repo.** Not a human doc.
Run **one phase per session**. Each phase has a verification gate — do not start the next
phase until the gate passes.

## Read before touching anything

| File | Why |
|---|---|
| `HANDOFF.md` §12 | The footgun list. Most of it is load-bearing. |
| `DATA_DICTIONARY.md` | What every column *means*, with ✅/⚠️/🔶/❓ status. **Never use a column marked 🔶 or ❓ without flagging it.** |
| `OPS_CONTEXT.md` | How the operation works. §5b/§5c carry corrections to the data's meaning. |
| `ASSISTANT_DESIGN.md` | Behavioural requirements. **If this and `ARCHITECTURE.md` disagree, this wins.** |
| `ARCHITECTURE.md` | The design being built. |
| `scripts/investigate-hub.ts` | **The reference implementation of the analysis.** Phase 2 is largely lifting this into `lib/`. |

## Repo rules that will bite you

Verbatim from `HANDOFF.md`, restated because they are easy to violate:

- **Never `ORDER BY id` on `upload_rows`.** Triggers a full table sort and a Supabase
  statement timeout (~8 s) on weeks with 25+ uploads. Fetch **one `upload_id` at a time**.
- **Upserts: sequential 200-row batches.** `Promise.all` across batches caused lock
  contention and statement timeouts.
- **`peer_comparisons` has no `hub_id` column.** PostgREST returns `data: null` if you select
  a non-existent column. Use `scope_key`.
- **`pct` KPI values and `rolling_mean_4w` are stored as 0–1 fractions**, not percentages.
  `currency` is raw MXN.
- **Every new route needs a `loading.tsx`.** Without it Next blocks navigation.
- **Never `router.push` inside `/historicos`** — it re-runs every Supabase query. Use
  `history.pushState`.
- **RLS policies go in the same migration as the table.** This was forgotten twice
  (`person_tenure`, `kpi_ramp_targets`) and needed follow-up migrations.
- **`.eq('is_excluded', false)` on `upload_rows`** — and apply it symmetrically when comparing
  two files, or you compare filtered against unfiltered.

---

# Phase 0 — Fix what is known to be wrong

Small, isolated, unblocks everything.

### 0.1 `lib/normalize.ts` — strip the nickname parenthetical
`desempeno_operadores.assembler` and `faltantes_armador.Armador` are
`Nombre Completo ("Apodo")`. `incidentes.Operador` is a plain name. `normalizeName()` does not
strip the parenthetical, so **the person join across those files matches 0 of 2,845 rows.**

Add before the existing normalisation:
```ts
.replace(/\s*\(\s*["“][^"”]*["”]\s*\)\s*$/, '')
```
⚠️ `lib/tenure.ts` joins on this function. **Check the tenure ledger still derives the same
result** before and after — run `npx tsx scripts/tenure-dry-run.ts` both ways and diff.

### 0.2 `scripts/cross-checks.ts` — symmetric filtering
`opRows` filters `is_excluded = false`; `drvRows` does not. Fix, re-run, and update the Test B
verdict logic: it currently calls a match on the aggregate ratio alone. Require **both** a
ratio within ±10% **and** ≥60% of hub-weeks within ±5%.

### 0.3 `scripts/reverse-engineer.ts` — re-run the cross-file test
With 0.1 fixed, the `incidentes` hypothesis for `num_idle_days` can finally be tested. It was
never actually tested; "no derivation found" was a false negative.

### 0.4 `DATA_AUDIT.md` — correct stale claims
- §4.4 "idle is 43% of assembly-room time" — computed against
  `total_num_min_of_assembly`, now known to be the **legacy** clock. Mark unreliable.
- §5 item 1 (Panamericano) — it is a **dead rail**, not a broken reconciliation.
- The `error de recepción` cause rule — that cause lives in `registro de inventario`, which is
  not ingested.

**GATE:** tenure dry-run unchanged · cross-checks re-run with symmetric filters ·
`num_idle_days` either resolved or confirmed OPEN *with the join working*.

---

# Phase 0.5 — Model registry

Small, but do it before Phase 3 so nothing gets built against the wrong constants.

### 0.5.1 `lib/anthropic.ts` — upgrade and add Opus

`MODELS` is currently:
```ts
{ haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-4-6' }
```

Sonnet 5 is both newer and cheaper than 4.6. Add Opus 5 as its own entry — the assistant uses
a **mix** (`ARCHITECTURE.md` §7), not one model:

```ts
export const MODELS = {
  haiku:  'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-5',   // ⬅ was claude-sonnet-4-6
  opus:   'claude-opus-5',
} as const;
```
⚠️ **Resolve the exact published model IDs from the API before hardcoding these strings.**
List the models endpoint or check the pricing/models docs — do not trust the aliases above
verbatim.

### 0.5.2 `PRICES_PER_MTOK` — add the Opus entry

There is no Opus key today, so `estimateCost()` **silently falls back to Sonnet's rates** and
under-reports by ~2.5×. Per Mtok (input/output): Opus 5 **$5/$25** · Sonnet 5 **$2/$10** ·
Haiku 4.5 **$1/$5**.

⚠️ Also: 4.7+ models use a newer tokenizer that produces roughly **30% more tokens** for the
same text. Either note it in a comment or apply a correction factor — otherwise the `cost_usd`
column in `ARCHITECTURE.md` §6 reads low.

### 0.5.3 Who calls what

- **Opus** — the analysis turn in `/api/chat`: deciding what to look at next, discarding
  factors that don't discriminate, emergent grouping, judging whether a doubt is load-bearing
  enough to block. This is the product.
- **Sonnet 5** — tool routing and lookups (`lookupColumn`, `lookupContext`, registry reads).
  The majority of round trips, and mechanical.
- **Haiku** — leave the existing callers (`generate-insights.ts` etc.) alone unless they break.

Cost is not the constraint at this volume. Putting raw rows or the full markdown docs into
context on every question **is** — see "Things NOT to do".

**GATE:** existing `generate-insights.ts` and `generar-reporte` still run on the new IDs ·
`estimateCost` returns Opus rates for an Opus call.

---

# Phase 1 — ETL: `order_deliveries`

⭐ **The highest-value item in the whole plan, and it involves no AI.**

`desempeno_repartidores.orders_data` is a JSON array, ~57 entries per driver-week, ~**100,000
order records** across the history, marked `role: 'ignored'` and read by nothing.

Each entry (spec in `DATA_DICTIONARY.md`):
```json
{ "user_name": "...", "delivered_at": "2026-08-07T16:54:02.412-06:00",
  "delivery_date_str": "Ago-7", "delivery_window_time": "4pm - 6pm",
  "delivery_window_start_date_time": "2026-08-07T15:59:59.999-06:00",
  "minutes_delivered_late_or_early": 0 }
```

### Build
1. **Migration** `order_deliveries` — `week_start · hub_id · driver_name · user_name ·
   delivered_at timestamptz · window_start timestamptz · window_label text ·
   minutes_late int · upload_id`. Index on `(hub_id, week_start)` and `(week_start)`.
   **RLS policy in the same migration.**
2. **`lib/etl/order-deliveries.ts`** — flatten per upload, one `upload_id` at a time,
   sequential 200-row upserts.
3. Wire into `app/api/upload/route.ts` after validation, and add a backfill script
   `scripts/backfill-order-deliveries.ts` for the existing 23 weeks.

### Watch for
- `delivered_at` is **98% filled** — 2% null. Never assume presence.
- Timestamps carry a `-06:00` offset. Store as `timestamptz`; do not strip it.
- `delivery_date_str` is a Spanish display string (`Ago-7`). **Ignore it** — parse the real
  timestamps.
- `minutes_delivered_late_or_early` is **signed** — negative is early.
- `hub_id` comes from the parent row's `hub` column via `resolveHubId`, not from the blob.

**GATE:** row count ≈ 100k · `minutes_late` distribution looks sane · a spot-checked
driver-week reconciles against that row's `num_late_orders`.
**This alone makes the Dec-2025 delivery targets (>30 min ≤5%, >60 min ≤1%) measurable for the
first time — worth surfacing in `/historicos` even before any chat exists.**

---

# Phase 2 — Analysis functions ⭐ THE CHECKPOINT

**Pure functions in `lib/analysis/`. No AI. No API routes. No UI.**

Port from `scripts/investigate-hub.ts`, which already implements the method.

```
lib/analysis/
  registry.ts      listHubs · listKpis · listWeeks
  kpis.ts          kpiTrend · kpiByHub · peerRanking
  faltantes.ts     faltantesBreakdown · faltantesProductLift · faltantesByPerson
  quality.ts       complaintsByProduct        (needs product_complaints ETL)
  delivery.ts      deliveryLateness            (needs Phase 1)
  workforce.ts     attendanceByHub · auxAssemblyLoad
  inventory.ts     mnaBreakdown · stockCover
  discriminate.ts  ⭐ the discriminator
  types.ts
```

### Every function must
- Return in **well under 8 s**. Filter by hub and week in the query, never in JS after a full
  scan.
- Return a **small structured object**, never raw rows.
- **Carry its own confidence metadata** — `{ data, confidence: { coverage, meaning,
  statistical, causal }, caveats: string[] }`. A function touching `num_idle_days` returns
  `meaning: 'OPEN'` and says why.
- Attach the **comparability warnings** automatically: any cross-hub comparison involving
  `mh_guadalupe` on FyV, or Zapopan/Condesa on inventory quality, carries the caveat
  (`OPS_CONTEXT.md` §2–3).
- ⭐ **Emit `provenance` and `claims`** — the full shape is in `ARCHITECTURE.md` §4.
  `provenance` = source files/columns, `rows_in`/`rows_out`, filters applied. `claims[]` =
  one entry per assertable number, each with a **re-runnable `evidence.refetch`** and the
  column to highlight.

> ### Why these two are not optional
> `caveats` is layer 2 of `ASSISTANT_DESIGN.md` §4b — **the only thing standing between a
> 🔶/❓ column and an unflagged conclusion.** A lookup tool the model must choose to call is
> not a safeguard; it looks up what it knows it doesn't know, and misses columns whose names
> read as obvious (`receives_bonus`).
>
> `claims` is what makes every number in the chat clickable. It is generated **in code, in
> the same pass as the number** — never narrated by the model afterwards, because a narrated
> derivation can be wrong about itself. Rows never go to the model; the UI resolves
> `refetch` on click (Phase 4).

### `discriminate.ts` is the important one
It is what stops this being a CSV sort (`ASSISTANT_DESIGN.md` §7.4). Port `investigate-hub.ts`
§5: for each candidate factor return the hub value, the peer mean, the **cross-hub rank
correlation**, and a verdict. **7 hubs = 7 points — the correlation is a lead, never proof, and
the function must say so in `caveats`.**

### Tests
`node:assert`, following `scripts/test-tenure.ts` (no test framework in this repo). At minimum:

- Each function returns inside the time budget.
- The confidence block is always populated.
- `discriminate` correctly rejects a factor that is large everywhere.
- ⭐ **A cross-hub FyV comparison including `mh_guadalupe` returns the comparability caveat**
  in `caveats` — assert on the array, not on prose.
- ⭐ **Any function touching `num_idle_days` returns `meaning: 'OPEN'`.**
- ⭐ **Every numeric result has at least one `claim`, and every claim's `evidence.refetch`
  actually re-runs and returns rows** — assert `rows_out` matches the claim's count.

**GATE — the real one.** Call these directly from a script and show José the output. **If the
answers are not useful when called directly, no chat UI will save them.** Do not start Phase 3
until that has been checked with him.

---

# Phase 3 — API: the agent loop

No UI. Verify with `curl`.

- **`app/api/tools/[name]/route.ts`** — thin auth + zod-validated dispatch into
  `lib/analysis/`. `maxDuration = 60`.
- **`app/api/chat/route.ts`** — one model turn. Takes conversation + tool results, returns
  either prose or a `tool_use`. **Streams.** `maxDuration = 120`.
  Takes a `mode` — `'analysis'` routes to `MODELS.opus`, `'routing'` to `MODELS.sonnet`
  (Phase 0.5). Default to `opus` when ambiguous; a wrong-way-cheap answer is the failure mode
  that matters, not a wrong-way-expensive one.
- **The client drives the loop** (`ARCHITECTURE.md` §2). The server never loops — that is what
  keeps a 5-minute investigation possible.
- **`lookupColumn` / `lookupContext` are tools**, not a prompt dump. Parse the markdown docs
  at build time into a lookup table. System prompt stays **5–8k tokens**.

⚠️ **Check the SDK first.** `@anthropic-ai/sdk` is at `^0.39.0`, which predates the
prompt-caching and tool-use ergonomics this depends on. Upgrade and re-verify
`generate-insights.ts` and `generar-reporte` still work.

- **`app/api/evidence/route.ts`** — resolves a persisted `claims.evidence.refetch` into rows
  or a chart population. Called by the **UI on click**, never by the model.
  `maxDuration = 60`, and the query must stay inside the 8 s Supabase budget.
- **System prompt = layer 1 only** (`ASSISTANT_DESIGN.md` §4b): the always-on traps, the
  method, the confidence axes. `lookupColumn`/`lookupContext` are a fallback tool, **not**
  where the safety comes from — that is the `caveats` the Phase 2 functions already attach.

**Persist as you go** — `conversations`, `messages`, `tool_calls`, `claims`, `artifacts` per
`ARCHITECTURE.md` §6. Record `prompt_version`, `input_tokens`, `output_tokens`, `cost_usd` on
every message. Store `tool_calls` verbatim **including `provenance`**, and persist `claims`
so a month-old thread's evidence still opens when resumed: *"show me the query behind that
number"* must be answerable.

**GATE:** a curl'd question runs a multi-step loop, no request exceeds its budget, and the
persisted `tool_calls` reproduce the answer.

---

# Phase 4 — UI

Three panes (`ARCHITECTURE.md` §1): threads · conversation · exhibition.
Follow the existing app's conventions — Tailwind, the `var(--muted)` / `var(--line)` tokens,
`loading.tsx`, client-side navigation via `history.pushState`.

- Stream tokens as they arrive; show each tool call as it runs, collapsed, expandable to its
  arguments and result.
- Exhibition pane renders `artifacts` — Recharts is already a dependency.
- Sidebar lists conversations, resumable **with tool results intact** (`ARCHITECTURE.md` §9).

### ⭐ Clickable claims

The model tags numbers in its prose with claim ids. Render each tagged number as a control;
clicking it calls `/api/evidence` and opens the result in the exhibition pane:

- `evidence.kind = 'rows'` → a table of the rows behind the claim, with
  `evidence.highlight` columns emphasised, and a **download-CSV** button.
- `evidence.kind = 'chart'` → the population behind an aggregate. Use this for anything
  spanning many rows — a 7-hub × 23-week comparison is a chart, not a 1,600-row table.

Also show, next to the evidence, the claim's `provenance`: source file, columns, filters
applied, `rows_in` → `rows_out`. That is the answer to *"how did we get there"*.

⚠️ **If the model emits a number with no claim id, render it plainly and log it.** A pattern
of untagged numbers means the Phase 2 functions aren't emitting claims for something the
model is asserting — a real bug, not a cosmetic one.

---

# Later phases

**5 — `proposeFact` + approval queue.** The write path for `context_sections` /
`behavior_rules`, which already exist, already feed `assembleSystemPrompt()`, and have never
been written to. Propose → José approves → store. Never auto-store
(`ASSISTANT_DESIGN.md` §6).

**6 — Ingest `#hub_fa` Slack.** Per-event faltante root cause + aux reply latency
(`OPS_CONTEXT.md` §5b). Channel not visible from the current Slack connection — solve access
first.

**7 — Ingest `Temperaturas y activos`** (Retool app `05dc1c4e-0bf8-11ef-b129-47cd115eefa8`).
Daily per-room readings against targets: ops 12° · hierbas 2° · lácteos 1° · stock 1 4° ·
stock 2 8°. Turns equipment causes from *suggested* into *confirmed with a date*.

---

# Things NOT to do

- **Do not give the model raw rows.** Tools return small structured results. This bounds both
  cost and hallucination.
- **Do not paste the markdown docs into the system prompt.** ~100 KB, and growing every
  session. They are lookup tools.
- **Do not build a server-side agent loop.** It caps investigation depth at one function
  duration.
- **Do not surface "the biggest number".** `ASSISTANT_DESIGN.md` §7.4 — if an answer could
  have come from one file sorted descending, it is not worth returning.
- **Do not add `San Rafael Puebla` to `lib/hub-aliases.ts`.** Deactivated for years. The
  `unrecognised hub label` warnings are correct behaviour.
- **Do not treat protocol targets as current.** José: outdated, reference only. Week-over-week
  is the primary signal.
- **Do not let a 🔶 or ❓ column produce an unflagged conclusion.** That is the one failure
  mode this whole project exists to prevent.
- **Do not route the analysis turn to Sonnet to save money.** The judgement steps are the
  product; the savings are on the order of $100/year (`ARCHITECTURE.md` §7).
- **Do not let the model narrate its own derivation.** `provenance` and `claims` are emitted
  by the analysis functions in code. A model-narrated derivation can be confidently wrong
  about itself, which is worse than no derivation at all.
- **Do not rely on `lookupColumn` for safety.** It is a fallback. Every caveat that matters is
  attached to the data by the function that returned it (`ASSISTANT_DESIGN.md` §4b).
