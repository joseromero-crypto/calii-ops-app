/**
 * POST /api/recompute — start a snapshot recompute for one week.
 *
 * Session 17 (HANDOFF §28): the computation no longer runs inside this request.
 * It used to, behind a streamed response with a 10 s keepalive, on the theory
 * that the keepalive was what stood between it and Netlify's timeout. It was
 * not. Netlify's 26 s limit is a wall clock on the whole invocation, not an
 * inactivity timer, and `export const maxDuration = 60` is a Vercel convention
 * this platform ignores. Since `computeSnapshotsForWeek()` writes nothing until
 * its two closing upserts, every run that crossed 26 s was discarded whole —
 * and because the 200 header had already gone out, the browser read the
 * truncated stream as success and reported "OK · 0 snapshots". Week 2026-09-04
 * failed that way with no visible error at all.
 *
 * So this route does only the fast part — auth, create the run row, mint a
 * single-use token — and the work happens in
 * `netlify/functions/recompute-background.mts`, which has 15 minutes. The
 * browser polls `recompute_runs` (readable under RLS by any authenticated
 * user) until `status` leaves 'running'.
 *
 * Session 18 (2026-09-18): this route no longer invokes that function itself.
 * Function-to-function HTTP does not work on this site — the kick came back
 * 2xx and the function was never invoked, so the run row sat on 'running' /
 * phase null and the button span for 16 minutes. Evidence and measurements are
 * in `lib/kick-background.ts`. The browser now does the invoking with the
 * `run_token` returned below; the function still claims that token with a
 * conditional update, so a replay cannot start a second run over the same row.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createServerClient, createAdminSupabase } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** A run older than this with status still 'running' is assumed dead — the
 *  background function's own ceiling is 15 minutes, so nothing legitimate
 *  outlives it. Without this, one crashed invocation would block the week
 *  forever. A run that never started is retired sooner than this, by
 *  /api/recompute/abandon, so a failed kick does not cost a 16-minute wait. */
const STALE_RUN_MS = 16 * 60 * 1000;

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

  const weekStart = parsed.data.week_start;
  const admin = createAdminSupabase();

  // Don't start a second run over a week that is already being recomputed —
  // two concurrent runs would upsert the same conflict keys against each other.
  const { data: inFlight } = await admin
    .from('recompute_runs')
    .select('id, started_at')
    .eq('week_start', weekStart)
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (inFlight && Date.now() - new Date(inFlight.started_at).getTime() < STALE_RUN_MS) {
    // Hand back the existing run rather than erroring: the client attaches its
    // poller to it, which is what the user wants anyway. No token — that run
    // was already claimed by whoever started it, and re-kicking it would only
    // earn a 403 from the function.
    return NextResponse.json({ ok: true, run_id: inFlight.id, already_running: true });
  }
  if (inFlight) {
    await admin.from('recompute_runs').update({
      status: 'error',
      error_text: 'Run abandoned — no result after 16 minutes.',
      run_token: null,
      finished_at: new Date().toISOString(),
    }).eq('id', inFlight.id);
  }

  const runToken = randomUUID();
  const { data: run, error: insErr } = await admin
    .from('recompute_runs')
    .insert({ week_start: weekStart, status: 'running', run_token: runToken })
    .select('id')
    .single();
  if (insErr || !run) {
    return NextResponse.json({ error: 'db_error', message: insErr?.message }, { status: 500 });
  }

  // The caller invokes the background function with these two values and then
  // polls the row. Nothing has started yet at this point.
  return NextResponse.json({ ok: true, run_id: run.id, run_token: runToken });
}
