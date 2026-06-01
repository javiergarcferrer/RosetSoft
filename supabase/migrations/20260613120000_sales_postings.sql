-- Sales postings (Facturación) — recognizing a sale at DELIVERY.
--
-- Owner's rule: the furniture is invoiced when it's DELIVERED, not when the
-- quote is accepted. The deposit taken earlier sits as a liability (cobros
-- anticipados); at delivery we recognize the revenue + ITBIS, apply the deposit,
-- and leave the remainder as a receivable. This module records that event
-- WITHOUT touching the quote flow: a sales_posting row per invoiced quote,
-- carrying its NCF and the booked figures, linked to the asiento it generated.
-- The 607 + the ITBIS liquidation (IT-1) are then projections of these rows.
--
-- One posting per quote (unique quote_id) prevents double-invoicing. Figures are
-- DOP (booked at the quote's locked USD→DOP rate); usd_total + rate are kept for
-- traceability.

-- Customer fiscal id (RNC for jurídica / cédula for física). Optional —
-- consumidor final sales have none.
alter table public.customers
  add column if not exists rnc text default '';

create table if not exists public.sales_postings (
  id               text primary key,
  profile_id       text not null default 'team' references public.profiles(id) on delete cascade,
  number           integer,
  quote_id         text references public.quotes(id) on delete set null,
  customer_id      text references public.customers(id) on delete set null,
  posted_at        timestamptz not null default now(),
  ncf              text default '',
  ncf_type         text default '',
  -- Fiscal id snapshot (so the 607 is stable even if the customer is edited).
  rnc              text default '',
  base             numeric not null default 0,
  itbis            numeric not null default 0,
  total            numeric not null default 0,
  deposit_applied  numeric not null default 0,
  rate             numeric,
  usd_total        numeric,
  journal_entry_id text references public.journal_entries(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists sales_postings_profile_idx on public.sales_postings(profile_id);
create index if not exists sales_postings_date_idx      on public.sales_postings(posted_at);
create index if not exists sales_postings_customer_idx    on public.sales_postings(customer_id);
-- At most one invoice per quote.
create unique index if not exists sales_postings_quote_uq
  on public.sales_postings(quote_id) where quote_id is not null;
create unique index if not exists sales_postings_number_uq
  on public.sales_postings(profile_id, number) where number is not null;

alter table public.sales_postings enable row level security;
do $$ begin
  create policy sales_postings_team_rw on public.sales_postings
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
