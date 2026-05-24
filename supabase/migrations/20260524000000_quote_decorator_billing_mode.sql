-- Per-quote "how do we settle the decorator's cut" modality.
--
-- Domain context
-- --------------
-- Outside professionals (decorators / architects) have a *trade discount*
-- — the same percentage we today call their "commission" (default 15%).
-- There are two ways that single rate gets realized, and which one a deal
-- uses is decided per-quote:
--
--   • 'commission'     — we invoice the CLIENT at the full price and pay
--                        the decorator their % as a commission. (Today's
--                        behavior; the default.)
--
--   • 'trade_discount' — we invoice the DECORATOR at their % off (the same
--                        rate), and pay NO commission — the decorator
--                        already took their cut via the discount. The
--                        client still sees the full price.
--
-- This is purely an internal / accounting distinction so the accountant
-- knows HOW and WHOM to invoice. The net the dealer gives up is identical
-- either way; only the AR direction changes. It NEVER affects the client
-- PDF (the end client always sees the full amount) and it only matters when
-- a professional is assigned to the quote.
--
-- Existing rows backfill to 'commission' (the prior, only behavior).

alter table public.quotes
  add column if not exists decorator_billing text not null default 'commission';

-- Drop+add the CHECK idempotently so a re-run (or a tweak to the allowed
-- values) is clean.
alter table public.quotes
  drop constraint if exists quotes_decorator_billing_check;
alter table public.quotes
  add constraint quotes_decorator_billing_check
  check (decorator_billing in ('commission', 'trade_discount'));

notify pgrst, 'reload schema';
