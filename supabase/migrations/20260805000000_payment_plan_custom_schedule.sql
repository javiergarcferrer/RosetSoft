-- Payment plans: support a CUSTOM staged schedule (e.g. 50/20/20/10) alongside
-- the amortized "50% down + interest cuotas" mode.
--
--   schedule_mode = 'amortized' (default; the original financed mode) |
--                   'custom'    (each installment a % of the total, interest-free,
--                                its own due date + concept label).
-- The per-stage pct/label/paymentId ride inside the existing `schedule` jsonb,
-- so no other column is needed.

alter table public.payment_plans
  add column if not exists schedule_mode text not null default 'amortized'
    check (schedule_mode in ('amortized', 'custom'));

notify pgrst, 'reload schema';
