-- lsg_stock_commitments — the per-quote LifestyleGarden inventory reservation
-- ledger that makes the Shopify stock push idempotent + reversible.
--
-- One row per quote (id = the quote id, 1:1). `committed` is the units of each
-- LSG product currently deducted from the lifestylegarden.do Shopify store on
-- this quote's behalf: { "<lsg productId>": units }. A lifecycle transition
-- recomputes the DESIRED units and pushes only the delta (committed → desired)
-- — so committing twice never double-deducts and a revert restocks exactly what
-- was taken. Kept OUT of the quotes row on purpose: the editor's full-row puts
-- + undo/redo snapshots must never rewind this ledger, and a quote delete must
-- still leave the committed figures readable long enough to restock.
--
-- Deliberately NOT a credential table and additive only — safe under the
-- single-tenant "team can write" RLS. No FK to quotes (no cascade): the app
-- restocks from the committed figures, THEN clears the row, so a cascade would
-- erase the data the restock needs.

create table if not exists public.lsg_stock_commitments (
  id          text primary key,
  profile_id  text not null default 'team',
  committed   jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.lsg_stock_commitments enable row level security;

drop policy if exists lsg_stock_commitments_rw on public.lsg_stock_commitments;
create policy lsg_stock_commitments_rw on public.lsg_stock_commitments
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
