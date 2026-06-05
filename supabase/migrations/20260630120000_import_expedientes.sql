-- Import EXPEDIENTES — the complete customs-liquidation file for one shipment
-- (one BL). Where `import_liquidations` lands a single article, an expediente
-- lands a whole shipment: its product lines (each with a CIF value) PLUS an
-- itemized cost sheet (agenciamiento/FDA, transporte, puerto/Caucedo, tasa DGA,
-- seguro, almacenaje…). Each cost's NET (amount − its ITBIS) capitalizes into the
-- goods' landed cost, prorated across the lines by CIF value; the ITBIS portions
-- are recoverable input credit. A cost carrying a DR supplier + NCF lands in the
-- 606. Posting books one asiento (source='import') + a kardex IN per line at the
-- landed unit cost. Amounts are DOP. Single-tenant + team RLS.

create table if not exists public.import_expedientes (
  id               text primary key,
  profile_id       text not null default 'team' references public.profiles(id) on delete cascade,
  number           integer,
  -- Bill of lading (links to the tracked container) + customs declaration ref.
  bl               text default '',
  customs_ref      text default '',
  supplier_id      text references public.suppliers(id) on delete set null,  -- foreign supplier (Roset)
  order_id         text references public.orders(id) on delete set null,
  container_id     text references public.containers(id) on delete set null,
  liquidated_at    timestamptz not null default now(),
  cif              numeric not null default 0,   -- total CIF / valor en aduana
  duty             numeric not null default 0,   -- gravamen arancelario (total)
  import_itbis     numeric not null default 0,   -- ITBIS de importación (crédito)
  -- Itemized cost sheet: [{ id, concept, label?, supplierId?, ncf?, amount, itbis?, paymentMethod? }].
  costs            jsonb,
  -- Product lines landed: [{ id, itemId?, name, reference?, qty, cifValue }].
  lines            jsonb,
  payment_method   text not null default 'bank' check (payment_method in ('cash','bank','card','credit')),
  journal_entry_id text references public.journal_entries(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists import_expedientes_profile_idx on public.import_expedientes(profile_id);
create index if not exists import_expedientes_order_idx     on public.import_expedientes(order_id);
create index if not exists import_expedientes_date_idx       on public.import_expedientes(liquidated_at);
create unique index if not exists import_expedientes_number_uq
  on public.import_expedientes(profile_id, number) where number is not null;

alter table public.import_expedientes enable row level security;
do $$ begin
  create policy import_expedientes_team_rw on public.import_expedientes
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
