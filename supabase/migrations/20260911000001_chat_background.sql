-- Session 16 (2026-09-11) — chat turns move to a Netlify background function.
--
-- Why: Netlify kills a synchronous function at a hard 26 s wall clock
-- (`maxDuration` is a Vercel convention and does nothing here). A deep
-- investigation's model call blew past that and the turn died mid-stream —
-- HANDOFF §27. The agent loop now runs in a background function (15 min) and
-- the browser polls these rows instead of holding an SSE connection open, so
-- the client needs to be able to tell "still working" from "finished" from
-- "died", which the schema previously had no way to express: an assistant row
-- mid-loop and an assistant row that crashed both look like content = ''.

alter table messages
  -- 'running' | 'done' | 'error'. Default 'done' so every pre-existing row
  -- (all of which are finished, one way or another) keeps rendering as before.
  add column status text not null default 'done',
  add column error_text text,
  -- Single-use bearer for the background invocation. /api/chat/start mints it
  -- behind the normal session auth and hands it to the function; the function
  -- verifies and clears it. Netlify functions sit outside Next middleware, so
  -- they get no auth for free and must not be openly invocable.
  add column run_token text;

alter table messages
  add constraint messages_status_check check (status in ('running', 'done', 'error'));

-- Partial index: the only status ever queried for is the rare in-flight one.
create index messages_running_idx on messages(conversation_id) where status = 'running';
