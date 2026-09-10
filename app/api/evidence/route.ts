/**
 * BUILD.md Phase 3 — resolves a persisted claim's evidence.refetch into rows
 * or a chart population. Called by the UI on click, NEVER by the model
 * (ARCHITECTURE.md §4 / ASSISTANT_DESIGN.md §4b property 2 — rows never go
 * to the model). Also accepts a bare claim_id to resolve a persisted claim
 * from the `claims` table, so a resumed thread's evidence still opens.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient, createAdminSupabase } from '@/lib/supabase-server';
import { resolveEvidence } from '@/lib/analysis/evidence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Body = z.union([
  z.object({ claim_id: z.string().uuid() }),
  z.object({
    refetch: z.object({
      tool: z.string(),
      args: z.record(z.string(), z.unknown()),
      predicate: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
]);

export async function POST(req: Request) {
  const userClient = createServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });
  }

  const admin = createAdminSupabase();

  let refetch: { tool: string; args: Record<string, unknown>; predicate?: Record<string, unknown> };
  if ('claim_id' in parsed.data) {
    const { data: claim, error } = await admin.from('claims').select('evidence').eq('id', parsed.data.claim_id).maybeSingle();
    if (error) return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
    if (!claim) return NextResponse.json({ error: 'claim_not_found' }, { status: 404 });
    refetch = (claim.evidence as any).refetch;
  } else {
    refetch = parsed.data.refetch;
  }

  try {
    const result = await resolveEvidence(admin, refetch);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: 'evidence_failed', message: e?.message ?? String(e) }, { status: 500 });
  }
}
