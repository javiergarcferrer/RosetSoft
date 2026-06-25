-- professionals.trade_number — the Ligne Roset trade-account number LR issues to
-- a professional (architect / decorator). Printed on the order-registration
-- document so Ligne Roset books each quote's order to the right trade account.
-- Additive + idempotent; existing rows default to '' and a seller fills it in.
alter table public.professionals add column if not exists trade_number text not null default '';

notify pgrst, 'reload schema';
