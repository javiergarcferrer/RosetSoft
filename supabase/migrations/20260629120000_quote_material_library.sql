-- Per-quote curated material library ("Paleta del proyecto"): the fabrics the
-- designer pins to a quote (including ones not yet applied to any line), shown
-- first in the material picker for fast, consistent application across a
-- compound's many components. Stored as a JSONB array of
-- { id, grade, fabric, swatchImageId } — the same shape the swatch picker emits.
alter table quotes add column if not exists material_library jsonb;

notify pgrst, 'reload schema';
