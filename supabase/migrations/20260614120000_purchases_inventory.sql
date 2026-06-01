-- Compras + Inventario — buying merchandise and tracking costed stock.
--
-- A purchase capitalizes goods into inventory (or hits an asset/expense account
-- for non-goods), with its NCF + ITBIS (creditable) + optional retentions, and
-- posts a balanced asiento (source='purchase'). Goods purchases also create an
-- inventory IN movement at the unit cost.
--
-- Inventory is a kardex: movements (in/out/adjust) are the source of truth, and
-- weighted-average cost + on-hand qty are derived from them (see
-- lib/accounting/inventory). Cost of sale (salida) posts Debit Costo de venta /
-- Credit Inventario at the current average cost.
--
-- Amounts are DOP. Single-tenant + team RLS.

-- ---------------------------------------------------------------------------
-- 1. Inventory items
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_items (
  id           text primary key,
  profile_id   text not null default 'team' references public.profiles(id) on delete cascade,
  sku          text default '',
  name         text not null,
  unit         text default 'unidad',
  -- Cached on-hand qty + moving-average cost (the kardex movements are the
  -- source of truth; these are maintained for fast reads / pickers).
  qty_on_hand  numeric not null default 0,
  avg_cost     numeric not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists inventory_items_profile_idx on public.inventory_items(profile_id);
create unique index if not exists inventory_items_sku_uq
  on public.inventory_items(profile_id, sku) where sku <> '';

alter table public.inventory_items enable row level security;
do $$ begin
  create policy inventory_items_team_rw on public.inventory_items
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. Inventory movements (kardex)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_movements (
  id           text primary key,
  profile_id   text not null default 'team' references public.profiles(id) on delete cascade,
  item_id      text not null references public.inventory_items(id) on delete cascade,
  type         text not null check (type in ('in','out','adjust')),
  qty          numeric not null default 0,
  unit_cost    numeric not null default 0,
  moved_at     timestamptz not null default now(),
  ref_table    text,
  ref_id       text,
  memo         text default '',
  journal_entry_id text references public.journal_entries(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists inventory_movements_profile_idx on public.inventory_movements(profile_id);
create index if not exists inventory_movements_item_idx      on public.inventory_movements(item_id);
create index if not exists inventory_movements_date_idx        on public.inventory_movements(moved_at);

alter table public.inventory_movements enable row level security;
do $$ begin
  create policy inventory_movements_team_rw on public.inventory_movements
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 3. Purchases (Compras)
-- ---------------------------------------------------------------------------
create table if not exists public.purchases (
  id               text primary key,
  profile_id       text not null default 'team' references public.profiles(id) on delete cascade,
  number           integer,
  supplier_id      text references public.suppliers(id) on delete set null,
  purchase_at      timestamptz not null default now(),
  ncf              text default '',
  ncf_type         text default '',
  -- 'goods' → capitalizes to inventory; 'asset'/'service' → hits account_code.
  kind             text not null default 'goods' check (kind in ('goods','asset','service')),
  account_code     text references public.accounts(code),
  -- For goods: the inventory item received + qty (drives the kardex IN).
  item_id          text references public.inventory_items(id) on delete set null,
  qty              numeric not null default 0,
  base             numeric not null default 0,
  itbis            numeric not null default 0,
  itbis_creditable boolean not null default true,
  retention_isr    numeric not null default 0,
  retention_itbis  numeric not null default 0,
  payment_method   text not null default 'credit' check (payment_method in ('cash','bank','card','credit')),
  paid_at          timestamptz,
  journal_entry_id text references public.journal_entries(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists purchases_profile_idx  on public.purchases(profile_id);
create index if not exists purchases_supplier_idx   on public.purchases(supplier_id);
create index if not exists purchases_date_idx         on public.purchases(purchase_at);
create unique index if not exists purchases_number_uq
  on public.purchases(profile_id, number) where number is not null;

alter table public.purchases enable row level security;
do $$ begin
  create policy purchases_team_rw on public.purchases
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
