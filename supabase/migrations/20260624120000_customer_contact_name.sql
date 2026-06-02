-- Customer contact name — the person you deal with at a company (the customer
-- record itself holds the razón social / nombre comercial). Additive.

alter table public.customers
  add column if not exists contact_name text default '';

notify pgrst, 'reload schema';
