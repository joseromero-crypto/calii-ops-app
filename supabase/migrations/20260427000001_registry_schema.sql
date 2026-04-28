-- ============================================================================
-- Migration 001: Registry schema
-- The "what exists" tables — apps, hubs, KPIs, rules. Edited via the
-- Configuración page; rarely change unless Jose adds an app or rule.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- Cities & subdivisions (controlled vocabularies)
-- ----------------------------------------------------------------------------
create type city as enum ('Monterrey', 'Saltillo', 'Guadalajara', 'CDMX');

create table subdivisions (
  id           text primary key,            -- 'graneles_abarrotes' | 'carnes' | 'frutas_verduras'
  name_es      text not null,
  description  text,
  active       boolean not null default true
);

-- ----------------------------------------------------------------------------
-- Hubs — 7 micro-hubs across 4 cities (CH Guadalupe excluded)
-- ----------------------------------------------------------------------------
create table hubs (
  id           text primary key,            -- 'mh_contry', 'mh_cumbres', etc.
  display_name text not null,
  city         city not null,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Hub roles — drives ownership routing for AI recommendations
-- ----------------------------------------------------------------------------
create table hub_roles (
  id              text primary key,         -- 'coordinador', 'aux_inventarios', ...
  name_es         text not null,
  scope           text not null,            -- 'per_hub' | 'per_hub_per_subdivision' | 'per_shift'
  responsibilities text,
  active          boolean not null default true
);

-- ----------------------------------------------------------------------------
-- Cross-team scope — Operaciones vs Compras vs Comercial vs Tecnología
-- Drives "Flag a [equipo]" routing.
-- ----------------------------------------------------------------------------
create table teams (
  id          text primary key,             -- 'operaciones' | 'compras' | 'comercial' | 'tecnologia'
  name_es     text not null,
  decides     text,                          -- what this team owns
  active      boolean not null default true
);

-- ----------------------------------------------------------------------------
-- Apps — Retool apps that produce CSVs
-- ----------------------------------------------------------------------------
create type app_scope as enum ('total', 'per_city', 'per_hub');

create table apps (
  id                       text primary key,    -- 'desempeno_operadores', 'mna', ...
  name_es                  text not null,
  scope                    app_scope not null,
  expected_files_per_week  int not null,        -- 1 (total) | 4 (cities) | 7 (hubs)
  description              text,
  active                   boolean not null default true,
  created_at               timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- App columns — the schema each CSV must conform to
-- ----------------------------------------------------------------------------
create type column_type as enum ('string', 'int', 'float', 'bool', 'datetime', 'json', 'list');
create type column_role as enum ('dimension', 'metric', 'free_text', 'id', 'ignored');

create table app_columns (
  id          uuid primary key default gen_random_uuid(),
  app_id      text not null references apps(id) on delete cascade,
  position    int not null,                -- column order in the CSV (0-indexed)
  name        text not null,                -- header string from CSV
  type        column_type not null,
  role        column_role not null default 'metric',
  required    boolean not null default true,
  notes       text,
  unique (app_id, position),
  unique (app_id, name)
);

create index app_columns_app_idx on app_columns(app_id);

-- ----------------------------------------------------------------------------
-- KPI catalog — every KPI the system knows about
-- ----------------------------------------------------------------------------
create type kpi_unit as enum ('pct', 'count', 'currency', 'rate', 'minutes', 'days');
create type kpi_direction as enum ('lower_is_better', 'higher_is_better');

create table kpis (
  id                 text primary key,           -- 'mna_pct', 'tasa_armado', ...
  name_es            text not null,
  source_app_id      text references apps(id) on delete restrict,
  parent_kpi_id      text references kpis(id),    -- for breakdown KPIs (Calidad → Inc Manuales)
  formula_sql        text,                         -- SQL expression evaluated against upload_rows JSONB
  numerator_field    text,                         -- shorthand: numerator column for ratio KPIs
  denominator_field  text,                         -- shorthand: denominator column
  unit               kpi_unit not null,
  direction          kpi_direction not null,
  category           text not null,                -- 'calidad' | 'inventario' | 'logistica' | ...
  owner_role_id      text references hub_roles(id),
  watched_globally   boolean not null default false,
  weight             int not null default 3 check (weight between 1 and 5),
  active             boolean not null default true,
  display_order      int not null default 100,
  created_at         timestamptz not null default now()
);

create index kpis_app_idx on kpis(source_app_id);
create index kpis_parent_idx on kpis(parent_kpi_id);

-- ----------------------------------------------------------------------------
-- KPI targets — optional thresholds per scope
-- ----------------------------------------------------------------------------
create type target_scope as enum ('global', 'city', 'hub');

create table kpi_targets (
  id              uuid primary key default gen_random_uuid(),
  kpi_id          text not null references kpis(id) on delete cascade,
  scope           target_scope not null,
  scope_value     text,                       -- null when scope=global; city or hub_id otherwise
  target          numeric,
  warn_threshold  numeric,
  alert_threshold numeric,
  notes           text,
  updated_at      timestamptz not null default now(),
  unique (kpi_id, scope, scope_value)
);

-- ----------------------------------------------------------------------------
-- Behavior rules — go into the AI's system prompt as standing instructions
-- ----------------------------------------------------------------------------
create table behavior_rules (
  id           uuid primary key default gen_random_uuid(),
  rule_text    text not null,
  rationale    text,
  active       boolean not null default true,
  display_order int not null default 100,
  prompt_version_added int not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Scope rules — what to flag-to-team rather than recommend as Ops action
-- ----------------------------------------------------------------------------
create table scope_rules (
  id              uuid primary key default gen_random_uuid(),
  trigger_text    text not null,              -- "supplier negotiations", "tier change", ...
  target_team_id  text not null references teams(id),
  flag_label_es   text not null,              -- "Flag a Compras"
  example_good    text,                        -- "Flag a Compras: SKU X candidato a..."
  example_bad     text,                        -- "Negociar con SKU X..."
  active          boolean not null default true,
  prompt_version_added int not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Headline examples — few-shot good/bad examples for the AI
-- ----------------------------------------------------------------------------
create type headline_kind as enum ('good', 'bad');

create table headline_examples (
  id          uuid primary key default gen_random_uuid(),
  kind        headline_kind not null,
  text_es     text not null,
  reasoning   text,                            -- why it's good/bad
  active      boolean not null default true,
  prompt_version_added int not null,
  created_at  timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Operating context — the §11 prose, editable in 6 sections
-- ----------------------------------------------------------------------------
create table context_sections (
  id            text primary key,             -- 'overview', 'supply_chain', 'roles', ...
  display_order int not null,
  title_es      text not null,
  body_md       text not null,
  updated_at    timestamptz not null default now(),
  updated_by    text                            -- email
);

-- ----------------------------------------------------------------------------
-- Prompt version registry — each save bumps the version
-- ----------------------------------------------------------------------------
create table prompt_versions (
  id          int primary key,
  notes       text,
  created_at  timestamptz not null default now(),
  created_by  text
);

-- ----------------------------------------------------------------------------
-- Driver exclusion patterns — test/pickup names to filter at ingest
-- ----------------------------------------------------------------------------
create table driver_exclusion_patterns (
  id          uuid primary key default gen_random_uuid(),
  pattern     text not null,                  -- regex or substring (case-insensitive)
  reason      text,
  active      boolean not null default true
);

-- ----------------------------------------------------------------------------
-- Audit log — every change to the registry (who/when/what/before/after)
-- ----------------------------------------------------------------------------
create table audit_log (
  id          uuid primary key default gen_random_uuid(),
  table_name  text not null,
  row_id      text not null,
  action      text not null,                  -- 'insert' | 'update' | 'delete'
  who         text not null,
  before      jsonb,
  after       jsonb,
  occurred_at timestamptz not null default now()
);

create index audit_log_table_row_idx on audit_log(table_name, row_id);
create index audit_log_when_idx on audit_log(occurred_at desc);
