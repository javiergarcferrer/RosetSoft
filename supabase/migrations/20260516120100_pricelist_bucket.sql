-- Storage bucket for the team's current Ligne Roset price-list PDF.
-- One file per team (path: `current.pdf`); writes are authenticated-only.
-- Public-read is fine because the file is the open USA tariff PDF.

insert into storage.buckets (id, name, public)
values ('pricelist', 'pricelist', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "pricelist public read"          on storage.objects;
drop policy if exists "pricelist authenticated write"  on storage.objects;
drop policy if exists "pricelist authenticated update" on storage.objects;
drop policy if exists "pricelist authenticated delete" on storage.objects;

create policy "pricelist public read"
  on storage.objects for select
  to public
  using (bucket_id = 'pricelist');

create policy "pricelist authenticated write"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'pricelist');

create policy "pricelist authenticated update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'pricelist')
  with check (bucket_id = 'pricelist');

create policy "pricelist authenticated delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'pricelist');
