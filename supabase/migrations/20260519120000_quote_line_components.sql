-- Compound quote lines.
--
-- A "compound article" is a single product family that ships as several
-- referenced parts — e.g. a TOGO settee + loveseat + ottoman set, or a
-- modular Calin sectional split across left/right modules and a chaise.
-- The dealer wants to quote these as one visual block: one family chip,
-- one product photo, but several priced rows below — instead of seven
-- near-duplicate full-card line items.
--
-- Implementation: a `components` JSONB array on quote_lines. Each element
-- carries its own name / reference / subtype / dimensions / description /
-- qty / unit_price. When the array is non-empty, the line behaves as a
-- compound (the row-level qty / unit_price are ignored; the line subtotal
-- is the sum of component subtotals). Line-level discount still applies
-- to the whole compound.
--
-- Shape of one component:
--   { id, name, reference, subtype, dimensions, description, qty, unitPrice }
--
-- JSON instead of a side table because the components are tightly coupled
-- to their parent line — never queried independently, never reordered
-- across lines, never shared. One row per compound keeps writes atomic
-- and avoids extra joins in the totals computation.

ALTER TABLE quote_lines
  ADD COLUMN IF NOT EXISTS components jsonb NOT NULL DEFAULT '[]'::jsonb;
