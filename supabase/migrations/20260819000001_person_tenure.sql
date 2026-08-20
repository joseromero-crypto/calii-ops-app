-- Modo Entrenamiento — session 14, slice 2.
-- Derived tenure ledger. See PLAN_MODO_ENTRENAMIENTO.md §2.1 for full design.
--
-- No nullable column participates in the primary key, so a plain
-- upsert(onConflict: 'person_key,role') from lib/tenure.ts is safe here —
-- unlike kpi_targets (see HANDOFF §12's NULL-in-UNIQUE footgun).
create table if not exists person_tenure (
  person_key        text not null,          -- operator_id / driver_id — the stable identity
  role              text not null check (role in ('armador','repartidor')),
  first_seen_week   date not null,          -- Friday week_start of first appearance
  last_seen_week    date not null,
  weeks_seen        int  not null default 1,-- distinct weeks they actually appear (diagnostic)
  seen_weeks        date[] not null default '{}',  -- every week they appear — drives re-entry detection
  display_names     text[] not null default '{}',  -- every distinct name seen for this id, most recent first
  hub_id_first      text,
  hub_id_last       text,
  city_last         text,
  confidence        text not null default 'high'
                    check (confidence in ('high','low')),
  confidence_reason text,                   -- 'data_horizon' | 'missing_prior_week' | null
  source            text not null default 'derived'
                    check (source in ('derived','manual')),
  updated_at        timestamptz not null default now(),
  primary key (person_key, role)
);

create index if not exists person_tenure_role_first_seen
  on person_tenure (role, first_seen_week desc);
