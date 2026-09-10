// BUILD.md Phase 4 — read-only loaders using the browser Supabase client
// (RLS-gated, auth_read_* policies from the migration). Writes always go
// through /api/chat, /api/tools/*, /api/evidence — never direct from here.
import { createClient } from '../supabase';
import type { ConversationRow, MessageRow, ToolCallRow, ClaimRow, MessageWithChildren } from './types';

export async function listConversations(limit = 50): Promise<ConversationRow[]> {
  const sb = createClient();
  const { data, error } = await sb.from('conversations').select('*').eq('archived', false).order('updated_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as ConversationRow[];
}

/** Full history for one conversation — messages with their tool_calls/claims attached, resumable with tool results intact (ARCHITECTURE.md §9). */
export async function loadConversation(conversationId: string): Promise<MessageWithChildren[]> {
  const sb = createClient();
  const { data: messages, error } = await sb.from('messages').select('*').eq('conversation_id', conversationId).order('created_at', { ascending: true });
  if (error) throw error;
  const rows = (messages ?? []) as MessageRow[];
  if (!rows.length) return [];

  const ids = rows.map((m) => m.id);
  const [{ data: toolCalls, error: tcErr }, { data: claims, error: clErr }] = await Promise.all([
    sb.from('tool_calls').select('*').in('message_id', ids).order('created_at', { ascending: true }),
    sb.from('claims').select('*').in('message_id', ids),
  ]);
  if (tcErr) throw tcErr;
  if (clErr) throw clErr;

  const tcByMsg = new Map<string, ToolCallRow[]>();
  for (const tc of (toolCalls ?? []) as ToolCallRow[]) {
    if (!tcByMsg.has(tc.message_id)) tcByMsg.set(tc.message_id, []);
    tcByMsg.get(tc.message_id)!.push(tc);
  }
  const clByMsg = new Map<string, ClaimRow[]>();
  for (const cl of (claims ?? []) as ClaimRow[]) {
    if (!clByMsg.has(cl.message_id)) clByMsg.set(cl.message_id, []);
    clByMsg.get(cl.message_id)!.push(cl);
  }

  return rows.map((m) => ({ ...m, tool_calls: tcByMsg.get(m.id) ?? [], claims: clByMsg.get(m.id) ?? [] }));
}
