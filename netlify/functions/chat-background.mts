/**
 * Netlify BACKGROUND function — runs one chat turn to completion.
 *
 * The `-background` suffix is load-bearing: it is what gives this a 15-minute
 * budget instead of the 26 s wall clock that kills every synchronous function
 * on this platform (HANDOFF §27). It also means the response is always an
 * immediate 202 with no body — the browser learns what happened by polling
 * `messages` / `tool_calls`, not from this response.
 *
 * AUTH. Netlify functions live outside Next's middleware, so this endpoint is
 * publicly reachable and gets no session check for free. It authenticates with
 * a single-use `run_token`: `/api/chat/start` mints one behind the normal
 * session auth, stores it on the message row, and passes it here. The token is
 * cleared the moment it is accepted, so a replayed request cannot start a
 * second concurrent run over the same turn.
 *
 * Imports must stay Next-free — see the note in lib/chat/run-turn.ts.
 */
import { createClient } from '@supabase/supabase-js';
import { runTurnServer } from '../../lib/chat/run-turn';

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  let body: { assistant_message_id?: string; run_token?: string };
  try {
    body = await req.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }
  const { assistant_message_id: id, run_token: token } = body;
  if (!id || !token) return new Response('bad request', { status: 400 });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('[chat-background] Supabase env vars missing');
    return new Response('misconfigured', { status: 500 });
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  // Claim the run: the token must match AND still be present. Doing it as a
  // conditional update makes this atomic — two racing invocations cannot both
  // come away thinking they own the turn.
  const { data: claimed, error } = await sb.from('messages')
    .update({ run_token: null })
    .eq('id', id).eq('run_token', token)
    .select('id').maybeSingle();

  if (error) {
    console.error('[chat-background] claim failed', error.message);
    return new Response('error', { status: 500 });
  }
  if (!claimed) {
    // Wrong token, or already claimed. Not an error worth retrying.
    return new Response('forbidden', { status: 403 });
  }

  // runTurnServer never throws — it writes a terminal status on every path.
  await runTurnServer(sb as never, id);

  return new Response('ok', { status: 200 });
};
