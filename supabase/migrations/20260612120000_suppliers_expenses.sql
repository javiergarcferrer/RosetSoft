-- Suppliers + Expenses (Gastos) — the first event-posting module on top of the
-- general ledger.
--
-- An expense captures a class-6 operating cost with its NCF, ITBIS and (when we
-- act as withholding agent for that supplier) its ISR / ITBIS retentions. Saving
-- one posts a balanced asiento to the ledger (source='expense') and links back
-- via journal_entry_id; the 606 report is then a pure projection of these rows.
--
-- Retention is per-supplier (owner: "somos agente de retención cuando un
-- proveedor lo necesita"): the supplier carries retain_isr / retain_itbis flags;
-- the rates come from accounting_config. No exempt operations (owner) ⇒ input
-- ITBIS is creditable by default.
--
-- Amounts are DOP (operating expenses are local). Single-tenant + team RLS.

-- ---------------------------------------------------------------------------
-- 1. Suppliers
-- ---------------------------------------------------------------------------
create table if not exists public.suppliers (
  id                  text primary key,
  profile_id          text not null default 'team' references public.profiles(id) on delete cascade,
  number              integer,
  name                text not null,
  rnc                 text default '',
  -- Tax personhood — drives which 606 retention columns apply.
  kind                text not null default 'juridica' check (kind in ('fisica','juridica','exterior')),
  -- We withhold for this supplier only when these are on (owner's rule).
  retain_isr          boolean not null default false,
  retain_itbis        boolean not null default false,
  -- Optional default expense account to pre-fill the gasto form.
  default_account_code text references public.accounts(code) on delete set null,
  email               text default '',
  phone               text default '',
  notes               text default '',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists suppliers_profile_idx on public.suppliers(profile_id);
create unique index if not exists suppliers_number_uq
  on public.suppliers(profile_id, number) where number is not null;

alter table public.suppliers enable row level security;
do $$ begin
  create policy suppliers_team_rw on public.suppliers
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. Expenses (Gastos)
-- ---------------------------------------------------------------------------
create table if not exists public.expenses (
  id                  text primary key,
  profile_id          text not null default 'team' references public.profiles(id) on delete cascade,
  number              integer,
  supplier_id         text references public.suppliers(id) on delete set null,
  expense_at          timestamptz not null default now(),
  ncf                 text default '',
  ncf_type            text default '',
  -- The class-6 expense account this gasto hits.
  account_code        text references public.accounts(code),
  description         text default '',
  base                numeric not null default 0,
  itbis               numeric not null default 0,
  -- No exempt ops ⇒ true by default; left configurable for edge cases.
  itbis_creditable    boolean not null default true,
  retention_isr       numeric not null default 0,
  retention_itbis     numeric not null default 0,
  payment_method      text not null default 'bank' check (payment_method in ('cash','bank','card','credit')),
  paid_at             timestamptz,
  -- The posted asiento this expense generated.
  journal_entry_id    text references public.journal_entries(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists expenses_profile_idx  on public.expenses(profile_id);
create index if not exists expenses_supplier_idx  on public.expenses(supplier_id);
create index if not exists expenses_date_idx        on public.expenses(expense_at);
create unique index if not exists expenses_number_uq
  on public.expenses(profile_id, number) where number is not null;

alter table public.expenses enable row level security;
do $$ begin
  create policy expenses_team_rw on public.expenses
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
