-- Track when an outside professional's commission on a quote has been
-- PAID OUT, so Contabilidad can follow up on what's still owed.
--
-- Domain context
-- --------------
-- A quote with a professional assigned that uses the 'commission'
-- settlement modality owes that professional a commission once the deal
-- is collected. The dealer's rule for WHEN it's owed:
--
--   • Quote tied to an ORDER (order_id set): owed once the BALANCE is paid
--     (balance_paid_at) — on a special order the deposit alone isn't enough.
--   • Standalone quote (no order = "venta de piso"): owed once the DEPOSIT
--     is received (deposit_received_at).
--
-- Until now the accounting workspace could only DERIVE who was owed what;
-- there was nowhere to record that a payout had actually happened. This
-- single nullable timestamp closes that gap:
--
--   • null        — commission still pending.
--   • a timestamp — paid out on that date.
--
-- Per-quote, mirroring the existing deposit_received_at / balance_paid_at
-- milestones. rowMapping converts commission_paid_at <-> commissionPaidAt
-- (ISO timestamptz <-> JS ms) automatically, so no other wiring is needed.
-- 'trade_discount' quotes never owe a commission, so this stays null for
-- them.

alter table public.quotes
  add column if not exists commission_paid_at timestamptz;

notify pgrst, 'reload schema';
