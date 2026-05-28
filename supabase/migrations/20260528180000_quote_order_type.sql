-- Floor vs special order classification on a quote. Drives the assigned
-- professional's base commission rate: floor ("venta de piso") = 15%,
-- special order = 20%. The toggle is independent of whether the quote is
-- attached to an order. Existing rows default to 'floor' (15%).
alter table public.quotes
  add column if not exists order_type text not null default 'floor';

-- Constrain to the two known values (drop-then-add so the migration is
-- idempotent and safe to re-run).
alter table public.quotes drop constraint if exists quotes_order_type_check;
alter table public.quotes
  add constraint quotes_order_type_check check (order_type in ('floor', 'special'));

-- Seed existing rows: a quote attached to an order was, under the prior
-- implicit semantics (commissionOwedAt keyed off order_id), a special order.
-- Map those to 'special' so their commission base starts at 20% instead of
-- silently dropping to the floor 15%. New quotes default to 'floor' and the
-- toggle is manual from here on.
update public.quotes set order_type = 'special' where order_id is not null;

notify pgrst, 'reload schema';
