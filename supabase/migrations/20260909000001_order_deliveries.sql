-- BUILD.md Phase 1 — order_deliveries.
--
-- desempeno_repartidores.orders_data is a JSON array (~57 entries per
-- driver-week, ~100k records across the history) marked role='ignored' in
-- app_columns and read by nothing. This table is the flattened, queryable
-- form: one row per delivered order, per DATA_DICTIONARY.md's field spec.
--
-- RLS goes in this migration, not a follow-up — HANDOFF §12 already hit this
-- twice (person_tenure, kpi_ramp_targets): forgetting it makes /historicos's
-- browser-session client silently see zero rows with no error.
create table order_deliveries (
  id            bigserial primary key,
  upload_id     uuid not null references uploads(id) on delete cascade,
  week_start    date not null,                 -- Friday, from the parent upload
  hub_id        text not null references hubs(id),  -- from the parent row's `hub` via resolveHubId, never the blob
  driver_name   text not null,                 -- from the parent row, not the blob (which only has `user_name`)
  user_name     text,                          -- orders_data[].user_name — 100% filled per audit, nullable defensively
  delivered_at  timestamptz,                   -- orders_data[].delivered_at — 98% filled, 2% null; never assume presence
  window_start  timestamptz not null,          -- orders_data[].delivery_window_start_date_time
  window_label  text not null,                 -- orders_data[].delivery_window_time, e.g. "4pm - 6pm"
  minutes_late  int,                           -- orders_data[].minutes_delivered_late_or_early — signed, negative = early
  created_at    timestamptz not null default now()
);

-- (hub_id, week_start) and (week_start) per BUILD.md's spec — the two
-- filters every Phase 2 analysis function will query on.
create index order_deliveries_hub_week_idx on order_deliveries(hub_id, week_start);
create index order_deliveries_week_idx on order_deliveries(week_start);
-- Not requested by BUILD.md's spec table, but required for the ETL's own
-- delete-then-insert-per-upload step (see lib/etl/order-deliveries.ts) to
-- stay a fast indexed scan rather than a sequential scan of a 100k-row table.
create index order_deliveries_upload_idx on order_deliveries(upload_id);

alter table order_deliveries enable row level security;

create policy "auth_read_order_deliveries"
  on order_deliveries for select
  to authenticated
  using (true);
