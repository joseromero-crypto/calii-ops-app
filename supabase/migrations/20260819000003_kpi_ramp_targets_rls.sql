-- Modo Entrenamiento — session 14, slice 3 fix.
--
-- 20260819000002_kpi_ramp_targets.sql forgot RLS — same pattern as every
-- other registry table (20260427000005_rls.sql, and kpi_targets' own
-- auth_read_kpi_targets policy in 20260717000001_kpi_targets.sql):
-- authenticated read-all, writes go through the service-role key
-- server-side. Without this, the browser's session-authenticated client
-- (createServerClient(), subject to RLS) silently gets zero rows back from
-- kpi_ramp_targets even though a service-role script sees all of them —
-- every /config ramp input falls back to its placeholder.
alter table kpi_ramp_targets enable row level security;

create policy "auth_read_kpi_ramp_targets"
  on kpi_ramp_targets for select
  to authenticated
  using (true);
