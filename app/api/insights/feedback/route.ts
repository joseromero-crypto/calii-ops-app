import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient, createAdminSupabase } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  insight_id: z.string().uuid(),
  action: z.enum(['thumbs_up', 'thumbs_down', 'fuera_de_scope', 'reformular', 'editar', 'ya_resuelto']),
  notes: z.string().optional(),
});

export async function POST(req: Request) {
  const userClient = createServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });

  const admin = createAdminSupabase();
  const { error } = await admin.from('insight_feedback').insert({
    insight_id: parsed.data.insight_id,
    action: parsed.data.action,
    who: user.email ?? 'unknown@calii.com',
    notes: parsed.data.notes ?? null,
  });
  if (error) return NextResponse.json({ error: 'db_failed', message: error.message }, { status: 500 });

  // Mirror thumbs_up/down onto ai_insights.user_feedback for quick filtering
  if (parsed.data.action === 'thumbs_up' || parsed.data.action === 'thumbs_down') {
    await admin.from('ai_insights')
      .update({ user_feedback: parsed.data.action })
      .eq('id', parsed.data.insight_id);
  }

  return NextResponse.json({ ok: true });
}
