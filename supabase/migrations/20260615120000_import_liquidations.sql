-- Import liquidations (liquidación aduanal / DGA) — landing imported goods at
-- their real cost in RD.
--
-- An import liquidation captures the customs numbers on a shipment: CIF, the
-- gravamen arancelario (20% by default per owner), the ITBIS de importación
-- (creditable), and the despacho/agent fees. Everything except the ITBIS is
-- capitalized into the goods' LANDED COST; the ITBIS is input credit. Posting it
-- books the asiento (source='import') and creates a kardex IN at the landed unit
-- cost — so Costo de venta and margins reflect the true delivered cost, not just
-- the FOB. Optionally linked to the order it belongs to (the existing
-- in_transit→in_customs→received flow).
--
-- Amounts are DOP. Single-tenant + team RLS.

create table if not exists public.import_liquidations (
  id               text primary key,
  profile_id       text not null default 'team' references public.profiles(id) on delete cascade,
  number           integer,
  order_id         text references public.orders(id) on delete set null,
  supplier_id      text references public.suppliers(id) on delete set null,
  item_id          text references public.inventory_items(id) on delete set null,
  liquidated_at    timestamptz not null default now(),
  -- Customs declaration ref (DUA / número de declaración).
  customs_ref      text default '',
  qty              numeric not null default 0,
  cif              numeric not null default 0,
  duty             numeric not null default 0,   -- gravamen arancelario
  import_itbis     numeric not null default 0,   -- ITBIS de importación (crédito)
  clearance_fees   numeric not null default 0,   -- agente aduanal + tasas
  other_costs      numeric not null default 0,
  payment_method   text not null default 'bank' check (payment_method in ('cash','bank','card','credit')),
  journal_entry_id text references public.journal_entries(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists import_liquidations_profile_idx on public.import_liquidations(profile_id);
create index if not exists import_liquidations_order_idx     on public.import_liquidations(order_id);
create index if not exists import_liquidations_date_idx        on public.import_liquidations(liquidated_at);
create unique index if not exists import_liquidations_number_uq
  on public.import_liquidations(profile_id, number) where number is not null;

alter table public.import_liquidations enable row level security;
do $$ begin
  create policy import_liquidations_team_rw on public.import_liquidations
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
