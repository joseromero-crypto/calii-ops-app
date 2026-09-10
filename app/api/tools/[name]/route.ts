/**
 * BUILD.md Phase 3 — thin auth + zod-validated dispatch into lib/analysis/.
 * Called by the CLIENT loop (ARCHITECTURE.md §2), never internally by
 * /api/chat — the server never loops.
 */
import { NextResponse } from 'next/server';
import { createServerClient, createAdminSupabase } from '@/lib/supabase-server';
import { TOOL_REGISTRY } from '@/lib/analysis/tool-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: { name: string } }) {
  const userClient = createServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const tool = TOOL_REGISTRY[params.name];
  if (!tool) {
    return NextResponse.json({ error: 'unknown_tool', name: params.name, available: Object.keys(TOOL_REGISTRY) }, { status: 404 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }

  const parsed = tool.schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });
  }

  const admin = createAdminSupabase();
  const start = Date.now();
  try {
    const result = await tool.handler(admin, parsed.data);
    return NextResponse.json({ ok: true, result, duration_ms: Date.now() - start });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: 'tool_failed', message: e?.message ?? String(e), duration_ms: Date.now() - start }, { status: 500 });
  }
}
