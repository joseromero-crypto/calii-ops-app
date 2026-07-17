-- ============================================================================
-- Migration: Configurable KPI targets (global + per-hub)
--
-- Adds the real kpi_targets table so umbrales (report flagging + dashboard
-- reference lines) become editable from /config instead of hardcoded in
-- components/GenerarReporte.tsx (ASSEMBLER_KPI_DEFS / DRIVER_KPI_DEFS).
--
-- Precedence when resolving a target for (kpi_id, hub_id):
--   hub-specific row  >  global row  >  code default (row absent entirely)
--
-- Values are stored in DISPLAY units (e.g. 90 for tasa_armado, 6 for a 6%
-- threshold) — NOT the 0-1 fraction used in kpi_snapshots/peer_comparisons.
-- Conversion happens in exactly one place (resolveTarget / isBelowTarget /
-- meetsTarget helpers, added to app/(app)/historicos/_shared.ts in a
-- follow-up step) — do not store fractions here.
--
-- Optional targets: KPIs that today flag on "outlier > 2x hub mean"
-- (faltantes_armador_pct, pct_tardias_reparto, pct_undelivered) are NOT
-- seeded below. Absence of a row means "keep the existing outlier
-- behavior" — this is also why a cleared /config input DELETEs the row
-- rather than writing a null value into it.
--
-- See CONFIGURABLE_KPI_TARGETS.md §2-3 for the full design rationale.
--
-- ----------------------------------------------------------------------------
-- Replaces the original kpi_targets table (registry_schema migration,
-- 20260427000001). That table was created speculatively and never wired up
-- anywhere — grepped the whole app, zero references outside migrations, no
-- seeded rows. Its shape doesn't match this design (no `comparator`, no
-- `unit` snapshot, no `active`/`updated_by`, and its plain
-- `unique(kpi_id, scope, scope_value)` has the exact NULL-in-UNIQUE footgun
-- (HANDOFF §5/§12) this migration's partial indexes fix). Safe to drop and
-- recreate since it holds no data.
-- ----------------------------------------------------------------------------
drop table if exists kpi_targets;
drop type if exists target_scope;

create table kpi_targets (
  id           uuid primary key default gen_random_uuid(),
  kpi_id       text not null references kpis(id) on delete cascade,
  scope_level  text not null check (scope_level in ('global', 'hub')),
  scope_key    text,                       -- null when global; hub_id when hub-scoped
  target_value numeric not null,           -- DISPLAY units (see header note)
  comparator   text not null check (comparator in ('gte', 'lte', 'gt', 'lt')),
  unit         text not null,              -- snapshot of kpis.unit at write time
  active       boolean not null default true,
  updated_by   text,                       -- email
  updated_at   timestamptz not null default now(),
  unique (kpi_id, scope_level, scope_key)
);

-- The unique() above does NOT stop duplicate global rows — Postgres treats
-- NULL as distinct from NULL in a UNIQUE constraint, and scope_key is NULL
-- for every global row (same NULL-in-UNIQUE class as the upload dedup bug,
-- HANDOFF §5/§12). Partial unique indexes close the gap; the write API
-- (Step 4) must upsert against these, not a plain onConflict tuple.
create unique index kpi_targets_global_uniq
  on kpi_targets (kpi_id) where scope_level = 'global';

create unique index kpi_targets_hub_uniq
  on kpi_targets (kpi_id, scope_key) where scope_level = 'hub';

create index kpi_targets_kpi_id_idx on kpi_targets (kpi_id);

-- ----------------------------------------------------------------------------
-- RLS — same pattern as every other registry table (20260427000005_rls.sql):
-- authenticated read-all, writes go through the service-role key server-side.
-- ----------------------------------------------------------------------------
alter table kpi_targets enable row level security;

create policy "auth_read_kpi_targets"
  on kpi_targets for select
  to authenticated
  using (true);

-- ----------------------------------------------------------------------------
-- Seed: one global row per KPI that currently has a hardcoded numeric
-- threshold in components/GenerarReporte.tsx (ASSEMBLER_KPI_DEFS). Values
-- and comparator direction match existing behavior exactly so nothing
-- changes on day one — this is what makes Step 1 a no-op until the resolver
-- (Step 2) and its call sites (Steps 5-6) are wired in.
--
-- KPIs that flag on "outlier > 2x hub mean" today (faltantes_armador_pct,
-- pct_tardias_reparto, pct_undelivered) are intentionally left unseeded —
-- see header note.
--
-- comparator = the "meets target" (good) condition, defaulted from each
-- KPI's *effective* direction (the code override for tasa_armado, per
-- HANDOFF §12 — not raw kpis.direction, which may say lower_is_better).
--   higher_is_better -> gte   (meets target when value >= target_value)
--   lower_is_better  -> lte   (meets target when value <= target_value)
--
-- tasa_armado: effectiveHigherIsBetter override (GenerarReporte.tsx) — NOT
-- raw kpis.direction, which may still say lower_is_better (HANDOFF §12).
-- Current hardcoded threshold: 90, flagged when value <= 90.
--
-- incidentes_manuales_pct + 4 sub-metrics: lower_is_better. Current
-- hardcoded thresholds: 0.06 / 0.04 stored as 0-1 fractions in
-- ASSEMBLER_KPI_DEFS — here expressed as display-unit percentages (6 / 4).
-- ----------------------------------------------------------------------------
insert into kpi_targets (kpi_id, scope_level, scope_key, target_value, comparator, unit, updated_by)
values
  ('tasa_armado',                        'global', null, 90, 'gte', 'rate', 'jose.romero@calii.com'),
  ('incidentes_manuales_pct',            'global', null, 6,  'lte', 'pct',  'jose.romero@calii.com'),
  ('incidentes_calidad_pct',             'global', null, 4,  'lte', 'pct',  'jose.romero@calii.com'),
  ('incidentes_faltantes_pct',           'global', null, 4,  'lte', 'pct',  'jose.romero@calii.com'),
  ('incidentes_faltantes_parciales_pct', 'global', null, 4,  'lte', 'pct',  'jose.romero@calii.com'),
  ('incidentes_faltantes_completos_pct', 'global', null, 4,  'lte', 'pct',  'jose.romero@calii.com')
on conflict (kpi_id) where (scope_level = 'global') do nothing;
