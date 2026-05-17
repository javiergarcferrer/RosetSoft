-- Orders entity: the operational unit that bundles accepted quotes with the
-- physical containers fulfilling them. Replaces the previous model where a
-- quote pinned directly to a container and "fulfillment" was a parallel set
-- of independent timestamps on the quote.
--
-- Lifecycle:
--   draft             pre-acceptance scaffolding (rare — orders usually
--                     come into existence at accept-time via the UI)
--   accepted          customer signed off on the linked quote(s)
--   deposit_received  customer paid the deposit (cleared funds)
--   placed            order placed with Ligne Roset
--    │
--    └─ from here, the container.stage values take over the fulfillment
--       narrative (filling → submitting → ordered → in_transit → landing
--       → received). The order itself stays at 'placed' until …
--   delivered         every container has been received and the customer
--                     has taken delivery of every quote line
--   cancelled         terminal — won't be fulfilled
--
-- Relationship change: a Container now belongs to an Order (containers.order_id).
-- A Quote can be attached to an Order once accepted (quotes.order_id). Quotes
-- no longer link directly to a container — the order is the integration
-- point, so the dealer never has to decide-at-quote-time which container
-- a sale will ride in.

-- ---------------------------------------------------------------------------
-- 1. Orders table
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id                   text primary key,
  profile_id           text not null references public.profiles(id) on delete cascade,
  number               integer,
  name                 text default '',
  customer_id          text references public.customers(id) on delete set null,
  status               text not null default 'draft',
    -- draft | accepted | deposit_received | placed | delivered | cancelled
  notes                text default '',
  deposit_amount       numeric default 0,
  delivery_address     text default '',
  accepted_at          timestamptz,
  deposit_received_at  timestamptz,
  placed_at            timestamptz,
  delivered_at         timestamptz,
  cancelled_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists orders_profile_updated_idx on public.orders(profile_id, updated_at desc);
create index if not exists orders_status_idx          on public.orders(status);
create index if not exists orders_customer_idx        on public.orders(customer_id);

-- RLS — same single-tenant policy as the rest of the schema.
alter table public.orders enable row level security;
drop policy if exists "team can read"  on public.orders;
drop policy if exists "team can write" on public.orders;
create policy "team can read"  on public.orders
  for select to authenticated using (true);
create policy "team can write" on public.orders
  for all to authenticated using (true) with check (true);

-- Counter for auto-numbered O-YYYY-NNNN order IDs (parallel to the existing
-- container_counter). Seeded high so migrated orders that inherit their
-- container's number don't collide with freshly created ones.
alter table public.settings
  add column if not exists order_counter integer default 100;

-- ---------------------------------------------------------------------------
-- 2. Link columns on containers + quotes
-- ---------------------------------------------------------------------------
alter table public.containers
  add column if not exists order_id text references public.orders(id) on delete set null;
create index if not exists containers_order_idx on public.containers(order_id);

alter table public.quotes
  add column if not exists order_id text references public.orders(id) on delete set null;
create index if not exists quotes_order_idx on public.quotes(order_id);

-- ---------------------------------------------------------------------------
-- 3. Rename the terminal container stage 'complete' → 'received'
--
-- The user-facing language is "received" — "the container arrived" — and the
-- order-level 'delivered' status is reserved for the customer taking delivery.
-- Keeping the two distinct makes the stepper unambiguous.
-- ---------------------------------------------------------------------------
update public.containers set stage = 'received' where stage = 'complete';

-- ---------------------------------------------------------------------------
-- 4. Data migration: every existing container becomes one Order.
--
-- The new order's id derives from the container id ('o-' || container.id) so
-- the migration is deterministic and re-runnable; ON CONFLICT DO NOTHING
-- means re-applying the migration after a partial run is a no-op.
--
-- Customer assignment: pick the first quote's customer if the container had
-- any pinned quotes; otherwise the order opens with no customer (the dealer
-- assigns one in the UI). Status maps from the container's pipeline stage:
--   filling/submitting/ordered/in_transit/landing  → 'placed' (mid-flight)
--   received                                       → 'delivered'
-- ---------------------------------------------------------------------------
do $migration$
declare
  c record;
  new_id text;
begin
  for c in select * from public.containers loop
    new_id := 'o-' || c.id;

    insert into public.orders (
      id, profile_id, number, name, customer_id, status, notes,
      accepted_at, deposit_received_at, placed_at, delivered_at,
      created_at, updated_at
    ) values (
      new_id,
      c.profile_id,
      c.number,
      coalesce(c.name, ''),
      (select customer_id from public.quotes where container_id = c.id limit 1),
      case when c.stage = 'received' then 'delivered' else 'placed' end,
      coalesce(c.notes, ''),
      -- Best-effort mapping of container milestones to order timestamps:
      -- accepted_at ≈ when the container started filling (the order existed
      -- in concept once quotes started pinning); deposit_received ≈ the
      -- 'submitting' milestone (when specs are locked + deposits collected);
      -- placed_at = the 'ordered' milestone; delivered_at = 'completed_at'.
      c.created_at,
      coalesce(c.submitted_at, c.created_at),
      coalesce(c.ordered_at, c.submitted_at),
      c.completed_at,
      c.created_at,
      c.updated_at
    )
    on conflict (id) do nothing;

    -- Link container → order; link any pinned quotes → same order.
    update public.containers set order_id = new_id where id = c.id;
    update public.quotes      set order_id = new_id where container_id = c.id;
  end loop;
end
$migration$;

-- ---------------------------------------------------------------------------
-- 5. Drop the legacy quote columns now that orders own this data.
--
-- quote.container_id           moved to quote.order_id via the migration above
-- customer_notified_at         removed — fulfillment milestones no longer
-- deposit_paid_at                live on the quote; deposit moves to
-- specs_locked_at                order.deposit_received_at, the rest of
-- balance_paid_at                the journey is driven by container stages
-- delivered_at                   and order.delivered_at
-- ---------------------------------------------------------------------------
alter table public.quotes
  drop column if exists container_id,
  drop column if exists customer_notified_at,
  drop column if exists deposit_paid_at,
  drop column if exists specs_locked_at,
  drop column if exists balance_paid_at,
  drop column if exists delivered_at;

-- ---------------------------------------------------------------------------
-- 6. Settings: the per-team default container becomes a default order.
-- ---------------------------------------------------------------------------
alter table public.settings
  add column if not exists default_order_id text;

-- Carry the dealer's existing default forward: if they had a default
-- container, the corresponding migrated order is now the default order.
update public.settings
  set default_order_id = 'o-' || default_container_id
  where default_container_id is not null
    and default_order_id is null;

alter table public.settings
  drop column if exists default_container_id;
