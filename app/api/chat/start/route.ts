/**
 * POST /api/chat/start — begin a chat turn.
 *
 * Session 16 (HANDOFF §27): the agent loop no longer runs inside a request.
 * This route does only the fast, synchronous part — auth, create/locate the
 * conversation, insert the user message and the assistant row the turn will
 * write into, mint a single-use run token — then hands the actual work to
 * `netlify/functions/chat-background.mts`, which has 15 minutes instead of the
 * 26 s that killed the old design.
 *
 * Returns the ids immediately. The browser polls `messages`/`tool_calls`
 * (already readable under RLS via lib/chat/load.ts) until `status` leaves
 * 'running'.
 *
 * Two shapes, mirroring the old route:
 *   { user_message, conversation_id? }  — new turn
 *   { assistant_message_id }            — resume a turn that died partway;
 *                                         its executed tool calls are replayed
 *                                         from the DB, none are re-run.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createServerClient, createAdminSupabase } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  conversation_id: z.string().uuid().optional(),
  user_message: z.string().min(1).optional(),
  assistant_message_id: z.string().uuid().optional(),
}).refine(
  (b) => (!!b.user_message) !== (!!b.assistant_message_id),
  { message: 'Provide exactly one of user_message (new turn) or assistant_message_id (resume)' }
);

export async function POST(req: Request) {
  const userClient = createServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let raw: unknown;
  try { raw = await req.json(); } catch { raw = {}; }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });
  }

  const admin = createAdminSupabase();
  const runToken = randomUUID();
  let conversationId: string;
  let assistantMessageId: string;

  if (parsed.data.user_message) {
    const userMessage = parsed.data.user_message;

    if (parsed.data.conversation_id) {
      conversationId = parsed.data.conversation_id;
      await admin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
    } else {
      const { data, error } = await admin.from('conversations')
        .insert({ title: userMessage.slice(0, 80) }).select('id').single();
      if (error) return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
      conversationId = data.id;
    }

    await admin.from('messages').insert({ conversation_id: conversationId, role: 'user', content: userMessage });

    const { data: newMsg, error } = await admin.from('messages')
      .insert({ conversation_id: conversationId, role: 'assistant', content: '', status: 'running', run_token: runToken })
      .select('id').single();
    if (error) return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
    assistantMessageId = newMsg.id;
  } else {
    assistantMessageId = parsed.data.assistant_message_id!;
    const { data: row, error } = await admin.from('messages')
      .select('conversation_id, status').eq('id', assistantMessageId).maybeSingle();
    if (error) return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
    if (!row) return NextResponse.json({ error: 'assistant_message_not_found' }, { status: 404 });
    if (row.status === 'running') {
      return NextResponse.json({ error: 'already_running', assistant_message_id: assistantMessageId }, { status: 409 });
    }
    conversationId = row.conversation_id;
    await admin.from('messages')
      .update({ status: 'running', error_text: null, run_token: runToken })
      .eq('id', assistantMessageId);
    await admin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
  }

  // Session 18 (2026-09-18): this route no longer invokes the background
  // function itself. Function-to-function HTTP silently does nothing on this
  // site — the kick came back 2xx and `chat-background` was not invoked once
  // in the 7 days after it shipped, so every turn started here would have sat
  // on 'running' forever. The browser invokes it with the token below, which
  // is the path that was measured working; see lib/kick-background.ts.
  return NextResponse.json({
    ok: true,
    conversation_id: conversationId,
    assistant_message_id: assistantMessageId,
    run_token: runToken,
  });
}
