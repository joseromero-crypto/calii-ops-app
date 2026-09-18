/**
 * POST /api/chat/abandon — retire a turn whose background function never
 * started. Session 18, sibling of /api/recompute/abandon.
 *
 * /api/chat/start writes the assistant row as 'running' before anything runs,
 * and /api/chat/start refuses to resume a row that is still 'running' (409).
 * So a failed kick would wedge that conversation until someone edited the row
 * by hand. The client calls this when its own kick throws.
 *
 * The `run_token is not null` condition is the safety rail: the background
 * function clears the token the moment it claims the turn, so this can only
 * ever retire a turn that nothing is working on.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient, createAdminSupabase } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  assistant_message_id: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

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
  const { data, error } = await admin
    .from('messages')
    .update({
      status: 'error',
      error_text: parsed.data.reason?.slice(0, 500)
        ?? 'El proceso en segundo plano nunca arrancó.',
      run_token: null,
    })
    .eq('id', parsed.data.assistant_message_id)
    .eq('status', 'running')
    .not('run_token', 'is', null)
    .select('id')
    .maybeSingle();

  if (error) return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, abandoned: !!data });
}
