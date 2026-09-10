// BUILD.md Phase 4 — DB row shapes for the chat tables (migration 20260910000001).

export interface ConversationRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  archived: boolean;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  prompt_version: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  created_at: string;
}

export interface ToolCallRow {
  id: string;
  message_id: string;
  tool_use_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  result: unknown | null;
  provenance: unknown | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}

export interface ClaimRow {
  id: string;
  message_id: string;
  tool_call_id: string;
  claim_ref: string;
  text: string;
  evidence: { kind: 'rows' | 'chart'; refetch: { tool: string; args: Record<string, unknown>; predicate?: Record<string, unknown> }; highlight: string[] };
}

/** A message plus its tool calls / claims, assembled for rendering. */
export interface MessageWithChildren extends MessageRow {
  tool_calls: ToolCallRow[];
  claims: ClaimRow[];
}
