import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient } from '@/lib/supabase-server';
import { computeSnapshotsForWeek } from '@/lib/kpi-compute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;          // up to 60s; computation is fast (<5s typically)

const Body = z.object({
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function POST(req: Request) {
  // Auth gate
  const userClient = createServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });
  }

  try {
    const result = await computeSnapshotsForWeek(parsed.data.week_start);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json({ error: 'compute_failed', message: e.message ?? String(e) }, { status: 500 });
  }
}
