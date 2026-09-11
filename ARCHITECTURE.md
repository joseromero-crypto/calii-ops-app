# Calii Ops — Analysis Assistant Architecture

**Status:** sketch. Enough to argue with; not yet an implementation plan.
**Companions:** `DATA_AUDIT.md` (what exists) · `DATA_DICTIONARY.md` (what it means) ·
`OPS_CONTEXT.md` (how the operation works) · `ASSISTANT_DESIGN.md` (how it must behave).

Everything here is downstream of `ASSISTANT_DESIGN.md`. If the two disagree, that one wins —
it records what José actually asked for.

---

## 1. What this is

A chat surface inside the existing Next.js app. José opens it **any day of the week** when he
is working a hub or a KPI and wants to know *why* — not a Friday report generator, that
already exists and works (`ASSISTANT_DESIGN.md` §2).

Three panes:

```
┌──────────────┬───────────────────────────────┬──────────────────┐
│  Threads     │  Conversation                 │  Exhibition      │
│              │                               │                  │
│  · Contry FA │  ▸ tool: faltantesBreakdown   │   [chart]        │
│  · Cumbres   │  ▸ tool: productLift          │   [table]        │
│    MNA       │  ▸ tool: discriminate         │   [document]     │
│  · Herbs…    │                               │  ── evidence ──  │
│              │  "Contry's rate is 18.2 per   │   65 rows, col   │
│  + new       │   1k vs 11.4 peer mean…"      │   highlighted    │
│              │   ▲ every number is clickable │   [csv ↓]        │
└──────────────┴───────────────────────────────┴──────────────────┘
```

Threads persist and are resumable — which the learning loop needs anyway
(`ASSISTANT_DESIGN.md` §6).

**⭐ Every number in the prose is a claim, and every claim is clickable.** ✅ José, 2026-09-09:
*"I would def like clickable claims in the responses that open up evidence (either the csv
with highlighted rows or a graph showing the data analyzed that backs the response)"* — and
he expects to want it in **~90% of answers**, which settles the always-on vs on-request
question in favour of always-on. Mechanism in §4.

---

## 2. The core mechanism — an agent loop, not a request

### The constraints, measured not assumed

| Limit | Value | Evidence |
|---|---|---|
| Next/Netlify function duration | **120 s** | `app/api/insights/generate/route.ts` already sets `maxDuration = 120` |
| **Supabase statement timeout** | **~8 s** | HANDOFF §12 — real timeouts on `upload_rows` at 25+ uploads/week |
| **Total bytes moved per request** | the one that actually bit | HANDOFF §26 — `/historicos` sat at ~18 s until the data it fetched went 31.9 MB → 2.2 MB (704 ms). Two different *schedules* over the same bytes differed by 0.5% |
| Anthropic SDK in repo | `^0.39.0` | ⚠️ old; prompt caching + current tool-use ergonomics likely need an upgrade |

**The function duration is not the binding constraint. The 8-second statement timeout is** — per
query. Per *request*, the constraint that actually took `/historicos` down was total volume:
60+ cheap queries, none of them near the statement timeout, adding up to 31.9 MB and ~18 s.
Both limits are real and they fail differently; a design that respects the per-query budget can
still blow the per-request one. See HANDOFF §26.
That is a *per-query* budget, and it is why `kpi-compute.ts` fetches one upload at a time and
upserts in sequential 200-row batches, and why `deriveTenureLedger` does the same.

### The loop

```
  client                    /api/chat                /api/tools/<name>
    │                           │                            │
    ├── message ───────────────►│                            │
    │◄── tool_use ──────────────┤   (model decides)          │
    ├── execute ────────────────┼───────────────────────────►│  ONE bounded query
    │◄── result ────────────────┼────────────────────────────┤  well under 8 s
    ├── message + result ──────►│                            │
    │◄── tool_use ──────────────┤   (model decides again)    │
    │              … repeat …                                │
    │◄── final prose ───────────┤                            │
```

**The client holds the conversation and drives the loop.** Each hop is its own short request.
Total elapsed time is unbounded — minutes if the question deserves it — while **no single
request goes near a timeout.**

> This is exactly how the Cowork session that produced these documents works: every tool call
> is a separate bounded operation, and the whole thing ran for days.

### Why this is not the pattern `/prioridades` uses

`/prioridades` does **scope partitioning** — the client fires global / per-hub / per-category
independently, each generating 3 insights. *"Genera uno por uno por scope."* The split is
decided **in advance**.

That cannot work for chat: you don't know what the second step is until the first returns.
The agent loop is strictly more capable — it decides the next step from the last result.

**Stream the responses** (SSE) so José watches it work rather than a spinner, and **persist
every tool call and its result** so an answer can be audited later and a thread resumed with
its evidence intact.

---

## 3. ⭐ Context is a tool, not a prompt dump

`DATA_DICTIONARY.md` + `OPS_CONTEXT.md` are now **~100 KB**. Pasting them into every request
is expensive, and it gets worse every session — the exact opposite of "keeps learning".

**Instead: three layers — and the lookup tool is the smallest of them.**

| Layer | Size | Contents | Needs the model to *choose* to fetch it? |
|---|---|---|---|
| **1 — Always-on core** | ~5–8k tokens | Who José is · the operating rules (WoW primary, Pareto, finding+evidence+action) · the four confidence axes · **the method from `ASSISTANT_DESIGN.md` §2** · the file/grain map · **the traps that would poison any answer** — unit hazard on `Recibido`/`Inventario`/`MNA` across mixed `Kg/Pz` · Guadalupe not comparable on FyV · Zapopan/Condesa's extra auxiliar · marketplace invisible · `tipo_incidente` dead · `receives_bonus` is a defunct formula · protocol targets are stale | ❌ No |
| **2 — ⭐ Caveats attached to results** | per call | Every analysis function returns `{ data, confidence, caveats, provenance }`. The caveat for a column arrives **stapled to the number derived from it** — `faltantesBreakdown` on Guadalupe returns the comparability warning whether or not anyone asked; anything touching `num_idle_days` comes back `meaning: 'OPEN'`. | ❌ No |
| **3 — `lookupColumn` / `lookupContext`** | on demand | The dictionary or ops-context entry in full. **A fallback for gaps layer 2 doesn't cover — not a user-facing interface.** | ✅ Yes |

> ### Why layer 2 carries the weight
>
> An earlier draft leaned on layer 3 for safety. That was wrong, and José found the hole:
> **the model only looks up what it knows it doesn't know.** It will not look up
> `receives_bonus`, because the name looks self-explanatory — and it is a dead legacy
> formula nobody uses. The failure is never "couldn't find the caveat", it is *"didn't know
> there was one to look for"* — which a 100 KB prompt dump does not fix either, for the same
> reason. Only attaching the caveat at the moment the number is produced closes it.
>
> ### And José does not ask what columns mean
>
> ✅ José, 2026-09-09: he asks what a *data point* means — *"how did we get there and why"* —
> never what a column means. His own Contry example proves it: the useful answer was that 65
> of 130 faltantes had `Inventario disponible = 0`, and that column is system stock *at the
> moment of the report*, so those were already out of stock before an armador touched them.
> **The column meaning *was* the causal answer.** Dictionary entries are therefore not
> reference material to be queried — they are the raw material of every "why", and they must
> travel with the data (layer 2).
>
> Maintenance consequence: every new fact gets a **placement decision** — core warning,
> function caveat, or dictionary-only. Only the third is exposed to layer 3's reliability.
> Knowledge still grows without growing the prompt.

---

## 4. The tool catalogue

Derived from what `scripts/investigate-hub.ts` already does plus what the audit found. Every
tool must return in **well under 8 seconds** and return **small, structured** results.

### ⭐ The return shape every analysis tool obeys

```ts
{
  data:        <small structured result>,
  confidence:  { coverage, meaning, statistical, causal },   // §3 of ASSISTANT_DESIGN
  caveats:     string[],          // layer 2 — attached by the function, not fetched
  provenance: {
    tool:     'faltantesBreakdown',
    args:     { hub: 'mh_contry', weeks: [...] },
    source:   [{ file: 'faltantes_armador', columns: ['Inventario disponible', 'Notas'] }],
    rows_in:  4_812,              // rows the query scanned
    rows_out: 130,                // rows behind the claim
    filters:  ['is_excluded = false', 'hub = mh_contry', 'week in …'],
  },
  claims: [{
    id:    'c1',
    text:  '65 of 130 faltantes had Inventario disponible = 0',
    evidence: {                   // ⭐ what a click opens
      kind:      'rows' | 'chart',
      refetch:   { tool, args, predicate },   // re-runnable, bounded, <8 s
      highlight: ['Inventario disponible'],   // column that drove the classification
    },
  }],
}
```

**`provenance` and `claims` are emitted by the function — code, not the model.** They cost no
tokens and cannot drift from the number, because they are produced in the same pass that
produces it. The model's only job is to carry a claim `id` into the prose it writes.

**Rows are never sent to the model** (see §9 / "Things NOT to do"). `refetch` is executed by
the **UI**, on click, as its own bounded query. That is what keeps evidence-by-default free:
the evidence exists for every claim, but is only ever materialised for the one José opens.

### Registry — trivial
`listHubs()` · `listKpis()` · `listWeeks()`

### Aggregate reads — `kpi_snapshots` (36k rows) and `peer_comparisons`
- `kpiTrend(kpi, scope, key, weeks)` — the hub against **its own history** (the primary signal)
- `kpiByHub(kpi, weeks)` — cross-hub, **with the comparability warnings attached**
- `peerRanking(kpi, week, scopeType)` — entity-level z-scores, already computed

### Event-level — bounded queries over `upload_rows`
- `faltantesBreakdown(hub?, weeks)` — inventory split (=0 / >0 / <0 / null) + note clusters
- `faltantesProductLift(hub, weeks)` — ⭐ products over-represented **here vs peers**
- `faltantesByPerson(hub, weeks)` — per-armador rates, role accounts flagged
- `complaintsByProduct(hub?, weeks, category?)` — parsed `issues_comments`
- `deliveryLateness(hub?, weeks, bucket)` — from the flattened `orders_data`
- `attendanceByHub(weeks)` — unjustified vs justified, from the armador/driver files
- `auxAssemblyLoad(hub?, weeks)` — role-account share of assembly, **vs the Mon/Tue/Sun rota**
- `mnaBreakdown(hub, weeks, category?|tier?)` — SKU-level merma from the pre-aggregate
- `stockCover(hub, sku?)` — `Inventario ÷ Consumo/día`, derivation proven

### ⭐ The discriminator — the tool that makes this not a CSV sort
```
discriminate(metric, hub, weeks, candidates[])
  → for each candidate: hub value, peer mean, cross-hub rank correlation,
    and the verdict — DISCRIMINATES / correlates-but-not-an-outlier /
    outlier-but-no-relationship / neither
```
This is `investigate-hub.ts` §5 lifted into a tool. **It is what enforces
`ASSISTANT_DESIGN.md` §7.4** — never return what a CSV sort would find. A component that is
large everywhere explains nothing about why *this* hub differs.

### Output
`makeChart(spec)` · `makeTable(rows)` · `saveDocument(md)` → rendered in the exhibition pane.

### Evidence — the click path
`fetchEvidence(claimRef)` — resolves a stored `claims[].evidence.refetch` into either the
underlying rows (rendered as a table with the driving column highlighted, downloadable as CSV)
or a chart of the population behind an aggregate. **Called by the UI, never by the model.**

Aggregate claims spanning many rows — a 7-hub × 23-week peer comparison — resolve to a
**chart**, not a 1,600-row table. The function decides which, via `evidence.kind`.

### Learning
`proposeFact(kind, subject, body)` → **queued for José's approval**, never auto-stored
(`ASSISTANT_DESIGN.md` §6). On approval it writes to `context_sections` / `behavior_rules` —
tables that already exist, already feed `assembleSystemPrompt()`, and have **never been
written to**.

---

## 5. Data layer — what must be precomputed

The 8-second budget decides this, and the answer is narrower than expected.

### Query-time is fine (small enough as-is)
`kpi_snapshots` 36k · `faltantes_armador` 11k · `incidentes` 16k ·
`desempeno_operadores` 2.8k · `desempeno_repartidores` 1.8k · `discrepancia` 1.9k ·
`peer_comparisons` 195k *(with hub/week filters)*

### Must be precomputed
| New table | From | Rows | Why |
|---|---|---|---|
| **`order_deliveries`** | flatten `orders_data` JSON | **~100k** | ⭐ per-order `minutes_delivered_late_or_early` + window. Cannot be parsed per request. **Makes the Dec-2025 targets (>30 min ≤5%, >60 min ≤1%) measurable for the first time.** |
| **`product_complaints`** | split `issues_comments` on `\|` | ~10k | Category · product · comment · hub · week · armador · driver |
| **`mna_agg`** | roll up `mna` | ~40k | 670k raw rows is 96% of the DB and will never fit an 8s query |

All three build on upload, or nightly. None needs a model.

> **`order_deliveries` is the highest-value thing on this list** and it is pure ETL — no AI,
> no new upstream data, no schema change upstream. `DATA_DICTIONARY.md` has the field spec.

---

## 6. Persistence

```sql
conversations   id · title · created_at · updated_at · archived
messages        id · conversation_id · role · content · created_at
                  · prompt_version        -- which knowledge produced this
                  · input_tokens · output_tokens · cost_usd
tool_calls      id · message_id · tool_name · args jsonb · result jsonb
                  · provenance jsonb      -- source files/columns, rows_in/out, filters
                  · duration_ms · error
claims          id · message_id · tool_call_id · text
                  · evidence jsonb        -- { kind, refetch, highlight } — see §4
                  -- the click target. Persisted, so an old thread's evidence
                  -- still opens when resumed.
artifacts       id · message_id · kind (chart|table|document) · spec jsonb
fact_proposals  id · message_id · kind · subject · body
                  · status (pending|approved|rejected) · decided_at
```

`prompt_version` on every message is what makes an old answer reproducible once the knowledge
base starts changing — the open question in `ASSISTANT_DESIGN.md` §8.

Storing `tool_calls` verbatim is what lets an answer be **audited**: "show me the query behind
that number" has to be answerable, or the confidence machinery is theatre.

---

## 7. Which model does what

**A mix, not one model.** The reasoning-heavy steps and the retrieval steps have very
different requirements, and most round trips are retrieval.

| Job | Model | Why |
|---|---|---|
| **Analysis + synthesis** — deciding what to look at next, ⭐ **discarding what doesn't discriminate**, emergent grouping ("herbs"), judging whether a doubt is load-bearing enough to block | **Opus** | These are the product. A weaker model returns "here's the biggest number", which is the exact failure `ASSISTANT_DESIGN.md` §7.4 exists to prevent — and it bluffs rather than blocking when unsure. |
| **Tool routing + lookups** — `lookupColumn`, `lookupContext`, `listHubs`, deciding which of a known set of tools answers a known sub-question | **Sonnet 5** *(or Haiku for pure lookups)* | Mechanical. The majority of round trips. No judgement involved. |

> ⚠️ **The repo is pinned to `claude-sonnet-4-6`.** Sonnet 5 is both newer and cheaper
> ($2/$10 vs $3/$15 per Mtok). Upgrade — see `BUILD.md` Phase 0.5.
>
> ⚠️ **`lib/anthropic.ts` will under-report cost.** `PRICES_PER_MTOK` has no Opus entry, so
> `estimateCost` silently falls back to Sonnet's rates. It also does not account for the
> newer tokenizer on 4.7+ models (~30% more tokens for the same text). Fix before trusting
> the `cost_usd` column in §6.

**Cost is not the constraint** at this volume — the spread between an all-Sonnet and an
Opus-analysis setup is on the order of $100/year. What *would* make it expensive is putting
raw rows or the full documentation into context on every question, which §3 and §4 exist to
prevent.

## 8. Build order

Each phase is independently useful. Stop after any one and something works.

| # | Phase | Delivers |
|---|---|---|
| **0** | **Correct what's known wrong** — `normalizeName` parenthetical, `is_excluded` asymmetry in `cross-checks`, stale `DATA_AUDIT.md` claims | Everything downstream rests on it |
| **1** | **ETL: `order_deliveries`** | Per-order lateness. Immediately useful in the *existing* dashboard, chat or no chat |
| **2** | **Tools as plain functions in `lib/analysis/`** + unit tests | The analysis works and is verifiable **before any AI is involved** |
| **3** | **`/api/chat` agent loop + `/api/tools/*`**, no UI — curl it | Proves the loop and the timeouts |
| **4** | **Chat UI** — three panes, streaming, persistence | The product |
| **5** | **`proposeFact` + approval queue** | The learning loop; the write path those empty tables have been waiting for |
| **6** | **Ingest `#hub_fa` Slack** | Faltante root causes + aux reply latency (`OPS_CONTEXT.md` §5b) |
| **7** | **Ingest `Temperaturas y activos`** | Equipment causes become confirmable with a date |

> **Phase 2 is the real checkpoint.** If the analysis functions produce answers José finds
> useful when called directly, the chat is a wrapper. If they don't, no amount of chat UI
> saves it. `scripts/investigate-hub.ts` is the prototype of that phase — running it once is
> the cheapest possible test of the whole premise.

---

## 9. Open decisions

- **Where does the loop run?** Client-orchestrated (simple, resumable, survives a closed tab
  badly) vs a server-side loop inside one 120s function (fewer round trips, but caps the depth
  at 120s). **Client-orchestration is the recommendation** — it is the only option that makes
  a 5-minute investigation possible.
- **SDK upgrade.** `^0.39.0` predates the prompt-caching and tool-use ergonomics this depends
  on. Needs checking before phase 3.
- **Does the model get raw rows, ever?** Current answer: no — only tool results. That is what
  bounds both cost and hallucination. Revisit only with a concrete case.
- **Thread titles** — model-generated or first message? Trivial, but it's the sidebar's UX.
- **What happens on a blocked doubt?** `ASSISTANT_DESIGN.md` §5 says stop and ask. In a chat
  that is natural — but the thread must be resumable **with its tool results intact**, or
  answering the question costs the whole investigation.
