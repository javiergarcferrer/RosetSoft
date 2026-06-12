-- customers.updated_at — the Clientes inline sheet stamps every edit with
-- updatedAt (parity with professionals, which has had the column since
-- 20260517140000), but customers was created with created_at only and the
-- old modal never wrote updated_at, so the column was never missed. Every
-- sheet edit therefore failed with PGRST204 ("Could not find the
-- 'updated_at' column of 'customers'"). Backfill from created_at so
-- existing rows don't all claim "updated now".
alter table public.customers
  add column if not exists updated_at timestamptz;

update public.customers set updated_at = created_at where updated_at is null;

alter table public.customers
  alter column updated_at set default now(),
  alter column updated_at set not null;

notify pgrst, 'reload schema';
