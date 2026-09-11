/**
 * Netlify BACKGROUND function — recomputes one week's snapshots to completion.
 *
 * The `-background` suffix is load-bearing: it is what gives this a 15-minute
 * budget instead of the 26 s wall clock that kills every synchronous function
 * on this platform (HANDOFF §27, §28). It also means the response is always an
 * immediate 202 with no body — the browser learns what happened by polling
 * `recompute_runs`, not from this response.
 *
 * Why this had to move. `computeSnapshotsForWeek()` accumulates every snapshot
 * in memory and writes them in two upserts at the very end, so a kill at 26 s
 * discards the entire run rather than leaving partial data. Two costs had been
 * growing underneath it: `refreshTenureLedger()` re-derives the ledger from
 * every validated upload ever recorded (one query per upload, both roles —
 * this grows every week forever), and the MNA pagination fix of 2026-09-09
 * turned ~7 truncated reads into ~42 full ones. Week 2026-09-04 was the first
 * to cross the line, and produced no snapshots at all.
 *
 * AUTH. Netlify functions live outside Next's middleware, so this endpoint is
 * publicly reachable and gets no session check for free. It authenticates with
 * a single-use `run_token`: `/api/recompute` mints one behind the normal
 * session auth, stores it on the run row, and passes it here. The token is
 * cleared the moment it is accepted, so a replayed request cannot start a
 * second concurrent run over the same row.
 *
 * Imports must stay Next-free — `lib/supabase-admin.ts` exists for exactly
 * this reason (see its header note and the one in lib/tenure.ts).
 */
import { createClient } from '@supabase/supabase-js';
import { computeSnapshotsForWeek } from '../../lib/kpi-compute';
import { refreshTenureLedger } from '../../lib/tenure';

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  let body: { run_id?: string; run_token?: string };
  try {
    body = await req.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }
  const { run_id: id, run_token: token } = body;
  if (!id || !token) return new Response('bad request', { status: 400 });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('[recompute-background] Supabase env vars missing');
    return new Response('misconfigured', { status: 500 });
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  // Claim the run: the token must match AND still be present. Doing it as a
  // conditional update makes this atomic — two racing invocations cannot both
  // come away thinking they own the run.
  const { data: claimed, error } = await sb.from('recompute_runs')
    .update({ run_token: null, phase: 'tenure' })
    .eq('id', id).eq('run_token', token)
    .select('id, week_start').maybeSingle();

  if (error) {
    console.error('[recompute-background] claim failed', error.message);
    return new Response('error', { status: 500 });
  }
  if (!claimed) {
    // Wrong token, or already claimed. Not an error worth retrying.
    return new Response('forbidden', { status: 403 });
  }

  const weekStart = claimed.week_start as string;
  const t0 = Date.now();

  try {
    // Tenure first — a recompute always refreshes it so badges and ramp
    // targets stay in sync with the latest upload history (PLAN_MODO_
    // ENTRENAMIENTO.md §4). This is the expensive half on a long history.
    await refreshTenureLedger(sb as never);

    await sb.from('recompute_runs').update({ phase: 'compute' }).eq('id', id);

    // Pass our own client: this process has no Next runtime, so the module's
    // default createAdminSupabase() path is not the one we want here.
    const result = await computeSnapshotsForWeek(weekStart, sb as never);

    await sb.from('recompute_runs').update({
      status: 'done',
      phase: 'done',
      snapshots_written: result.snapshots_written,
      peers_written: result.peers_written,
      kpis_processed: result.kpis_processed,
      warnings: result.warnings,
      finished_at: new Date().toISOString(),
    }).eq('id', id);

    console.log(`[recompute-background] ${weekStart} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
      `${result.snapshots_written} snapshots, ${result.peers_written} peers, ${result.warnings.length} warnings`);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[recompute-background] ${weekStart} failed after ${((Date.now() - t0) / 1000).toFixed(1)}s`, message);
    // Always write a terminal status — a run row stuck on 'running' is exactly
    // the ambiguity this table was added to remove.
    await sb.from('recompute_runs').update({
      status: 'error',
      error_text: message.slice(0, 1000),
      finished_at: new Date().toISOString(),
    }).eq('id', id);
  }

  return new Response('ok', { status: 200 });
};
