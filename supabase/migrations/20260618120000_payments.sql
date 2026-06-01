-- Payments (Cobros / Pagos) — the money-movement loop against receivables and
-- payables.
--
-- A cobro (direction='in') collects from a customer → reduces CxC; a pago
-- ('out') pays a supplier → reduces CxP. Each posts a balanced asiento
-- (source='payment'). Card collections carry the DR payment-gateway quirks: the
-- processor keeps a commission (+ its ITBIS) and may retain ITBIS/ISR as a
-- withholding agent, so the bank receives the NET while CxC clears at the GROSS;
-- the commission is an expense and the retained taxes are input credits.
--
-- Amounts are DOP. Single-tenant + team RLS.

create table if not exists public.payments (
  id               text primary key,
  profile_id       text not null default 'team' references public.profiles(id) on delete cascade,
  number           integer,
  direction        text not null check (direction in ('in','out')),
  party_type       text not null check (party_type in ('customer','supplier')),
  party_id         text,
  paid_at          timestamptz not null default now(),
  amount           numeric not null default 0,    -- gross
  method           text not null default 'bank' check (method in ('cash','bank','card','transfer')),
  reference        text default '',
  -- Card/gateway deductions (cobros): kept by the processor.
  commission       numeric not null default 0,
  commission_itbis numeric not null default 0,
  itbis_retained   numeric not null default 0,
  isr_retained     numeric not null default 0,
  notes            text default '',
  journal_entry_id text references public.journal_entries(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists payments_profile_idx on public.payments(profile_id);
create index if not exists payments_party_idx     on public.payments(party_type, party_id);
create index if not exists payments_date_idx        on public.payments(paid_at);
create unique index if not exists payments_number_uq
  on public.payments(profile_id, number) where number is not null;

alter table public.payments enable row level security;
do $$ begin
  create policy payments_team_rw on public.payments
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
