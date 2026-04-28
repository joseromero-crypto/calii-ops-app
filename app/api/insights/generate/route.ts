import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient } from '@/lib/supabase-server';
import { generateWeeklyInsights } from '@/lib/generate-insights';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;     // Sonnet can take 30-60s on a rich week

const Body = z.object({
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mode: z.enum(['weekly_priorities', 'focus_plan']).default('weekly_priorities'),
  focus_areas: z.array(z.string()).optional(),
});

export async function POST(req: Request) {
  const userClient = createServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });
  }

  if (parsed.data.mode === 'focus_plan' && (!parsed.data.focus_areas || parsed.data.focus_areas.length === 0)) {
    return NextResponse.json({ error: 'focus_areas_required_for_focus_plan' }, { status: 400 });
  }

  try {
    const result = await generateWeeklyInsights({
      weekStart: parsed.data.week_start,
      mode: parsed.data.mode,
      focusAreas: parsed.data.focus_areas,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json({ error: 'generate_failed', message: e.message ?? String(e) }, { status: 500 });
  }
}
