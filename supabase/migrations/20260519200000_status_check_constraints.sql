-- Pin the legal `status` vocabulary at the database layer.
--
-- Until now the only enforcement of "draft / sent / accepted /
-- declined / archived" (for quotes) and the six-stage order
-- lifecycle was the application — a direct SQL write, an RPC, or a
-- buggy code path that miscamelCased a string could plant any text.
-- The reports (admin/Commissions, accounting/CommissionsToPay, etc.)
-- filter on these values; a "Accepted" with a stray capital, or a
-- typo'd "acepted", would silently disappear from every dealer
-- report.
--
-- CHECK constraints make Postgres the enforcement boundary. The
-- migration is idempotent (drops + recreates with the same name) so
-- it's safe to re-run.

-- Quotes ---------------------------------------------------------------
ALTER TABLE public.quotes
  DROP CONSTRAINT IF EXISTS quotes_status_check;

ALTER TABLE public.quotes
  ADD CONSTRAINT quotes_status_check
  CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'archived'));

-- Orders ---------------------------------------------------------------
-- Vocabulary matches src/lib/orderStages.js (ORDER_STAGES +
-- ORDER_TERMINAL_STAGES). Keep this in sync if a new stage is added
-- there — a new application-level stage that the DB rejects would
-- crash the stepper on every advance.
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'draft',
    'placed',
    'confirmed',
    'in_transit',
    'in_customs',
    'received',
    'cancelled'
  ));

NOTIFY pgrst, 'reload schema';
