-- Drop the dead orders.deposit_amount column.
--
-- It only ever held 0 (written on order creation, never read) — a leftover from
-- before the deposit flow moved entirely into accounting. The deposit is now a
-- SIGNAL on the quote (deposit_received_at) plus a cobro in the books
-- (payments.quote_id); no order-level amount has any reader. Safe to remove.
alter table public.orders drop column if exists deposit_amount;

notify pgrst, 'reload schema';
