-- ============================================================================
-- Migration 004: Storage bucket for raw CSV uploads
-- Files are stored as: <app_id>/<week_start>/<city|hub|'total'>-<timestamp>.csv
-- Private bucket — only the service role key can read; UI never reads files
-- directly, only the parsed rows from upload_rows.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'uploads',
  'uploads',
  false,
  20 * 1024 * 1024,                            -- 20 MB cap matches Next bodySizeLimit
  array['text/csv', 'text/plain', 'application/vnd.ms-excel']
)
on conflict (id) do nothing;

-- RLS: only authenticated users can upload (auth = single user for now).
-- Reading raw files goes through the service role; UI never needs direct access.
-- Note: Postgres does NOT support `CREATE POLICY IF NOT EXISTS`, so we drop-then-create
-- to keep the migration idempotent.
drop policy if exists "Authenticated upload" on storage.objects;
create policy "Authenticated upload"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'uploads');

drop policy if exists "Owner reads own files" on storage.objects;
create policy "Owner reads own files"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'uploads' and owner = auth.uid());
