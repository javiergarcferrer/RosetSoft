-- Persist the USD→DOP rate used on an import expediente.
--
-- FOB is captured + stored in DOP (the customs-valuation currency the DGA tax
-- cascade runs in), but the commercial invoice is in USD. Storing the rate lets
-- the detail view show each line's FOB back in dollars exactly (DOP ÷ rate),
-- instead of approximating with the current rate. Additive; existing rows fall
-- back to the live rate for display.

alter table public.import_expedientes
  add column if not exists rate numeric;

notify pgrst, 'reload schema';
