-- ============================================================================
-- Migration 002: Data schema
-- The "what happened" tables — uploads, raw rows, snapshots, AI insights.
-- Grow with every weekly upload.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Uploads — one row per uploaded CSV
-- week_start is the FRIDAY of the Fri–Thu operative week (§11.4b)
-- ----------------------------------------------------------------------------
create type upload_status as enum ('pending', 'validated', 'rejected');

create table uploads (
  id                uuid primary key default gen_random_uuid(),
  app_id            text not null references apps(id),
  week_start        date not null,                -- always a Friday
  city              city,                          -- nullable when scope='total'/'per_hub'
  hub_id            text references hubs(id),     -- nullable unless scope='per_hub'
  uploaded_at       timestamptz not null default now(),
  uploaded_by       text not null,
  file_storage_path text not null,                -- path in Supabase Storage bucket
  file_size_bytes   bigint,
  row_count         int,
  status            upload_status not null default 'pending',
  validation_report jsonb,                         -- {warnings: [...], errors: [...]}
  prompt_version    int,                           -- captured at ingest for AI traceability
  created_at        timestamptz not null default now(),

  -- One slot per (app, week, city, hub). Re-uploads supersede.
  unique (app_id, week_start, city, hub_id)
);

create index uploads_week_idx on uploads(week_start desc);
create index uploads_app_week_idx on uploads(app_id, week_start desc);

-- ----------------------------------------------------------------------------
-- Upload rows — generic JSONB store of every CSV row
-- The shape is the row keyed by column name, so adding a new app needs no
-- schema change. JSONB GIN index makes filtering fast.
-- ----------------------------------------------------------------------------
create table upload_rows (
  id            bigserial primary key,
  upload_id     uuid not null references uploads(id) on delete cascade,
  row_index     int not null,                  -- 0-based position in the source CSV
  data          jsonb not null,                -- the full row
  labels        jsonb,                          -- AI classification labels (Haiku output)
  is_excluded   boolean not null default false, -- e.g., test driver pattern matched
  exclusion_reason text,
  created_at    timestamptz not null default now(),
  unique (upload_id, row_index)
);

create index upload_rows_upload_idx on upload_rows(upload_id);
create index upload_rows_data_gin_idx on upload_rows using gin (data);
create index upload_rows_labels_gin_idx on upload_rows using gin (labels);

-- ----------------------------------------------------------------------------
-- KPI snapshots — materialized weekly KPI values per slice
-- Read by charts and the AI. Recomputed when uploads finalize.
-- ----------------------------------------------------------------------------
create type snapshot_scope as enum ('global', 'city', 'hub', 'operator', 'driver', 'sku');

create table kpi_snapshots (
  id                uuid primary key default gen_random_uuid(),
  kpi_id            text not null references kpis(id) on delete cascade,
  week_start        date not null,                -- Friday
  scope_level       snapshot_scope not null,
  scope_key         text,                          -- null for global; hub_id, 'driver:4756', 'sku:SSQ938', etc.
  value             numeric,
  numerator         numeric,                       -- raw numerator (for ratio KPIs)
  denominator       numeric,                       -- raw denominator
  prev_week_value   numeric,                       -- for WoW deltas
  rolling_mean_4w   numeric,
  rolling_std_4w    numeric,
  computed_at       timestamptz not null default now(),

  unique (kpi_id, week_start, scope_level, scope_key)
);

create index kpi_snapshots_week_idx on kpi_snapshots(week_start desc);
create index kpi_snapshots_kpi_week_idx on kpi_snapshots(kpi_id, week_start desc);
create index kpi_snapshots_scope_idx on kpi_snapshots(scope_level, scope_key);

-- ----------------------------------------------------------------------------
-- Peer comparisons — pre-computed peer rankings & z-scores per entity per KPI
-- ----------------------------------------------------------------------------
create type entity_type as enum ('operator', 'driver', 'hub', 'sku', 'city');
create type peer_scope as enum ('within_hub', 'within_city', 'within_subdivision', 'global');

create table peer_comparisons (
  id            bigserial primary key,
  kpi_id        text not null references kpis(id) on delete cascade,
  week_start    date not null,
  entity_type   entity_type not null,
  entity_key    text not null,                  -- operator_id, driver_id, hub_id, sku, city
  scope_type    peer_scope not null,
  scope_key     text,                            -- e.g., 'mh_contry' for within_hub
  value         numeric,
  peer_mean     numeric,
  peer_p50      numeric,
  peer_p90      numeric,
  z_score       numeric,
  rank          int,
  rank_total    int,
  computed_at   timestamptz not null default now(),

  unique (kpi_id, week_start, entity_type, entity_key, scope_type, scope_key)
);

create index peer_comparisons_kpi_week_idx on peer_comparisons(kpi_id, week_start desc);
create index peer_comparisons_entity_idx on peer_comparisons(entity_type, entity_key);

-- ----------------------------------------------------------------------------
-- AI insights — persisted LLM output (weekly priorities + focus plans)
-- ----------------------------------------------------------------------------
create type insight_mode as enum ('weekly_priorities', 'focus_plan', 'reformulation');
create type insight_view as enum ('global', 'per_hub', 'per_category');

create table ai_insights (
  id                  uuid primary key default gen_random_uuid(),
  week_start          date not null,
  generated_at        timestamptz not null default now(),
  mode                insight_mode not null,
  focus_areas         text[],                   -- null for weekly_priorities; ['mna', 'faltantes', ...] for focus
  view                insight_view,             -- only for weekly_priorities mode
  view_key            text,                      -- hub_id or category
  rank                int,                       -- 1..N within (mode, view, view_key)
  kpi_id              text references kpis(id),  -- null for cross-KPI focus plans
  scope_type          peer_scope,
  scope_key           text,
  headline_es         text not null,
  evidence_md         text not null,
  recommended_actions_md text,
  flag_actions_md     text,                      -- separate from ops actions; routed to other teams
  linked_entities     jsonb,                     -- {operators:[...], skus:[...], drivers:[...], hubs:[...]}
  why_now_es          text,
  source_files        jsonb,                     -- [{file:'MNA_zapopan.csv', rows:'sem 17 (4891)', ...}]
  model_used          text not null,             -- 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001'
  prompt_version      int not null,
  cost_usd            numeric,
  user_feedback       text                        -- 'thumbs_up' | 'thumbs_down' | null
);

create index ai_insights_week_idx on ai_insights(week_start desc);
create index ai_insights_mode_idx on ai_insights(mode, week_start desc);

-- ----------------------------------------------------------------------------
-- Insight feedback — granular per-insight user feedback (thumbs, fuera-de-scope, edits)
-- ----------------------------------------------------------------------------
create type feedback_action as enum ('thumbs_up', 'thumbs_down', 'fuera_de_scope', 'reformular', 'editar', 'ya_resuelto');

create table insight_feedback (
  id           uuid primary key default gen_random_uuid(),
  insight_id   uuid not null references ai_insights(id) on delete cascade,
  action       feedback_action not null,
  who          text not null,
  notes        text,                              -- e.g., the new rule text proposed via "fuera de scope"
  created_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Annotations — Jose's notes on the timeline (📌 events, protocol changes, etc.)
-- ----------------------------------------------------------------------------
create table annotations (
  id          uuid primary key default gen_random_uuid(),
  week_start  date not null,                      -- Friday of the affected week
  pin_emoji   text default '📌',
  body_es     text not null,
  linked_kpis text[],                              -- KPIs this annotation contextualizes
  linked_hubs text[],                              -- subset of hub_ids
  who         text not null,
  created_at  timestamptz not null default now()
);

create index annotations_week_idx on annotations(week_start desc);

-- ----------------------------------------------------------------------------
-- Saved views — Jose's preferred filter combinations on Históricos
-- ----------------------------------------------------------------------------
create table saved_views (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  filters      jsonb not null,                   -- {kpi:'tasa_armado', city:'MTY', range:'12w', ...}
  is_default   boolean not null default false,
  display_order int not null default 100,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Helper view — current week (most recently uploaded Fri–Thu)
-- ----------------------------------------------------------------------------
create or replace view current_week as
  select max(week_start) as week_start from uploads where status = 'validated';

-- ----------------------------------------------------------------------------
-- Helper function — Friday of the week containing a given date
-- ----------------------------------------------------------------------------
create or replace function week_start_friday(d date) returns date language sql immutable as $$
  -- ISO weekday: Monday=1 ... Friday=5 ... Sunday=7
  -- Want: shift back to most recent Friday on or before d.
  select d - (((extract(isodow from d)::int - 5 + 7) % 7))::int
$$;

comment on function week_start_friday is
  'Returns the Friday of the operative Calii week (Fri–Thu) containing date d. If d is a Friday, returns d itself.';
