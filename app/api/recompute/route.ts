import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient, createAdminSupabase } from '@/lib/supabase-server';
import { computeSnapshotsForWeek } from '@/lib/kpi-compute';
import { refreshTenureLedger } from '@/lib/tenure';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Body = z.object({
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function POST(req: Request) {
  // Auth gate — runs before the stream opens so we can still return proper status codes.
  const userClient = createServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });
  }

  const weekStart = parsed.data.week_start;

  // Netlify closes connections that send no bytes for ~26 s (inactivity timeout),
  // even when maxDuration is longer. Fix: stream the response and emit a keepalive
  // newline every 10 s while the computation runs. The final payload is a single
  // JSON object — leading whitespace is valid JSON so response.json() on the
  // client side parses it transparently.
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode('\n')); } catch { /* stream already closed */ }
      }, 10_000);

      try {
        // Refresh the tenure ledger before computing snapshots — a recompute
        // always refreshes tenure, so badges/ramp targets stay in sync with
        // the latest upload history. See PLAN_MODO_ENTRENAMIENTO.md §4.
        await refreshTenureLedger(createAdminSupabase());
        const result = await computeSnapshotsForWeek(weekStart);
        clearInterval(keepalive);
        controller.enqueue(encoder.encode(JSON.stringify({ ok: true, ...result })));
      } catch (e: any) {
        clearInterval(keepalive);
        controller.enqueue(
          encoder.encode(JSON.stringify({ ok: false, error: 'compute_failed', message: e.message ?? String(e) }))
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
