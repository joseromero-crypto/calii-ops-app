-- ============================================================================
-- Mínimo semanal de armado por puesto de auxiliar — editable from /config.
--
-- Read by components/GenerarReporte.tsx via lib/aux-minimos.ts. Resolution per
-- hub × puesto: hub row → global row → code default (DEFAULT_MINIMO in
-- lib/aux-minimos.ts, kept only as a fallback for an empty/unreachable table).
--
-- Seeded with José's sheet (2026-10-27) so /config shows the real numbers on
-- day one and the code defaults never become a second live source.
-- ============================================================================

create table aux_minimos (
  id           uuid primary key default gen_random_uuid(),
  position     text not null check (position in
                 ('lider_dia', 'lider_tarde', 'calidad', 'recibo', 'inventarios', 'coordinador')),
  scope_level  text not null check (scope_level in ('global', 'hub')),
  scope_key    text,                         -- null when global; hub_id when hub-scoped
  minimo       numeric not null check (minimo >= 0),   -- pedidos armados / semana
  updated_by   text,
  updated_at   timestamptz not null default now(),
  check ((scope_level = 'global') = (scope_key is null))
);

-- NULL != NULL in a plain UNIQUE, so global rows need their own partial index
-- (same NULL-in-UNIQUE class as kpi_targets, HANDOFF §5/§12).
create unique index aux_minimos_global_uniq on aux_minimos (position) where scope_level = 'global';
create unique index aux_minimos_hub_uniq    on aux_minimos (position, scope_key) where scope_level = 'hub';

-- Which hubs staff a separate aux de recibo (5-aux hubs). A hub with no row
-- falls back to the code default (Zapopan, Condesa). Elsewhere a recibo-named
-- account counts toward aux de calidad.
create table aux_hub_settings (
  hub_id        text primary key references hubs(id) on delete cascade,
  tiene_recibo  boolean not null,
  updated_by    text,
  updated_at    timestamptz not null default now()
);

-- RLS — registry-table posture: authenticated read-all, writes via the
-- service-role key in /api/aux-minimos.
alter table aux_minimos      enable row level security;
alter table aux_hub_settings enable row level security;
create policy "auth_read_aux_minimos"      on aux_minimos      for select to authenticated using (true);
create policy "auth_read_aux_hub_settings" on aux_hub_settings for select to authenticated using (true);

-- Explicit grants — required for tables created after 2026-10-30 (HANDOFF §3,
-- "New tables need explicit grants"). No anon: nothing reads these logged-out.
grant select                         on public.aux_minimos      to authenticated;
grant select, insert, update, delete on public.aux_minimos      to service_role;
grant select                         on public.aux_hub_settings to authenticated;
grant select, insert, update, delete on public.aux_hub_settings to service_role;

-- Seed — José's sheet, 2026-10-27.
insert into aux_minimos (position, scope_level, scope_key, minimo, updated_by) values
  ('lider_dia',   'global', null,        5,  'seed'),
  ('lider_tarde', 'global', null,        5,  'seed'),
  ('calidad',     'global', null,        9,  'seed'),
  ('recibo',      'global', null,        9,  'seed'),
  ('inventarios', 'global', null,        9,  'seed'),
  ('coordinador', 'global', null,        5,  'seed'),
  ('inventarios', 'hub',    'mh_contry', 18, 'seed');

insert into aux_hub_settings (hub_id, tiene_recibo, updated_by)
select id, id in ('mh_zapopan', 'mh_condesa'), 'seed'
from hubs where active;
