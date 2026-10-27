import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminSupabase, createServerClient } from '@/lib/supabase-server';
import { AUX_POSITION_ORDER } from '@/lib/aux-minimos';

export const dynamic = 'force-dynamic';

/**
 * /api/aux-minimos — writes for the "Mínimo de armado por auxiliar" /config
 * section (lib/aux-minimos.ts, migration 20261027000001).
 *
 *   PUT    { position, scope_level, scope_key?, minimo }   set a minimum
 *   DELETE { position, scope_level, scope_key? }           clear it (blank input)
 *   PATCH  { hub_id, tiene_recibo }                        5-aux hub toggle
 *
 * Same conventions as /api/kpi-targets: row absence = "use the fallback",
 * and minimum writes are delete-then-insert against the partial unique
 * indexes (a plain onConflict would duplicate global rows — NULL != NULL).
 */

const Position = z.enum(AUX_POSITION_ORDER as [string, ...string[]]);
const Scope = z.object({
  position: Position,
  scope_level: z.enum(['global', 'hub']),
  scope_key: z.string().nullable().optional(),
});
const PutSchema = Scope.extend({ minimo: z.number().min(0) });
const PatchSchema = z.object({ hub_id: z.string().min(1), tiene_recibo: z.boolean() });

const ROW = 'position, scope_level, scope_key, minimo';

async function requireUser() {
  const { data: { user } } = await createServerClient().auth.getUser();
  return user;
}

function scopeKeyOf(p: z.infer<typeof Scope>) {
  return p.scope_level === 'hub' ? (p.scope_key ?? null) : null;
}

function deleteScope(admin: ReturnType<typeof createAdminSupabase>, position: string, scopeLevel: string, scopeKey: string | null) {
  const del = admin.from('aux_minimos').delete().eq('position', position).eq('scope_level', scopeLevel);
  return scopeLevel === 'global' ? del.is('scope_key', null) : del.eq('scope_key', scopeKey!);
}

export async function PUT(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const parsed = PutSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });
  const { position, scope_level, minimo } = parsed.data;
  const scope_key = scopeKeyOf(parsed.data);
  if (scope_level === 'hub' && !scope_key) return NextResponse.json({ error: 'scope_key_required_for_hub' }, { status: 400 });

  const admin = createAdminSupabase();
  const { error: delErr } = await deleteScope(admin, position, scope_level, scope_key);
  if (delErr) return NextResponse.json({ error: 'db_error', message: delErr.message }, { status: 500 });

  const { data, error } = await admin
    .from('aux_minimos')
    .insert({ position, scope_level, scope_key, minimo, updated_by: user.email ?? null })
    .select(ROW)
    .single();
  if (error || !data) return NextResponse.json({ error: 'db_error', message: error?.message }, { status: 500 });
  return NextResponse.json({ minimo: data });
}

export async function DELETE(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const parsed = Scope.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });
  const scope_key = scopeKeyOf(parsed.data);
  if (parsed.data.scope_level === 'hub' && !scope_key) return NextResponse.json({ error: 'scope_key_required_for_hub' }, { status: 400 });

  const { error } = await deleteScope(createAdminSupabase(), parsed.data.position, parsed.data.scope_level, scope_key);
  if (error) return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });

  const { data, error } = await createAdminSupabase()
    .from('aux_hub_settings')
    .upsert(
      { ...parsed.data, updated_by: user.email ?? null, updated_at: new Date().toISOString() },
      { onConflict: 'hub_id' },
    )
    .select('hub_id, tiene_recibo')
    .single();
  if (error || !data) return NextResponse.json({ error: 'db_error', message: error?.message }, { status: 500 });
  return NextResponse.json({ setting: data });
}
