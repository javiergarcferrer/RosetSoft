-- professionals.address — give the address a real home.
--
-- The seed migration (20260706120000_seed_professionals.sql) landed the
-- spreadsheet's DIRECCIÓN column in `notes` because professionals had no
-- address column. That conflated two different things: where the client
-- receives deliveries vs. freeform remarks. Add the column and move the
-- seeded values over. Seeded rows are identifiable by their deterministic
-- id ('pro_' || md5('seed-professional:' || name)), so rows created by hand
-- in the UI (random ids) are never touched, and a row whose notes were
-- edited after seeding still moves only if its address is empty.
alter table public.professionals add column if not exists address text not null default '';

update public.professionals
   set address = notes,
       notes = ''
 where id = 'pro_' || md5('seed-professional:' || name)
   and coalesce(address, '') = ''
   and coalesce(notes, '') <> '';

notify pgrst, 'reload schema';
