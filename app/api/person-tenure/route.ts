/**
 * PUT/DELETE /api/person-tenure — manual tenure overrides.
 *
 * The escape hatch for a wrong derivation or a rehire under a new id
 * (PLAN_MODO_ENTRENAMIENTO.md §8). refreshTenureLedger() never overwrites a
 * row with source='manual' (see lib/tenure.ts), so an override survives
 * every future recompute/upload-triggered refresh until explicitly reverted.
 *
 * PUT supports two actions:
 *   - set_first_seen: hand-set first_seen_week (confidence forced 'high' —
 *     a human-supplied date is trusted, unlike a derived one that might sit
 *     on the data horizon).
 *   - graduate: force veteran status by setting confidence='low'. This is
 *     the same "safe direction" the derivation itself uses (§4) — reusing
 *     it here means tenureStatus() needs no special-casing for manual
 *     graduation, it just sees a low-confidence row and treats it as a
 *     veteran, exactly as it would for any data-horizon row.
 *
 * Both actions require the row to already exist (derived by a prior
 * refreshTenureLedger run) — this is an override of a real ledger entry,
 * not a way to fabricate a person from nothing.
 *
 * DELETE reverts to derived: flips source back to 'derived' so the row is
 * no longer protected from the next refresh. It does NOT delete the row or
 * immediately recompute it — the row keeps its current values until the
 * next refreshTenureLedger() run overwrites them with freshly derived data.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminSupabase, createServerClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

const PutSchema = z.discriminatedUnion('action', [
  z.object({
    person_key: z.string().min(1),
    role: z.enum(['armador', 'repartidor']),
    action: z.literal('set_first_seen'),
    first_seen_week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.object({
    person_key: z.string().min(1),
    role: z.enum(['armador', 'repartidor']),
    action: z.literal('graduate'),
  }),
]);

export async function PUT(req: Request) {
  const userClient = createServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });
  }
  const { person_key, role } = parsed.data;

  const admin = createAdminSupabase();

  const patch =
    parsed.data.action === 'set_first_seen'
      ? {
          first_seen_week: parsed.data.first_seen_week,
          confidence: 'high' as const,
          confidence_reason: null,
          source: 'manual' as const,
          updated_at: new Date().toISOString(),
        }
      : {
          // "Graduar" reuses the derivation's own safe-direction rule (§4):
          // confidence='low' always resolves to veteran in tenureStatus().
          confidence: 'low' as const,
          confidence_reason: 'manual_override',
          source: 'manual' as const,
          updated_at: new Date().toISOString(),
        };

  const { data: updated, error } = await admin
    .from('person_tenure')
    .update(patch)
    .eq('person_key', person_key)
    .eq('role', role)
    .select('person_key, role')
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: 'unknown_person', person_key, role }, { status: 404 });
  }

  await admin.from('audit_log').insert({
    table_name: 'person_tenure',
    row_id: `${person_key}|${role}`,
    action: 'update',
    who: user.email ?? 'unknown@calii.com',
    after: { person_key, role, ...patch },
  });

  return NextResponse.json({ ok: true });
}

const DeleteSchema = z.object({
  person_key: z.string().min(1),
  role: z.enum(['armador', 'repartidor']),
});

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
  const { person_key, role } = parsed.data;

  const admin = createAdminSupabase();
  const { data: updated, error } = await admin
    .from('person_tenure')
    .update({ source: 'derived', updated_at: new Date().toISOString() })
    .eq('person_key', person_key)
    .eq('role', role)
    .select('person_key, role')
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: 'unknown_person', person_key, role }, { status: 404 });
  }

  await admin.from('audit_log').insert({
    table_name: 'person_tenure',
    row_id: `${person_key}|${role}`,
    action: 'update',
    who: user.email ?? 'unknown@calii.com',
    after: { person_key, role, source: 'derived', reverted: true },
  });

  return NextResponse.json({ ok: true });
}
