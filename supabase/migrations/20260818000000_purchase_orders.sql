-- Purchase orders (órdenes de compra) — the PO → bill workflow. A PO is NOT
-- fiscal; only the bill it becomes (with its NCF) posts to the 606. Additive.

create table if not exists purchase_orders (
  id           text primary key,
  profile_id   text not null default 'team',
  number       integer,
  supplier_id  text,
  ordered_at   timestamptz not null default now(),
  status       text not null default 'open',
  lines        jsonb not null default '[]'::jsonb,
  notes        text,
  expediente_id text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table purchase_orders drop constraint if exists purchase_orders_status_chk;
alter table purchase_orders add  constraint purchase_orders_status_chk check (status in ('open', 'received', 'billed', 'cancelled'));

create unique index if not exists purchase_orders_number_uq  on purchase_orders (profile_id, number);
create index        if not exists purchase_orders_profile_idx on purchase_orders (profile_id);

alter table purchase_orders enable row level security;
drop policy if exists purchase_orders_rw on purchase_orders;
create policy purchase_orders_rw on purchase_orders for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
