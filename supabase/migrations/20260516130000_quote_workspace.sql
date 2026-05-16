-- Quote Workspace refactor.
--
-- 1. Quote lines gain a `kind` discriminator so section dividers can live in
--    the same table as regular items. Sections render as labelled group
--    headings in the workspace and in the PDF — no new table needed, the
--    existing sort_order keeps them in the right place.
--
--      kind = 'item'    (default)  regular line item (everything we have today)
--      kind = 'section'            divider row; the `name` column holds the label
--
-- 2. Quotes gain explicit transition timestamps so the new status lifecycle
--    stepper can show when each transition happened. Mirrors the pattern that
--    containers already use (submittedAt/orderedAt/etc.).

-- ---------------------------------------------------------------------------
-- 1. Section discriminator on quote_lines
-- ---------------------------------------------------------------------------
ALTER TABLE quote_lines
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'item';

-- Index so the workspace can render sections separately at query time if it
-- ever wants to; sort_order remains the primary ordering field.
CREATE INDEX IF NOT EXISTS quote_lines_kind_idx ON quote_lines(kind);

-- ---------------------------------------------------------------------------
-- 2. Status lifecycle timestamps on quotes
-- ---------------------------------------------------------------------------
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS sent_at      timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_at  timestamptz,
  ADD COLUMN IF NOT EXISTS declined_at  timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at  timestamptz;
