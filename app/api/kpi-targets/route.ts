import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminSupabase, createServerClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// ----------------------------------------------------------------------------
// GET /api/kpi-targets — all active targets. Read-only; already behind the
// middleware auth gate like every other route in the app.
// ----------------------------------------------------------------------------
export async function GET() {
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from('kpi_targets')
    .select('kpi_id, scope_level, scope_key, target_value, comparator, unit, active, updated_by, updated_at')
    .eq('active', true)
    .order('kpi_id');

  if (error) {
    return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
  }
  return NextResponse.json({ targets: data ?? [] });
}

const WriteSchema = z.object({
  kpi_id: z.string().min(1),
  scope_level: z.enum(['global', 'hub']),
  scope_key: z.string().nullable().optional(),   // required when scope_level='hub'
  target_value: z.number(),
  comparator: z.enum(['gte', 'lte', 'gt', 'lt']),
});

// ----------------------------------------------------------------------------
// PUT /api/kpi-targets — upsert one target row.
//
// Explicit delete-then-insert matching the exact partial unique index,
// NOT a plain upsert(onConflict: 'kpi_id,scope_level,scope_key'). Postgres
// treats NULL != NULL, so a plain onConflict tuple would silently insert a
// duplicate global row every time (scope_key is NULL for all of them) —
// same NULL-in-UNIQUE bug class as the upload dedup fix (HANDOFF §5/§12).
// ----------------------------------------------------------------------------
export async function PUT(req: Request) {
  const userClient = createServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = WriteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });
  }
  const { kpi_id, scope_level, target_value, comparator } = parsed.data;
  const scope_key = scope_level === 'hub' ? (parsed.data.scope_key ?? null) : null;
  if (scope_level === 'hub' && !scope_key) {
    return NextResponse.json({ error: 'scope_key_required_for_hub_target' }, { status: 400 });
  }

  const admin = createAdminSupabase();

  const { data: kpi } = await admin.from('kpis').select('id, unit').eq('id', kpi_id).maybeSingle();
  if (!kpi) {
    return NextResponse.json({ error: 'unknown_kpi', kpi_id }, { status: 400 });
  }

  let del = admin.from('kpi_targets').delete().eq('kpi_id', kpi_id).eq('scope_level', scope_level);
  del = scope_level === 'global' ? del.is('scope_key', null) : del.eq('scope_key', scope_key!);
  const { error: delErr } = await del;
  if (delErr) {
    return NextResponse.json({ error: 'db_error', message: delErr.message }, { status: 500 });
  }

  const { data: inserted, error: insErr } = await admin
    .from('kpi_targets')
    .insert({
      kpi_id,
      scope_level,
      scope_key,
      target_value,
      comparator,
      unit: kpi.unit,           // snapshot server-side — never trust a client-supplied unit
      updated_by: user.email ?? process.env.APP_OWNER_EMAIL ?? 'jose.romero@calii.com',
    })
    .select('kpi_id, scope_level, scope_key, target_value, comparator, unit, active, updated_by, updated_at')
    .single();

  if (insErr || !inserted) {
    return NextResponse.json({ error: 'db_error', message: insErr?.message }, { status: 500 });
  }
  return NextResponse.json({ target: inserted });
}

const DeleteSchema = z.object({
  kpi_id: z.string().min(1),
  scope_level: z.enum(['global', 'hub']),
  scope_key: z.string().nullable().optional(),
});

// ----------------------------------------------------------------------------
// DELETE /api/kpi-targets — clears a target row (global or hub override).
// A blank /config input calls this rather than writing target_value=null:
// row absence, not a null value, is what "no target" means throughout this
// feature (see resolveTarget in historicos/_shared.ts).
// ----------------------------------------------------------------------------
export async function DELETE(req: Request) {
  const userClient = createServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });
  }
  const { kpi_id, scope_level } = parsed.data;
  const scope_key = scope_level === 'hub' ? (parsed.data.scope_key ?? null) : null;
  if (scope_level === 'hub' && !scope_key) {
    return NextResponse.json({ error: 'scope_key_required_for_hub_target' }, { status: 400 });
  }

  const admin = createAdminSupabase();
  let del = admin.from('kpi_targets').delete().eq('kpi_id', kpi_id).eq('scope_level', scope_level);
  del = scope_level === 'global' ? del.is('scope_key', null) : del.eq('scope_key', scope_key!);
  const { error } = await del;
  if (error) {
    return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
