-- Multi-currency cobros/pagos + the DR collection channels (Verifone / Banco
-- Popular payment link).
--
-- The ledger stays DOP: `amount` remains the booked DOP figure (unchanged
-- meaning), so every posting / aging / statement / dashboard KPI keeps working
-- untouched. We record what was actually RECEIVED as an audit trail:
--   • currency  — the divisa physically received ('USD' | 'DOP')
--   • fx_amount — the amount in that currency (e.g. the USD collected)
--   • rate      — the USD→DOP rate applied to book it (Banco Popular venta)
--
--   DOP cobro:  currency='DOP', fx_amount=amount,         rate=1
--   USD cobro:  currency='USD', fx_amount=<usd recibido>, rate=<venta BPD>,
--               amount = round2(fx_amount * rate)   (what posts to the asiento)

alter table public.payments
  add column if not exists currency  text    not null default 'DOP',
  add column if not exists rate      numeric,
  add column if not exists fx_amount numeric;

alter table public.payments drop constraint if exists payments_currency_check;
alter table public.payments
  add constraint payments_currency_check check (currency in ('USD','DOP'));

-- Widen the method CHECK to the channels the dealer actually collects on:
-- Verifone (POS terminal) + the Banco Popular payment link. Both are card-type
-- gateways, so the existing commission / retained-ITBIS / retained-ISR columns
-- apply to them just as they did to the generic 'card'. Legacy values kept.
alter table public.payments drop constraint if exists payments_method_check;
alter table public.payments
  add constraint payments_method_check
  check (method in ('cash','bank','transfer','card','verifone','payment_link'));

notify pgrst, 'reload schema';
