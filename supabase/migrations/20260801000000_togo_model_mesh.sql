-- Real 3D Togo models: an optional mesh file (FBX/GLB/glTF/OBJ/DAE/3DS) per
-- togo_model, uploaded in the Modelos admin and stored in a PUBLIC bucket so the
-- logged-OUT configurator (and the embed on the dealer's site) can fetch it.
-- When `mesh_url` is set the configurator renders the real model instead of the
-- procedural geometry. Optional unit/orientation fixups ride alongside; the
-- renderer auto-fits the model to the piece footprint when `mesh_scale` is null.
alter table togo_models add column if not exists mesh_url text;
alter table togo_models add column if not exists mesh_scale numeric;
alter table togo_models add column if not exists mesh_up_axis text;
alter table togo_models add column if not exists mesh_rotate_y numeric;

-- A public bucket (the configurator is used logged-out, so the bytes must be
-- fetchable unauthenticated). The `images` bucket is image-only + small; 3D
-- meshes are larger and arbitrary types, so they get their own bucket.
insert into storage.buckets (id, name, public, file_size_limit)
values ('togo-models', 'togo-models', true, 78643200) -- 75 MB
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit;

-- Team uploads/replaces/removes; anyone can read (public bucket — the logged-out
-- configurator must fetch the bytes).
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'togo-models read') then
    create policy "togo-models read" on storage.objects for select using (bucket_id = 'togo-models');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'togo-models write') then
    create policy "togo-models write" on storage.objects for insert to authenticated with check (bucket_id = 'togo-models');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'togo-models update') then
    create policy "togo-models update" on storage.objects for update to authenticated using (bucket_id = 'togo-models');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'togo-models delete') then
    create policy "togo-models delete" on storage.objects for delete to authenticated using (bucket_id = 'togo-models');
  end if;
end $$;

notify pgrst, 'reload schema';
