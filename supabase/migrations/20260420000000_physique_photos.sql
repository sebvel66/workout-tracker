-- Physique photo tracking — goal + progress photos feed the v2 AI planner
-- as multimodal input alongside the training data.
--
-- Files live in a PRIVATE storage bucket (no public URL); the
-- physique_photos table stores the metadata and a storage_path key.
-- The client generates short-lived signed URLs on render via
-- sb.storage.from('physique-photos').createSignedUrl(path, ttl).
--
-- Path convention: '{user_id}/{uuid}.{ext}'. The leading user_id folder
-- is what the storage RLS policies key on, so a user can only touch
-- objects under their own prefix.

-- 1. Metadata table. One row per uploaded photo.
create table physique_photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null,
  photo_type text not null check (photo_type in ('goal', 'progress')),
  taken_at timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now()
);

-- Supports "latest goal" and "latest N progress photos" queries in one
-- index scan. Descending on taken_at puts the newest first.
create index physique_photos_latest
  on physique_photos (user_id, photo_type, taken_at desc);

alter table physique_photos enable row level security;

create policy "own_physique_photos"
  on physique_photos for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 2. Private storage bucket for the image files themselves. `public=false`
-- means the bucket can't be read via a plain URL; every render requires
-- a signed URL issued by an authenticated session. Idempotent so this
-- migration is safe to re-run against a project that already has the
-- bucket from the dashboard.
insert into storage.buckets (id, name, public)
  values ('physique-photos', 'physique-photos', false)
  on conflict (id) do nothing;

-- 3. Storage RLS policies. Gate every action on the bucket by path
-- prefix: the first path segment must equal the caller's auth.uid().
-- storage.foldername(name) parses the object key into its path segments;
-- [1] is the first segment (postgres arrays are 1-indexed).
create policy "physique_photos_select_own"
  on storage.objects for select
  using (
    bucket_id = 'physique-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "physique_photos_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'physique-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "physique_photos_delete_own"
  on storage.objects for delete
  using (
    bucket_id = 'physique-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
