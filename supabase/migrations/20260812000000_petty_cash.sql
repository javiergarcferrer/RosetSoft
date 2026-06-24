-- Caja chica (petty cash) — imprest funds + vouchers (vales).
-- Each voucher posts a balanced asiento (journal_entry_id); an expense vale that
-- carries an NCF also feeds the DGII 606. Additive + idempotent.

create table if not exists petty_cash_funds (
  id            text primary key,
  profile_id    text not null default 'team',
  number        integer,
  name          text not null default 'Caja chica',
  account_code  text,
  fixed_amount  numeric not null default 0,
  custodian     text,
  status        text not null default 'open',
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists petty_cash_vouchers (
  id               text primary key,
  profile_id       text not null default 'team',
  fund_id          text not null references petty_cash_funds(id) on delete cascade,
  number           integer,
  type             text not null default 'expense',
  voucher_at       timestamptz not null default now(),
  description      text,
  account_code     text,
  supplier_id      text,
  beneficiary      text,
  ncf              text,
  ncf_type         text,
  base             numeric not null default 0,
  itbis            numeric not null default 0,
  itbis_creditable boolean default true,
  total            numeric not null default 0,
  direction        text,
  payment_method   text,
  journal_entry_id text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- value constraints (drop-then-add so re-running is safe)
alter table petty_cash_funds    drop constraint if exists petty_cash_funds_status_chk;
alter table petty_cash_funds    add  constraint petty_cash_funds_status_chk check (status in ('open', 'closed'));
alter table petty_cash_vouchers drop constraint if exists petty_cash_vouchers_type_chk;
alter table petty_cash_vouchers add  constraint petty_cash_vouchers_type_chk check (type in ('opening', 'expense', 'replenishment', 'adjustment'));
alter table petty_cash_vouchers drop constraint if exists petty_cash_vouchers_direction_chk;
alter table petty_cash_vouchers add  constraint petty_cash_vouchers_direction_chk check (direction is null or direction in ('short', 'over'));

create unique index if not exists petty_cash_funds_number_uq    on petty_cash_funds (profile_id, number);
create unique index if not exists petty_cash_vouchers_number_uq on petty_cash_vouchers (profile_id, number);
create index        if not exists petty_cash_vouchers_fund_idx   on petty_cash_vouchers (fund_id);
create index        if not exists petty_cash_vouchers_period_idx on petty_cash_vouchers (profile_id, voucher_at);

alter table petty_cash_funds    enable row level security;
alter table petty_cash_vouchers enable row level security;

drop policy if exists petty_cash_funds_rw on petty_cash_funds;
create policy petty_cash_funds_rw on petty_cash_funds for all to authenticated using (true) with check (true);
drop policy if exists petty_cash_vouchers_rw on petty_cash_vouchers;
create policy petty_cash_vouchers_rw on petty_cash_vouchers for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
