-- The public storefront ("Tienda") shows products from quotes whose customer is
-- the dealer's own house account (Alcover ordering stock for the store). The
-- dealer picks that customer ONCE in Settings; this column holds the choice.
--
-- Additive + idempotent, nullable: until a customer is chosen the public
-- endpoint returns an empty "not configured" catalog, so nothing is exposed by
-- default. On-delete-set-null so removing the house customer just empties the
-- store rather than orphaning a dangling id.
alter table public.settings
  add column if not exists store_customer_id text references public.customers(id) on delete set null;

notify pgrst, 'reload schema';
