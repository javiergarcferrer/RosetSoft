-- Track when the SELLER (vendedor) commission on a quote has been paid out.
--
-- Sibling of commission_paid_at (which tracks the outside PROFESSIONAL's
-- commission). A single sale can owe BOTH: the internal seller earns their
-- profile commission_pct once the deposit lands, and an assigned decorator/
-- architect earns theirs per commissionOwedAt. Accounting needs to settle
-- each independently, so each gets its own paid-at timestamp on the quote:
--
--   • seller_commission_paid_at       — null = pending, ts = paid (THIS column)
--   • commission_paid_at              — same, for the professional's cut
--
-- rowMapping converts seller_commission_paid_at <-> sellerCommissionPaidAt
-- (ISO timestamptz <-> JS ms) automatically, so no other wiring is needed.

alter table public.quotes
  add column if not exists seller_commission_paid_at timestamptz;

notify pgrst, 'reload schema';
