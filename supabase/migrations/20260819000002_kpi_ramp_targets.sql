-- Modo Entrenamiento — session 14, slice 3.
-- Ramp targets for trainees. See PLAN_MODO_ENTRENAMIENTO.md §2.2/§2.3.
--
-- unique (kpi_id, role, week_number) is safe here — no nullable column
-- participates, so a plain upsert(onConflict: 'kpi_id,role,week_number')
-- from /api/ramp-targets is fine. Do NOT cargo-cult the delete-then-insert
-- pattern from /api/kpi-targets — that one exists because kpi_targets'
-- unique key includes a nullable scope_key (NULL != NULL in Postgres
-- unique indexes, see HANDOFF §12). This table has no such column.
create table if not exists kpi_ramp_targets (
  id            uuid primary key default gen_random_uuid(),
  kpi_id        text not null references kpis(id) on delete cascade,
  role          text not null check (role in ('armador','repartidor')),
  week_number   int  not null check (week_number between 1 and 52),
  target_value  numeric not null,      -- "mínimo" — DISPLAY units. THIS is what flags.
  stretch_value numeric,               -- "esperado" — DISPLAY units. Display only, never flags.
  comparator    text not null check (comparator in ('gte','lte','gt','lt')),
  unit          text not null,          -- snapshot of kpis.unit
  active        boolean not null default true,
  updated_by    text,
  updated_at    timestamptz not null default now(),
  unique (kpi_id, role, week_number)
);

-- Seed — armador / tasa_armado only. No repartidor rows: drivers are
-- label-only in this build (resolvePersonTarget finding no ramp row for a
-- role is a normal, expected path, not an error).
--
-- Week 10's mínimo (100) equals the veteran target, so week 10 is
-- functionally graduation — the row exists so the (S10) badge and the
-- "meta S10: 100" line still render. Esperado for week 10 is displayed as
-- "100+" by the UI, not stored as a value above 100.
insert into kpi_ramp_targets (kpi_id, role, week_number, target_value, stretch_value, comparator, unit)
values
  ('tasa_armado','armador', 1,  50,  55, 'gte', 'rate'),
  ('tasa_armado','armador', 2,  60,  65, 'gte', 'rate'),
  ('tasa_armado','armador', 3,  65,  70, 'gte', 'rate'),
  ('tasa_armado','armador', 4,  70,  75, 'gte', 'rate'),
  ('tasa_armado','armador', 5,  75,  80, 'gte', 'rate'),
  ('tasa_armado','armador', 6,  80,  85, 'gte', 'rate'),
  ('tasa_armado','armador', 7,  85,  90, 'gte', 'rate'),
  ('tasa_armado','armador', 8,  90,  95, 'gte', 'rate'),
  ('tasa_armado','armador', 9,  95, 100, 'gte', 'rate'),
  ('tasa_armado','armador',10, 100, 100, 'gte', 'rate')
on conflict (kpi_id, role, week_number) do nothing;
