-- Freeze the commission $ actually paid out, so a later order_type toggle, a
-- change to FLOOR/SPECIAL_COMMISSION_PCT, or an edit to a seller's profile
-- commission_pct can't retroactively restate what a professional / seller was
-- already paid. NULL = not paid yet → the UI recomputes the amount live; a
-- value = the frozen snapshot taken at payout time (paired with the existing
-- commission_paid_at / seller_commission_paid_at timestamps).
alter table quotes
  add column if not exists commission_paid_amount        numeric,
  add column if not exists seller_commission_paid_amount  numeric;

notify pgrst, 'reload schema';
