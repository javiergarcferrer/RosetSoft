-- Catalog "Description 2" (the model's finish/variant, e.g. "STANDARD
-- HEADBOARD") as its OWN field on a quote line, separate from the dealer-
-- authored `description` (the editable, PDF-facing "Descripción").
--
-- These were conflated onto `description`, so the catalog text pre-filled the
-- dealer's field — the dealer opened "Descripción" and found the catalog
-- descriptor already in it. Splitting them frees `description` for the dealer
-- (now also available on compound/modular lines) while the catalog descriptor
-- keeps showing as the line's read-only secondary identifier on every surface.
--
-- Additive + idempotent. Existing rows keep their current `description` as-is
-- (no backfill: we can't tell dealer-typed text from the auto-filled catalog
-- text on historical lines, so we leave them and only split on new inserts).
alter table quote_lines
  add column if not exists product_description text;

notify pgrst, 'reload schema';
