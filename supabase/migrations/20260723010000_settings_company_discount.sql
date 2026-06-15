-- Company-account (house account) cost discount.
--
-- The dealer's own account — `settings.store_customer_id` (the customer whose
-- quotes stock the public storefront; "ALCOVER" / Javier Garcia) — is the
-- COMPANY account: Alcover quoting itself for store stock. Those quotes are
-- internal purchase orders, so the dealer wants to read them at DEALER COST,
-- not list. This percentage is taken OFF every product price on a company-
-- account quote across the dealer's surfaces (the client-preview/PDF order
-- document, the totals dock, the quotes/orders lists, the order detail) so the
-- figures reflect "what this actually costs me to stock". It does NOT touch the
-- public storefront (that re-derives RETAIL prices server-side and ignores it),
-- regular customer quotes, or accounting/commission math.
--
-- Default 60 = the standing dealer discount the team asked to bake in
-- permanently; editable in Configuración. Applies only while a company account
-- is configured (store_customer_id set) — see lib/pricing:companyDiscountPctFor.
alter table settings
  add column if not exists company_discount_pct numeric not null default 60;

-- Same legal range the app clamps to (0–100%).
alter table settings drop constraint if exists settings_company_discount_pct_range;
alter table settings
  add constraint settings_company_discount_pct_range
  check (company_discount_pct >= 0 and company_discount_pct <= 100);

notify pgrst, 'reload schema';
