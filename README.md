# Calii Ops Weekly

Internal weekly KPI app for Calii operations. Single-user (Jose). Each Friday, upload CSVs from Retool, the app validates, computes KPIs, and surfaces AI-generated priorities for the week.

Architecture: Next.js 14 (App Router) + Supabase (Postgres + Storage + Auth) + Anthropic API (Claude Haiku for row classification, Claude Sonnet for weekly insights). Deployed on Vercel.

See `../calii-ops-app-proposal.md` for the full design (v7).

---

## Local setup

Prerequisites: Node 20+, pnpm or npm, Supabase CLI (`brew install supabase/tap/supabase`), an Anthropic API key.

```bash
# 1. Install deps
npm install

# 2. Configure env
cp .env.example .env.local
# fill in NEXT_PUBLIC_SUPABASE_URL, anon/service keys, ANTHROPIC_API_KEY

# 3. Start Supabase locally (alternatively, use a hosted project)
supabase start
# → grab the local API URL + anon/service-role keys from the output and put in .env.local

# 4. Run migrations + seed
supabase db reset            # applies all migrations + seed in order

# 5. Create your user (single-user app)
# Option A — Supabase Studio: http://localhost:54323 → Authentication → Add user
#   Email: jose.romero@calii.com (must match APP_OWNER_EMAIL in .env.local)
#   Auto-confirm: yes
#   Password: pick something
# Option B — CLI:
supabase auth users create jose.romero@calii.com --password 'your-pass-here' --auto-confirm

# 6. Run the dev server
npm run dev
# → http://localhost:3000 (redirects to /login on first hit)
```

After signing in, navigate to **/upload** to push the sample CSVs from `../uploads/` for week vie 17 — jue 23 abr.

---

## Project layout

```
app/                       Next.js App Router pages
  layout.tsx               Root layout: sidebar shell, fonts, theme
  globals.css              Global styles + design tokens
  upload/                  Subir archivos
  historicos/              Históricos & análisis (3 tabs)
  prioridades/             Prioridades AI (vista normal + modo foco)
  config/                  Configuración (apps, KPIs, contexto, reglas)
  api/                     Route handlers (server-only)
    upload/                CSV upload + validate + persist
    insights/              Anthropic API calls
    kpi-snapshots/         Computation triggers
components/                Shared React components
lib/
  supabase.ts              Browser client
  supabase-server.ts       Server client (service role for admin ops)
  types.ts                 Shared TypeScript types (tables, KPIs)
  validate.ts              Header / type / distribution validation
  kpi.ts                   KPI catalog + formula evaluation
  prompts/                 LLM system prompts (versioned)
supabase/
  migrations/              SQL migrations applied in order
    20260427000001_registry_schema.sql
    20260427000002_data_schema.sql
    20260427000003_seed_registry.sql
scripts/
  seed-sample-uploads.ts   Load the original sample CSVs as week 17 data
```

---

## Weekly workflow (production)

Every Friday morning:
1. Open the app (Vercel-hosted, password-protected).
2. **Subir archivos** tab — week selector defaults to the just-completed Fri–Thu; drag-and-drop the 20 CSVs from Retool (5 apps × per-city/per-hub). Validation runs immediately; warnings show inline.
3. Once all uploads are accepted, click **Regenerar insights** (or wait for the cron at 1pm).
4. Review **Prioridades** — AI top-3 per view + focus mode for whatever the CEO is asking about that week.
5. Use **Históricos** during 1:1s with coordinators (Por hub tab).

### Backfill / past-week uploads

CSVs carry no embedded date — Jose explicitly selects which week each file belongs to. The week selector at the top of **Subir archivos** has chips for the last 4 weeks plus a "+ Seleccionar otra semana" button that opens a date picker. Pick any past Friday and all dropzones below upload into that week.

Use cases:
- **Initial backfill** — load 12+ historical weeks before launch so peer comparisons and anomaly detection have context.
- **Vacation catch-up** — back from 3 weeks off, drop the missed CSVs week by week.
- **Re-upload** — same slot + same week replaces the prior version; `audit_log` records both.

---

## Adding a new Retool app

UI flow (Configuración → Apps & KPIs → "+ Registrar nueva app"):
1. Name + scope (total / per_city / per_hub).
2. Upload sample CSV — auto-detects columns and types.
3. Define KPIs from the columns: name, formula, unit, direction, owner role, category.
4. Save. The new app's tile appears in the upload hub for next week.

No code changes needed. The new KPIs flow into snapshots, peer comparisons, and AI insights automatically.

---

## Editing the AI

Configuración → Reglas:
- **Behavior rules** — the AI's standing instructions (peer-grouping rules, headline format, cross-team scope, etc.).
- **Scope rules** — patterns to flag rather than recommend (negotiations → Compras, tier changes → Compras, etc.).
- **Headline examples** — few-shot good/bad examples that shape the model's output.

Saving any rule bumps `prompt_version`. Click **Regenerar insights** to apply to the current week. Older insights stay in the audit trail.

Configuración → Contexto AI:
- 6 markdown sections (Calii overview, supply chain, hub structure, cross-team scope, metric nuances, week definition). Edit any section, save, regenerate.

---

## Cost ceiling

- Vercel free tier: $0
- Supabase free tier: $0 up to ~500 MB storage / 2 GB egress / 50k monthly auth (we'll use ~5)
- Anthropic API: ~$0.50–$2 / week (≈ $5–10 / month)

Total expected: under $10/month for the first year.

---

## Production deployment (Vercel + hosted Supabase)

One-time setup, ~30 minutes. After that, every `git push` redeploys.

### 1. Create the hosted Supabase project

1. Go to **supabase.com** → New project → pick a region close to MX (e.g., `us-east-1` or `us-west-1`).
2. Save the database password somewhere; you'll need it for migrations.
3. Once provisioned, grab three values from **Project Settings → API**:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` `public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` `secret` key → `SUPABASE_SERVICE_ROLE_KEY`

### 2. Push migrations to the hosted project

```bash
# Link your local repo to the hosted project
supabase login
supabase link --project-ref <your-ref>     # ref is in the project URL

# Push all migrations
supabase db push
```

This applies migrations 001-005 (registry schema, data schema, seed registry, storage bucket, RLS).

### 3. Create the owner user in hosted Supabase

Supabase Studio (the hosted dashboard) → **Authentication → Users → Add user**:
- Email: `jose.romero@calii.com` (must match `APP_OWNER_EMAIL` env var)
- Auto-confirm user: ✅
- Pick a strong password.

### 4. Push the repo to GitHub

```bash
git init
git add -A
git commit -m "Initial Calii Ops Weekly v1"
gh repo create calii-ops-app --private --source=. --push
```

### 5. Deploy on Vercel

1. **vercel.com** → Add New Project → Import the GitHub repo.
2. Framework preset: **Next.js** (auto-detected).
3. Add environment variables (Settings → Environment Variables):

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | from step 1 |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from step 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | from step 1 (mark as **Sensitive**) |
   | `ANTHROPIC_API_KEY` | from console.anthropic.com (mark as **Sensitive**) |
   | `ANTHROPIC_MODEL_HAIKU` | `claude-haiku-4-5-20251001` |
   | `ANTHROPIC_MODEL_SONNET` | `claude-sonnet-4-6` |
   | `APP_OWNER_EMAIL` | `jose.romero@calii.com` |
   | `NEXT_PUBLIC_SITE_URL` | `https://your-app.vercel.app` (update after first deploy) |

4. Deploy. Vercel will give you a URL like `calii-ops-app.vercel.app`. Update `NEXT_PUBLIC_SITE_URL` to that exact URL and redeploy (so sign-out redirects work correctly).

### 6. (Optional) Custom domain

In Vercel **Settings → Domains** add `ops.calii.com` (or whatever subdomain you control). Vercel handles the SSL cert automatically. Update `NEXT_PUBLIC_SITE_URL` accordingly and redeploy.

### 7. Smoke test

1. Open the Vercel URL → redirects to `/login`.
2. Sign in with the email/password you created in step 3.
3. `/upload` should load with all 5 app tiles + 20 empty slots for the current week.
4. Drop one of the sample CSVs from `../uploads/` (the original five from the discovery phase).
5. Click **Recomputar snapshots** → should write rows to `kpi_snapshots`.
6. Open `/prioridades` → click **Generar insights** → wait ~30s → cards appear.

### Weekly cron (later)

Add a Vercel Cron in `vercel.json` to auto-recompute and regenerate Friday afternoons:

```json
{
  "crons": [
    { "path": "/api/cron/finalize-week", "schedule": "0 19 * * 5" }
  ]
}
```

The endpoint isn't built yet — added in a follow-up. For now, click the buttons manually after Friday's uploads.

### Cost ceiling

- Vercel free tier: $0
- Supabase free tier: $0 up to ~500 MB storage + 2 GB egress + 50k MAU
- Anthropic: ~$0.50–$2/week with normal volumes

Total expected: under **$10/month** for the first year, comfortably.
