-- Fabric swatch image on quote lines + compound components.
--
-- When the dealer picks a material + color from the SwatchPicker, the
-- color's (or material's) photo is the swatch the customer wants to
-- see on the quote — "this is the exact fabric/leather you're
-- getting". Until now the picker only wrote the fabric NAME into
-- subtype and threw the image away. This column records the chosen
-- swatch so it renders in the editor, the client preview, and the
-- exported PDF.
--
-- Distinct from quote_lines.image_id (the product photo — the sofa
-- itself). A line can carry both: the sofa shot AND the fabric swatch.
--
-- Per-component swatches live inline on the JSONB components array
-- (LineComponent.swatchImageId in src/types/domain.ts) — no column
-- needed there, same pattern as the component isOptional flag.

alter table public.quote_lines
  add column if not exists swatch_image_id text references public.images(id) on delete set null;

create index if not exists quote_lines_swatch_image_id_idx
  on public.quote_lines(swatch_image_id)
  where swatch_image_id is not null;

notify pgrst, 'reload schema';
