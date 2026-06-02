-- Friends & Family courtesy discount on a quote.
--
-- A SECOND, independent quote-level discount that the DEALER absorbs — unlike
-- `discount_pct`, which is funded by the assigned professional's commission
-- (see lib/commissions:commissionBreakdown). The courtesy discount lowers the
-- client's price and the dealer's net, but never touches the designer's payout.
-- Applied AFTER `discount_pct`, before ITBIS (see lib/pricing:computeTotals).
alter table quotes
  add column if not exists courtesy_discount_pct numeric not null default 0;

-- Keep it in the same legal range the app clamps to (0–100%).
alter table quotes drop constraint if exists quotes_courtesy_discount_pct_range;
alter table quotes
  add constraint quotes_courtesy_discount_pct_range
  check (courtesy_discount_pct >= 0 and courtesy_discount_pct <= 100);

notify pgrst, 'reload schema';
