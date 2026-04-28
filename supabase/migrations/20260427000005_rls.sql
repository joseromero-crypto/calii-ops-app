-- ============================================================================
-- Migration 005: Row Level Security
-- Single-user app: all authenticated users can read everything; writes
-- happen via service role (which bypasses RLS) from server-side route handlers.
-- ============================================================================

-- Enable RLS on every table
alter table subdivisions             enable row level security;
alter table hubs                     enable row level security;
alter table hub_roles                enable row level security;
alter table teams                    enable row level security;
alter table apps                     enable row level security;
alter table app_columns              enable row level security;
alter table kpis                     enable row level security;
alter table kpi_targets              enable row level security;
alter table behavior_rules           enable row level security;
alter table scope_rules              enable row level security;
alter table headline_examples        enable row level security;
alter table context_sections         enable row level security;
alter table prompt_versions          enable row level security;
alter table driver_exclusion_patterns enable row level security;
alter table audit_log                enable row level security;
alter table uploads                  enable row level security;
alter table upload_rows              enable row level security;
alter table kpi_snapshots            enable row level security;
alter table peer_comparisons         enable row level security;
alter table ai_insights              enable row level security;
alter table insight_feedback         enable row level security;
alter table annotations              enable row level security;
alter table saved_views              enable row level security;

-- Authenticated read policies on every table
do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'subdivisions','hubs','hub_roles','teams','apps','app_columns',
      'kpis','kpi_targets','behavior_rules','scope_rules','headline_examples',
      'context_sections','prompt_versions','driver_exclusion_patterns','audit_log',
      'uploads','upload_rows','kpi_snapshots','peer_comparisons',
      'ai_insights','insight_feedback','annotations','saved_views'
    ])
  loop
    execute format(
      'create policy "auth_read_%s" on %I for select to authenticated using (true)',
      t, t
    );
  end loop;
end $$;

-- Authenticated users can insert insight feedback (the only client-side write path)
create policy "auth_insert_insight_feedback"
  on insight_feedback for insert
  to authenticated
  with check (true);

-- Note: All other writes (uploads, snapshots, ai_insights, audit_log, registry edits)
-- go through createAdminSupabase() which uses the service-role key and bypasses RLS.
-- This is intentional: server-side validation gates every mutation.
