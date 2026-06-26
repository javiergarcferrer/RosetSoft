-- Link a cobro to the quote whose deposit it confirms.
--
-- The deposit used to live in TWO places: a milestone on the quote AND a
-- payment in the books — with nothing tying them together, so the two could
-- drift (the "double entry" risk). The flow is now one-directional: the quote
-- only SIGNALS that a deposit was taken (the `deposit_received_at` milestone),
-- and accounting is the single source of truth for the money. This column is
-- the precise link back: the advance cobro the dealer registers to CONFIRM a
-- signalled deposit carries the quote's id, so a quote with a deposit signal
-- and no matching cobro is exactly the "Depósitos por confirmar" queue.
--
-- Additive + nullable: every existing payment (and every supplier pago) keeps
-- quote_id null. Set null on quote delete so a removed quote never orphans the
-- ledger row.
alter table public.payments
  add column if not exists quote_id text references public.quotes(id) on delete set null;

create index if not exists payments_quote_idx on public.payments(quote_id) where quote_id is not null;

notify pgrst, 'reload schema';
