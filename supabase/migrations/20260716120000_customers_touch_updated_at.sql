-- customers.updated_at becomes SERVER-maintained. The Clientes sheet was
-- stamping updatedAt from the client, which coupled every edit to the
-- 20260715120000 column migration having landed — when it hadn't, every
-- write failed with PGRST204. The client no longer sends the stamp; this
-- trigger owns it (same pattern as profiles_touch_updated_at), so an edit
-- can never again fail over a bookkeeping column.
create or replace function public.customers_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists customers_touch_updated_at on public.customers;
create trigger customers_touch_updated_at
  before update on public.customers
  for each row
  execute function public.customers_touch_updated_at();

notify pgrst, 'reload schema';
