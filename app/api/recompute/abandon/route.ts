/**
 * POST /api/recompute/abandon — retire a run that never got off the ground.
 *
 * Session 18. `/api/recompute` creates the run row before anything runs, so a
 * kick that fails (or a background function that dies before its first write)
 * leaves a row on 'running' that blocks the week for the full 16-minute stale
 * window. That window exists to stop two concurrent recomputes, which is worth
 * keeping — but a run we know never started is not one of those, and making
 * José wait 16 minutes to press the button again is not an acceptable way to
 * find that out.
 *
 * So the client calls this when its own kick failed, or when the row is still
 * on phase null well past the point where the function would have claimed it.
 * Only 'running' rows are touched, and only ones that never reached a phase —
 * a live run that is past 'tenure' is never killed from here.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient, createAdminSupabase } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  run_id: z.string().uuid(),
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
    .from('recompute_runs')
    .update({
      status: 'error',
      error_text: parsed.data.reason?.slice(0, 500)
        ?? 'El proceso en segundo plano nunca arrancó.',
      run_token: null,
      finished_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.run_id)
    .eq('status', 'running')
    .is('phase', null)
    .select('id')
    .maybeSingle();

  if (error) return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, abandoned: !!data });
}
