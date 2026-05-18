-- Simplify containers, formalize the order lifecycle, and put deposit /
-- balance milestones back on the quote where they actually live.
--
-- The dealer's mental model (verbatim, May 18 2026):
--
--   "Los contenedores no tienen estatus cambiantes. Solo se marca si
--    están llenos. El pedido es borrador, colocado, confirmado, en
--    ruta, en aduanas y recibido. El depósito y pago de balance se
--    marcan respectivos a la cotización. El acto de confirmar la
--    cotización es recibir el depósito literalmente así que no es un
--    estatus aparte."
--
-- The pieces this migration moves:
--
--   1. Order lifecycle is now SIX stages, focused on the LR-side
--      logistics narrative (no more "accepted" / "deposit_received"
--      stages on the order — those concepts live on the quote now):
--
--        draft       Borrador      preparing the order in our system
--        placed      Colocado      order placed with Ligne Roset
--        confirmed   Confirmado    LR confirmed receipt of order
--        in_transit  En ruta       shipped from France
--        in_customs  En aduanas    arrived at DR customs
--        received    Recibido      cleared customs, in DR warehouse
--
--      Plus the existing terminal alt:
--        cancelled   Cancelado
--
--   2. Containers lose their 6-stage pipeline entirely. A container
--      is now binary: either filled (packed at the warehouse) or not.
--      All movement / arrival / receipt narration has moved to the
--      order. The container's only job is to record the moment the
--      dealer packs it; the goods inside are tracked by the order.
--
--   3. Two timestamps come (back) onto the quote:
--
--        deposit_received_at   when the client paid the deposit.
--                              The act of "confirming" the quote IS
--                              the deposit landing — these are the
--                              same event, recorded once.
--        balance_paid_at       when the client paid the balance.
--                              Required before marking the quote
--                              delivered (the dealer's rule: balance
--                              must clear before goods leave the
--                              warehouse).
--
--      The existing quote.delivered_at stays.
--
-- Backfill strategy
-- -----------------
-- Existing rows are migrated as conservatively as possible — we never
-- invent timestamps we don't have evidence for, and we never lose data
-- the dealer can still see in the UI.

-- ---------------------------------------------------------------------------
-- 1. Quotes — new milestone columns + backfill from the order
-- ---------------------------------------------------------------------------
alter table public.quotes
  add column if not exists deposit_received_at timestamptz,
  add column if not exists balance_paid_at     timestamptz;

-- If the order had a deposit_received_at, copy it onto every attached
-- quote (best evidence we have for "when did this customer's deposit
-- land"). Quotes with no order, or with an order that never recorded
-- a deposit, stay null — the dealer will mark them when relevant.
update public.quotes q
   set deposit_received_at = o.deposit_received_at
  from public.orders o
 where q.order_id = o.id
   and o.deposit_received_at is not null
   and q.deposit_received_at is null;

-- ---------------------------------------------------------------------------
-- 2. Orders — new stage timestamps + status migration
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists placed_at      timestamptz,
  add column if not exists confirmed_at   timestamptz,
  add column if not exists in_transit_at  timestamptz,
  add column if not exists in_customs_at  timestamptz;

-- The previous "ordered" stage was the LR-handoff moment — what we
-- now call "placed". Carry the timestamp over.
update public.orders
   set placed_at = coalesce(placed_at, ordered_at)
 where ordered_at is not null;

-- Status remap:
--   accepted / deposit_received → draft  (these stages were lifecycle
--       milestones on the order; they're commerce milestones on the
--       quote in the new model, so the order itself reverts to draft
--       until the dealer places it with LR)
--   ordered → placed
--   received → received  (unchanged)
--   cancelled → cancelled (unchanged)
update public.orders set status = 'draft'  where status in ('accepted', 'deposit_received');
update public.orders set status = 'placed' where status = 'ordered';

-- Drop the order-level columns that have moved (or were renamed):
alter table public.orders
  drop column if exists accepted_at,
  drop column if exists deposit_received_at,
  drop column if exists ordered_at;

-- ---------------------------------------------------------------------------
-- 3. Containers — collapse the 6-stage pipeline into a single timestamp
-- ---------------------------------------------------------------------------
alter table public.containers
  add column if not exists filled_at timestamptz;

-- Backfill: any container past the 'filling' stage was, by definition,
-- packed at some point. Use updated_at as the best-available proxy for
-- when that happened — the prior schema didn't track a discrete
-- "filled" event, but anything beyond filling implies it.
update public.containers
   set filled_at = coalesce(filled_at, updated_at)
 where stage is not null
   and stage <> 'filling';

-- Drop the pipeline columns. The container is now structurally
-- just (id, profile_id, order_id, number, name, code, notes,
-- filled_at, created_at, updated_at) — no stage machine, no
-- per-stage timestamps, no legacy 'open'/'dispatched' status.
alter table public.containers
  drop column if exists stage,
  drop column if exists submitted_at,
  drop column if exists ordered_at,
  drop column if exists shipped_at,
  drop column if exists landed_at,
  drop column if exists completed_at,
  drop column if exists status,
  drop column if exists dispatched_at;

drop index if exists containers_status_idx;
