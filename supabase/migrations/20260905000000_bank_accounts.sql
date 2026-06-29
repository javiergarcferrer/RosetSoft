-- Bank accounts (cuentas bancarias) + multi-currency cobros.
--
-- The dealer configures their real bank accounts (DOP and USD), collects/pays
-- through a chosen account, and reconciles per account — including a USD account
-- whose statement is in dollars. The ledger stays in DOP (the functional
-- currency): a USD cobro records the dollars + rate on its bank line and posts
-- the DOP equivalent. Additive + idempotent.

create table if not exists public.bank_accounts (
  id              text primary key,
  profile_id      text not null default 'team',
  name            text not null,
  bank            text,                       -- BANK_PROFILES key ('popular'…) for the statement importer
  currency        text not null default 'DOP',
  account_code    text,                       -- postable chart leaf under 1-01-001 (Cajas y Bancos)
  account_number  text,                       -- masked, display only
  opening_balance numeric not null default 0,
  opening_at      timestamptz,
  archived        boolean not null default false,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.bank_accounts drop constraint if exists bank_accounts_currency_chk;
alter table public.bank_accounts add  constraint bank_accounts_currency_chk check (currency in ('DOP', 'USD'));

create index if not exists bank_accounts_profile_idx on public.bank_accounts (profile_id);

alter table public.bank_accounts enable row level security;
drop policy if exists bank_accounts_rw on public.bank_accounts;
create policy bank_accounts_rw on public.bank_accounts for all to authenticated using (true) with check (true);

-- Multi-currency + bank-account context on cobros/pagos. `amount` stays the DOP
-- value posted to the ledger; usd_amount/fx_rate hold the foreign figure + rate.
alter table public.payments
  add column if not exists currency        text not null default 'DOP',
  add column if not exists usd_amount      numeric,
  add column if not exists fx_rate         numeric,
  add column if not exists bank_account_id text;

-- Tag the bank/cash journal line with its configured account so reconciliation
-- groups by real bank account (not just chart code).
alter table public.journal_lines
  add column if not exists bank_account_id text;

create index if not exists journal_lines_bank_account_idx on public.journal_lines (bank_account_id);

notify pgrst, 'reload schema';
