-- Modo Entrenamiento — session 14, slice 5 fix.
--
-- 20260819000001_person_tenure.sql forgot RLS too — same class of bug as
-- 20260819000003_kpi_ramp_targets_rls.sql. Every other registry table gets
-- this (20260427000005_rls.sql, kpi_targets' auth_read_kpi_targets policy):
-- authenticated read-all, writes go through the service-role key
-- server-side. Without it, /historicos's browser-session-authenticated
-- client silently gets zero person_tenure rows back — every badge in
-- PorHubTab renders empty even though the ledger is fully populated.
alter table person_tenure enable row level security;

create policy "auth_read_person_tenure"
  on person_tenure for select
  to authenticated
  using (true);
