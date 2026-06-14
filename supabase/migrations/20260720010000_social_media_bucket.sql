-- A public Storage bucket for Instagram publishing media (photos + Reels).
-- IG Content Publishing fetches a PUBLIC URL we host, so the dealer can upload
-- from their device → we stage it here → pass the public URL to /media. The
-- `images` bucket is image-only + small; Reels need video + up to 300 MB, so
-- this gets its own bucket rather than loosening the app-wide image caps.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'social', 'social', true,
  314572800, -- 300 MB, the current IG Reels cap
  array['image/jpeg', 'video/mp4', 'video/quicktime']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Team can upload/replace/remove; anyone can read (public bucket — Meta must
-- fetch the bytes unauthenticated).
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'social read') then
    create policy "social read" on storage.objects for select using (bucket_id = 'social');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'social write') then
    create policy "social write" on storage.objects for insert to authenticated with check (bucket_id = 'social');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'social update') then
    create policy "social update" on storage.objects for update to authenticated using (bucket_id = 'social');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'social delete') then
    create policy "social delete" on storage.objects for delete to authenticated using (bucket_id = 'social');
  end if;
end $$;

notify pgrst, 'reload schema';
