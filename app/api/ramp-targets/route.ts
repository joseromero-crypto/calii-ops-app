import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminSupabase, createServerClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// ----------------------------------------------------------------------------
// GET /api/ramp-targets — all active ramp rows. Read-only; already behind
// the middleware auth gate like every other route in the app.
// ----------------------------------------------------------------------------
export async function GET() {
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from('kpi_ramp_targets')
    .select('kpi_id, role, week_number, target_value, stretch_value, comparator, unit, active, updated_by, updated_at')
    .eq('active', true)
    .order('role')
    .order('week_number');

  if (error) {
    return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
  }
  return NextResponse.json({ ramps: data ?? [] });
}

const WriteSchema = z.object({
  kpi_id: z.string().min(1),
  role: z.enum(['armador', 'repartidor']),
  week_number: z.number().int().min(1).max(52),
  target_value: z.number(),
  stretch_value: z.number().nullable().optional(),
  comparator: z.enum(['gte', 'lte', 'gt', 'lt']),
});

// ----------------------------------------------------------------------------
// PUT /api/ramp-targets — upsert one (kpi_id, role, week_number) row.
//
// A plain upsert(onConflict) IS safe here, unlike /api/kpi-targets — see the
// comment in the migration (20260819000002_kpi_ramp_targets.sql). No
// nullable column participates in the unique key.
//
// No DELETE endpoint: every (armador, tasa_armado) week is meant to always
// have a row (seeded by the migration) — there's no "row absence = inherit
// something" concept for this table the way there is for kpi_targets.
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
  const { kpi_id, role, week_number, target_value, comparator } = parsed.data;
  const stretch_value = parsed.data.stretch_value ?? null;

  const admin = createAdminSupabase();

  const { data: kpi } = await admin.from('kpis').select('id, unit').eq('id', kpi_id).maybeSingle();
  if (!kpi) {
    return NextResponse.json({ error: 'unknown_kpi', kpi_id }, { status: 400 });
  }

  const { data: upserted, error } = await admin
    .from('kpi_ramp_targets')
    .upsert(
      {
        kpi_id,
        role,
        week_number,
        target_value,
        stretch_value,
        comparator,
        unit: kpi.unit, // snapshot server-side — never trust a client-supplied unit
        updated_by: user.email ?? process.env.APP_OWNER_EMAIL ?? 'jose.romero@calii.com',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'kpi_id,role,week_number' }
    )
    .select('kpi_id, role, week_number, target_value, stretch_value, comparator, unit, active, updated_by, updated_at')
    .single();

  if (error || !upserted) {
    return NextResponse.json({ error: 'db_error', message: error?.message }, { status: 500 });
  }
  return NextResponse.json({ ramp: upserted });
}
