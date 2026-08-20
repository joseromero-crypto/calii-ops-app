import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminSupabase, createServerClient } from '@/lib/supabase-server';
import { parseCsv, coerceRows } from '@/lib/parse';
import { validateUpload } from '@/lib/validate';
import { computeIdentityChecks } from '@/lib/validate-identity';
import { classifyIncidentNotes } from '@/lib/classify-notes';
import { refreshTenureLedger, type Role as TenureRole } from '@/lib/tenure';
import { weekStartFriday, type AppColumn } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FormSchema = z.object({
  app_id: z.string().min(1),
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),    // ISO date — must be Friday
  city: z.enum(['Monterrey', 'Saltillo', 'Guadalajara', 'CDMX']).optional(),
  hub_id: z.string().optional(),
  // Set only on a resubmit after the user has seen an identity_* error and
  // explicitly chose to proceed anyway. Never bypasses header/type errors —
  // see the split below.
  force_identity: z.coerce.boolean().optional(),
});

export async function POST(req: Request) {
  // ----- Auth -----
  const userClient = createServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // ----- Parse multipart -----
  const formData = await req.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }

  const parsed = FormSchema.safeParse({
    app_id: formData.get('app_id'),
    week_start: formData.get('week_start'),
    city: formData.get('city') || undefined,
    hub_id: formData.get('hub_id') || undefined,
    force_identity: formData.get('force_identity') || undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });
  }
  const { app_id, week_start, city, hub_id, force_identity } = parsed.data;

  // Sanity-check that week_start is a Friday.
  // Use local-time noon (T12:00:00) — NOT UTC midnight (T00:00:00Z) — so that
  // weekStartFriday's local-time methods (getDay, setDate, setHours) see the
  // correct calendar day regardless of the server's timezone offset.
  const weekDate = new Date(week_start + 'T12:00:00');
  const fri = weekStartFriday(weekDate);
  if (fri.toISOString().slice(0, 10) !== week_start) {
    return NextResponse.json({
      error: 'invalid_week_start',
      message: `week_start debe ser viernes. ${week_start} es ${weekDate.toUTCString()}`
    }, { status: 400 });
  }

  // ----- Look up app + columns -----
  const admin = createAdminSupabase();
  const [{ data: app }, { data: columns }] = await Promise.all([
    admin.from('apps').select('*').eq('id', app_id).maybeSingle(),
    admin.from('app_columns').select('*').eq('app_id', app_id).order('position'),
  ]);

  if (!app) {
    return NextResponse.json({ error: 'unknown_app', app_id }, { status: 400 });
  }

  // Scope sanity
  if (app.scope === 'per_city' && !city) {
    return NextResponse.json({ error: 'city_required_for_per_city_app' }, { status: 400 });
  }
  if (app.scope === 'per_hub' && !hub_id) {
    return NextResponse.json({ error: 'hub_id_required_for_per_hub_app' }, { status: 400 });
  }

  // ----- Parse CSV -----
  const text = await file.text();
  const csv = parseCsv(text);
  if (csv.errors.length > 0) {
    return NextResponse.json({
      error: 'csv_parse_error',
      details: csv.errors.slice(0, 10),
    }, { status: 400 });
  }

  // ----- Validate -----
  // (Skipping the rolling distribution check on first pass — needs prior uploads
  //  to compute rolling means. Will hook up once we have history.)
  const report = validateUpload({
    appId: app_id,
    expectedColumns: columns as AppColumn[],
    csvHeaders: csv.headers,
    rows: csv.rows,
  });

  if (report.errors.length > 0 || report.schema_match === 'mismatch') {
    return NextResponse.json({ error: 'validation_failed', report }, { status: 422 });
  }

  // ----- Identity safety net (session 13) -----
  //
  // validateUpload() only looks at the CSV in isolation (schema, types).
  // computeIdentityChecks() looks at content vs. what we already know: does
  // this file's hub column resolve to the declared city, and does its
  // roster look like this slot's history or a different city's? See
  // lib/validate-identity.ts for the full design.
  //
  // Every identity_* error is override-able via force_identity=true — the
  // client resubmits the same file after the user explicitly confirms.
  // Header/type errors above are NEVER override-able; only identity checks
  // are, because they're heuristics about content, not facts about whether
  // the CSV parses.
  const identity = await computeIdentityChecks({
    sb: admin,
    appId: app_id,
    weekStart: week_start,
    city: city ?? null,
    hubId: hub_id ?? null,
    rows: csv.rows,
  });
  report.warnings.push(...identity.warnings);

  if (identity.errors.length > 0 && !force_identity) {
    report.errors.push(...identity.errors);
    return NextResponse.json({ error: 'validation_failed', report, overridable: true }, { status: 422 });
  }
  if (identity.errors.length > 0 && force_identity) {
    // Downgrade to warnings so they're still visible in the stored report,
    // but don't block. The override itself is logged to audit_log below.
    report.warnings.push(...identity.errors.map((e) => ({ ...e, code: `${e.code}_overridden` })));
  }

  // ----- Persist file in Storage -----
  const filename = `${app_id}/${week_start}/${city ?? hub_id ?? 'total'}-${Date.now()}.csv`;
  const { error: storageErr } = await admin.storage
    .from('uploads')
    .upload(filename, new Blob([text], { type: 'text/csv' }), { upsert: true });

  if (storageErr) {
    return NextResponse.json({ error: 'storage_failed', message: storageErr.message }, { status: 500 });
  }

  // ----- Replace upload record (one slot per (app, week, city, hub)) -----
  //
  // We use delete-then-insert rather than upsert because PostgreSQL unique
  // constraints treat NULL != NULL — two rows with (app_id, week_start,
  // city=NULL, hub_id=NULL) do NOT conflict, so upsert silently inserts a
  // duplicate for total-scope apps. Explicit lookup + delete guarantees
  // exactly one record per slot regardless of scope.
  const promptVersionRow = await admin.from('prompt_versions').select('id').order('id', { ascending: false }).limit(1).single();
  const promptVersion = promptVersionRow.data?.id ?? 1;

  // Look up ALL existing uploads for this slot, handling NULLs explicitly.
  // We use select() not maybeSingle() because prior bugs may have left duplicate
  // records; maybeSingle() would silently error on >1 row and return null,
  // causing yet another INSERT to be added on top of the duplicates.
  let existingIds: string[] = [];
  {
    let q = admin.from('uploads').select('id')
      .eq('app_id', app_id)
      .eq('week_start', week_start);
    q = city   ? q.eq('city',   city)   : q.is('city',   null);
    q = hub_id ? q.eq('hub_id', hub_id) : q.is('hub_id', null);
    const { data: existing } = await q;
    existingIds = (existing ?? []).map((r: { id: string }) => r.id);
  }

  // Delete all duplicate records: rows first (FK constraint), then the uploads.
  if (existingIds.length > 0) {
    await Promise.all(
      existingIds.map((id) => admin.from('upload_rows').delete().eq('upload_id', id))
    );
    await admin.from('uploads').delete().in('id', existingIds);
  }

  const { data: upload, error: upErr } = await admin
    .from('uploads')
    .insert({
      app_id,
      week_start,
      city: city ?? null,
      hub_id: hub_id ?? null,
      uploaded_by: user.email ?? 'unknown@calii.com',
      file_storage_path: filename,
      file_size_bytes: file.size,
      row_count: csv.rows.length,
      status: 'validated',
      validation_report: report,
      prompt_version: promptVersion,
    })
    .select('id')
    .single();

  if (upErr || !upload) {
    return NextResponse.json({ error: 'db_upsert_failed', message: upErr?.message }, { status: 500 });
  }

  // ----- Persist rows -----

  const coerced = coerceRows(csv.rows as Record<string, string>[], columns as AppColumn[]);
  const BATCH = 500;
  for (let i = 0; i < coerced.length; i += BATCH) {
    const slice = coerced.slice(i, i + BATCH).map((data, j) => ({
      upload_id: upload.id,
      row_index: i + j,
      data,
    }));
    const { error: rowsErr } = await admin.from('upload_rows').insert(slice);
    if (rowsErr) {
      return NextResponse.json({ error: 'rows_insert_failed', message: rowsErr.message }, { status: 500 });
    }
  }

  // ----- Audit log -----
  await admin.from('audit_log').insert({
    table_name: 'uploads',
    row_id: upload.id,
    action: 'insert',
    who: user.email ?? 'unknown@calii.com',
    after: {
      app_id, week_start, city, hub_id,
      row_count: csv.rows.length,
      status: report.warnings.length > 0 ? 'pending' : 'validated',
      // Traceability for the identity safety net (session 13) — every
      // force-through is logged with exactly what was overridden, per Jose:
      // "override available ... in case its on purpose or the site is glitching."
      ...(force_identity && identity.errors.length > 0
        ? { override_identity: true, overridden_checks: identity.errors.map((e) => e.code) }
        : {}),
    },
  });

  // ----- Side effects per app -----
  // For incidentes uploads, run Haiku classification on Notas in the background.
  // We don't await — let the response return fast; a follow-up "Recomputar" or
  // "Generar insights" call will pick up the labels once they're written.
  let classification: { rows_classified: number; cost_usd: number } | null = null;
  if (app_id === 'incidentes') {
    try {
      classification = await classifyIncidentNotes(upload.id);
    } catch (e: any) {
      // Don't fail the upload on classifier errors — log and move on.
      console.error('classify_incidents failed', e?.message);
    }
  }

  // A roster upload changes tenure — refresh the ledger for that role.
  // Fire-and-forget: a failure here must never fail the upload itself
  // (PLAN_MODO_ENTRENAMIENTO.md §4).
  const TENURE_ROLE_BY_APP: Record<string, TenureRole> = {
    desempeno_operadores: 'armador',
    desempeno_repartidores: 'repartidor',
  };
  const tenureRole = TENURE_ROLE_BY_APP[app_id];
  if (tenureRole) {
    refreshTenureLedger(admin, { role: tenureRole }).catch((e: any) => {
      console.error('refreshTenureLedger failed', tenureRole, e?.message);
    });
  }

  return NextResponse.json({
    ok: true,
    upload_id: upload.id,
    rows: csv.rows.length,
    status: report.warnings.length > 0 ? 'pending' : 'validated',
    report,
    classification,
  });
}
