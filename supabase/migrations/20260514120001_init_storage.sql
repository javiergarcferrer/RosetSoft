-- Roset Soft image storage bucket + access policies.
--
-- Run this AFTER schema.sql in the Supabase SQL Editor.
--
-- The `images` bucket holds product hero photos, variant drawings, fabric
-- swatches, and team logos. We make it public-read so <img src> works
-- without signed URLs (the content is not sensitive). Writes are restricted
-- to authenticated team members.

insert into storage.buckets (id, name, public)
values ('images', 'images', true)
on conflict (id) do update set public = excluded.public;

-- Storage policies live on storage.objects, scoped by bucket_id.
drop policy if exists "images public read"          on storage.objects;
drop policy if exists "images authenticated write"  on storage.objects;
drop policy if exists "images authenticated update" on storage.objects;
drop policy if exists "images authenticated delete" on storage.objects;

create policy "images public read"
  on storage.objects for select
  to public
  using (bucket_id = 'images');

create policy "images authenticated write"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'images');

create policy "images authenticated update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'images')
  with check (bucket_id = 'images');

create policy "images authenticated delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'images');
