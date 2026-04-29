import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminSupabase, createServerClient } from '@/lib/supabase-server';
import { parseCsv, coerceRows } from '@/lib/parse';
import { validateUpload } from '@/lib/validate';
import { classifyIncidentNotes } from '@/lib/classify-notes';
import { weekStartFriday, type AppColumn } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FormSchema = z.object({
  app_id: z.string().min(1),
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),    // ISO date — must be Friday
  city: z.enum(['Monterrey', 'Saltillo', 'Guadalajara', 'CDMX']).optional(),
  hub_id: z.string().optional(),
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
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });
  }
  const { app_id, week_start, city, hub_id } = parsed.data;

  // Sanity-check that week_start is a Friday
  const weekDate = new Date(week_start + 'T00:00:00Z');
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

  // ----- Persist file in Storage -----
  const filename = `${app_id}/${week_start}/${city ?? hub_id ?? 'total'}-${Date.now()}.csv`;
  const { error: storageErr } = await admin.storage
    .from('uploads')
    .upload(filename, new Blob([text], { type: 'text/csv' }), { upsert: true });

  if (storageErr) {
    return NextResponse.json({ error: 'storage_failed', message: storageErr.message }, { status: 500 });
  }

  // ----- Upsert upload record (one slot per (app, week, city, hub)) -----
  const promptVersionRow = await admin.from('prompt_versions').select('id').order('id', { ascending: false }).limit(1).single();
  const promptVersion = promptVersionRow.data?.id ?? 1;

  const { data: upload, error: upErr } = await admin
    .from('uploads')
    .upsert({
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
    }, { onConflict: 'app_id,week_start,city,hub_id' })
    .select('id')
    .single();

  if (upErr || !upload) {
    return NextResponse.json({ error: 'db_upsert_failed', message: upErr?.message }, { status: 500 });
  }

  // ----- Persist rows -----
  // Wipe prior rows for this upload (re-upload case), then insert in batches.
  await admin.from('upload_rows').delete().eq('upload_id', upload.id);

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

  return NextResponse.json({
    ok: true,
    upload_id: upload.id,
    rows: csv.rows.length,
    status: report.warnings.length > 0 ? 'pending' : 'validated',
    report,
    classification,
  });
}
