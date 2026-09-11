-- Session 17 (2026-09-11) — snapshot recomputes move to a Netlify background
-- function, for the same reason chat did one session earlier (HANDOFF §27).
--
-- Why: POST /api/recompute ran computeSnapshotsForWeek() inside a synchronous
-- function. Netlify kills those at a hard 26 s wall clock — `maxDuration = 60`
-- in the route is a Vercel convention and does nothing. computeSnapshotsForWeek
-- writes nothing until its two closing upserts, so a kill discarded the whole
-- run. Worse, the browser could not tell: the 200 header goes out before the
-- work starts, so RecomputeButton's "stream closed early, trust res.ok"
-- fallback reported a dead run as "OK · 0 snapshots". Week 2026-09-04 silently
-- produced no snapshots at all and nobody found out until /historicos was empty.
--
-- The run now lives in a *-background function (15 min) and the browser polls
-- this table. It exists so that "still working", "finished with N snapshots"
-- and "died with this error" are three distinguishable states instead of one
-- ambiguous zero.

create table recompute_runs (
  id                uuid primary key default gen_random_uuid(),
  week_start        date not null,

  -- 'running' | 'done' | 'error'
  status            text not null default 'running',
  error_text        text,

  -- Single-use bearer for the background invocation. /api/recompute mints it
  -- behind the normal session auth and hands it to the function; the function
  -- claims it with a conditional update and clears it in the same statement,
  -- so a replayed request cannot start a second run over the same row.
  -- Netlify functions sit outside Next middleware and get no auth for free.
  run_token         text,

  -- Coarse progress, so a 90-second run isn't an unlabelled spinner.
  -- 'tenure' | 'compute' | 'done'
  phase             text,

  -- Results, written on the 'done' transition.
  snapshots_written integer,
  peers_written     integer,
  kpis_processed    integer,
  warnings          jsonb,

  started_at        timestamptz not null default now(),
  finished_at       timestamptz
);

alter table recompute_runs
  add constraint recompute_runs_status_check check (status in ('running', 'done', 'error'));

-- The UI asks two questions: "how did the last run for this week go?" (newest
-- first for one week) and, on mount, "is anything in flight right now?".
create index recompute_runs_week_idx on recompute_runs(week_start, started_at desc);
create index recompute_runs_running_idx on recompute_runs(started_at desc) where status = 'running';

-- Same posture as the chat tables (20260910000001): any signed-in user of this
-- app may read. Writes are service-role only — the API route and the background
-- function both use the admin client, and run_token is never exposed to the
-- browser because the poll selects an explicit column list.
alter table recompute_runs enable row level security;
create policy "auth_read_recompute_runs" on recompute_runs for select to authenticated using (true);
