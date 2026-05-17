-- Order lifecycle rename + quote-level delivery comeback.
--
-- The first orders migration (20260517120000_orders_fulfillment.sql) used
-- terms borrowed from generic e-commerce — `placed` for "sent to vendor"
-- and `delivered` for "everything's done". The dealer's actual mental
-- model is closer to:
--
--   ordered   = order placed with Ligne Roset (vendor accepted)
--   received  = the physical goods have arrived in DR (all containers in)
--
-- and *delivery* is a per-customer event that happens after the order has
-- been received — the dealer picks each quote, schedules a delivery, and
-- marks that quote delivered when the customer takes possession. Multiple
-- quotes in one order get delivered on different days.
--
-- This migration:
--
--  1. Renames the order's terminal lifecycle so the words match what the
--     dealer says out loud (placed→ordered, delivered→received).
--  2. Adds quote.delivered_at back. The other 4 per-quote fulfillment
--     timestamps (customer_notified / deposit_paid / specs_locked /
--     balance_paid) stay deleted — those moved to the order level
--     (deposit_received_at), are implicit (the quote was accepted ⇒
--     specs are locked), or aren't tracked formally (notifications,
--     final balance — both are status of the per-customer relationship,
--     not the workflow object).
--
-- The container 6-stage pipeline is untouched: dealers want the full
-- shipping narrative (filling → submitting → ordered → in_transit →
-- landing → received) per container, and the order's `received` state
-- rolls up from every container reaching the terminal.
--
-- No container_count column is added — the order's container demand is
-- derived from the number of container rows attached (with a floor of 1
-- for orders that haven't created any container yet). The dispatch
-- threshold widget multiplies that count by settings.dispatch_threshold.

-- ---------------------------------------------------------------------------
-- 1. Order timestamp rename: placed_at → ordered_at, delivered_at → received_at
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists ordered_at  timestamptz,
  add column if not exists received_at timestamptz;

-- Carry data forward; coalesce so a partially-migrated row doesn't get
-- clobbered if this runs twice.
update public.orders
  set ordered_at  = coalesce(ordered_at,  placed_at)
  where placed_at is not null;

update public.orders
  set received_at = coalesce(received_at, delivered_at)
  where delivered_at is not null;

-- Status enum rename.
update public.orders set status = 'ordered'  where status = 'placed';
update public.orders set status = 'received' where status = 'delivered';

alter table public.orders
  drop column if exists placed_at,
  drop column if exists delivered_at;

-- ---------------------------------------------------------------------------
-- 2. Per-quote delivery flag
-- ---------------------------------------------------------------------------
-- This column was added by 20260516120200 and dropped by 20260517120000;
-- we're bringing it back, this time as the *only* surviving per-quote
-- fulfillment timestamp. Empty for every existing quote — the previous
-- per-quote delivered_at semantics ("the container holding this quote was
-- complete") was always coarser than what the dealer wanted, so we
-- intentionally don't backfill.
alter table public.quotes
  add column if not exists delivered_at timestamptz;
