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

  // `URL` is set by Netlify to the site's own address; the request origin is
  // the fallback for `netlify dev`. Awaited only until Netlify accepts the
  // invocation (background functions answer 202 straight away) — not until the
  // turn finishes, which is the whole point.
  const origin = process.env.URL ?? new URL(req.url).origin;
  try {
    const kick = await fetch(`${origin}/.netlify/functions/chat-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistant_message_id: assistantMessageId, run_token: runToken }),
    });
    if (!kick.ok && kick.status !== 202) {
      const detail = await kick.text().catch(() => '');
      await admin.from('messages').update({
        status: 'error',
        error_text: `No se pudo iniciar el proceso en segundo plano (${kick.status}). ${detail.slice(0, 200)}`,
        run_token: null,
      }).eq('id', assistantMessageId);
      return NextResponse.json({ error: 'background_start_failed', status: kick.status }, { status: 502 });
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    await admin.from('messages').update({
      status: 'error', error_text: `No se pudo iniciar el proceso en segundo plano: ${message}`, run_token: null,
    }).eq('id', assistantMessageId);
    return NextResponse.json({ error: 'background_start_failed', message }, { status: 502 });
  }

  return NextResponse.json({ ok: true, conversation_id: conversationId, assistant_message_id: assistantMessageId });
}
