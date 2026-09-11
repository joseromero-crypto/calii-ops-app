/**
 * DELETE /api/conversations/<id>  — archive a conversation (soft).
 * PATCH  /api/conversations/<id>  — { archived: false } to restore it.
 *
 * Deliberately NOT a hard delete. `conversations.archived` already exists in
 * the schema (20260910000001) and `listConversations()` already filters on it,
 * so archiving is what the data model was built for — and every message,
 * tool_call and claim of that conversation stays queryable, which matters here
 * because `claims.tool_call_id` is what makes an old citation resolvable. A row
 * deleted to "clean up the sidebar" would silently break evidence links.
 *
 * Writes go through a route rather than the browser client, per lib/chat/load.ts:
 * "Writes always go through /api/chat, /api/tools/*, /api/evidence — never
 * direct from here."
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient, createAdminSupabase } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchBody = z.object({ archived: z.boolean() });

async function requireUser() {
  const userClient = createServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  return user;
}

async function setArchived(id: string, archived: boolean) {
  const admin = createAdminSupabase();
  const { error } = await admin.from('conversations').update({ archived }).eq('id', id);
  if (error) return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id, archived });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  if (!(await requireUser())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return setArchived(params.id, true);
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  if (!(await requireUser())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });
  return setArchived(params.id, parsed.data.archived);
}
