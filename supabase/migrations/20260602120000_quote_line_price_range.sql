-- Quote lines: a PRICE RANGE for a piece quoted WITHOUT a chosen material.
--
-- When the dealer adds a model but defers the fabric to the designer, the line
-- can't carry a single price — the model is offered across fabric grades at
-- different prices. We snapshot the cheapest and priciest grade prices onto the
-- line (price_min / price_max), exactly as `unit_price` is already snapshotted,
-- so every downstream surface — the totals, the client preview, the PDF, and
-- the public share link (which has NO catalog at all) — can render the range
-- and widen the grand total purely from the line, with no live catalog lookup.
--
--   price_min / price_max  both set ⇒ the line shows "min – max" and the quote
--                          total becomes a range (Σ low … Σ high). Picking a
--                          material clears them and pins unit_price to the
--                          chosen grade's price. Null on a normal line.
--
-- Pure additive columns (null on every existing row ⇒ existing quotes behave
-- identically — lib/pricing:isRangeLine treats null as "no range"). The row
-- mapper (db/rowMapping) auto-converts priceMin/priceMax <-> the snake columns,
-- so no other DB wiring is needed.

alter table public.quote_lines
  add column if not exists price_min numeric,
  add column if not exists price_max numeric;

notify pgrst, 'reload schema';
