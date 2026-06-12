-- Drop the vestigial per-professional default commission.
--
-- Domain context
-- --------------
-- `professionals.default_commission_pct` was introduced (migration
-- 20260517140000) as a per-professional "default" that pre-filled a quote's
-- commission. That model is gone: the commission rate is set entirely by the
-- quote's ORDER TYPE — floor ("venta de piso") pays 15%, special order pays
-- 20% (see src/lib/commissions.ts: baseCommissionPct). No code reads this
-- column to compute, owe, or report a commission; it survived only as a
-- non-binding "reference" note in the Professionals UI.
--
-- Why drop instead of soft-deprecate
-- ----------------------------------
-- The column is decorative — no other table joins on it, no PDF semantics
-- depend on it, no business logic reads it. Dropping it cleanly is safer than
-- leaving an unused column that the next person might re-wire and reintroduce
-- drift (the same rationale that retired quotes.name in 20260517140000). The
-- inline CHECK constraint drops with the column. Existing values are lost,
-- which the user has explicitly OK'd (they want the field gone).
--
-- Idempotent: `drop column if exists` is a no-op on a re-run / a DB where the
-- column was never created.

alter table public.professionals
  drop column if exists default_commission_pct;

notify pgrst, 'reload schema';
