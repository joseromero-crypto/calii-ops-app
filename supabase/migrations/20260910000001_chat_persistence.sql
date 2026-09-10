-- BUILD.md Phase 3 — chat persistence. ARCHITECTURE.md §6.
--
-- The Messages API only has 'user'/'assistant' roles — a tool_result is sent
-- back to Claude as a 'user'-role message containing a tool_result block,
-- not a separate role. We don't persist that hand-back as its own message
-- row (it would just duplicate tool_calls.result); `messages` holds only
-- what José typed (role='user') and the assistant's final synthesised prose
-- per turn (role='assistant') — everything that happened in between a turn's
-- tool_use/tool_result hops lives in `tool_calls`, keyed to that one
-- assistant message so "show me the query behind that number" is answerable
-- by looking at one row's children.
--
-- RLS in this migration, not a follow-up — HANDOFF §12 already hit the
-- forgot-RLS footgun twice. Read-only for authenticated (browser session);
-- all writes go through the service-role client in the API routes, same
-- pattern as every other table here.

create table conversations (
  id          uuid primary key default gen_random_uuid(),
  title       text,                          -- ARCHITECTURE.md §9: model-generated or first message, open question — nullable until set
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived    boolean not null default false
);

create index conversations_updated_idx on conversations(updated_at desc);

create type message_role as enum ('user', 'assistant');

create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role            message_role not null,
  content         text not null default '',   -- prose; '' while an assistant turn is still mid tool-loop
  prompt_version  int,                          -- ASSISTANT_DESIGN.md §8: which knowledge produced this
  input_tokens    int,
  output_tokens   int,
  cost_usd        numeric,
  created_at      timestamptz not null default now()
);

create index messages_conversation_idx on messages(conversation_id, created_at);

-- One row per tool_use block Claude emits. Created (result=null) the moment
-- Claude asks for a tool call; updated with result/duration_ms once the
-- client has executed it and reports back on the next /api/chat hop.
-- tool_use_id is Claude's own id for the block — required to build the
-- tool_result reply when continuing the turn.
create table tool_calls (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references messages(id) on delete cascade,
  tool_use_id  text not null,
  tool_name    text not null,
  args         jsonb not null,
  result       jsonb,           -- the full {data, confidence, caveats, provenance, claims} envelope, or {error}
  provenance   jsonb,           -- duplicated from result.provenance for quick access without unpacking result
  duration_ms  int,
  error        text,
  created_at   timestamptz not null default now(),

  unique (message_id, tool_use_id)
);

create index tool_calls_message_idx on tool_calls(message_id);

-- One row per claim a tool result carried, scoped under the tool_call that
-- produced it. claim_ref is the short id the model cites inline in its
-- prose (e.g. 'c1') — the UI resolves a citation to this row via
-- (tool_call_id, claim_ref), then to evidence via resolveEvidence(evidence.refetch).
create table claims (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references messages(id) on delete cascade,
  tool_call_id uuid not null references tool_calls(id) on delete cascade,
  claim_ref    text not null,
  text         text not null,
  evidence     jsonb not null,   -- { kind, refetch: {tool, args, predicate}, highlight }

  unique (tool_call_id, claim_ref)
);

create index claims_message_idx on claims(message_id);

create table artifacts (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null references messages(id) on delete cascade,
  kind        text not null check (kind in ('chart', 'table', 'document')),
  spec        jsonb not null,
  created_at  timestamptz not null default now()
);

create index artifacts_message_idx on artifacts(message_id);

alter table conversations enable row level security;
create policy "auth_read_conversations" on conversations for select to authenticated using (true);

alter table messages enable row level security;
create policy "auth_read_messages" on messages for select to authenticated using (true);

alter table tool_calls enable row level security;
create policy "auth_read_tool_calls" on tool_calls for select to authenticated using (true);

alter table claims enable row level security;
create policy "auth_read_claims" on claims for select to authenticated using (true);

alter table artifacts enable row level security;
create policy "auth_read_artifacts" on artifacts for select to authenticated using (true);
