-- Shareable customer statement (estado de cuenta) link. `statement_token` is a
-- random secret embedded in the public URL; null until the dealer shares.
-- Served logged-out by the `account-share` Edge Function. Additive.

alter table customers add column if not exists statement_token text;

create unique index if not exists customers_statement_token_idx
  on public.customers(statement_token)
  where statement_token is not null;

notify pgrst, 'reload schema';
