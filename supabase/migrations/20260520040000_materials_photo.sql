-- Material photos.
--
-- The materials catalog gains an optional image_id column that
-- references the existing images table. This lets the dealer attach a
-- representative swatch photo to each fabric/leather/outdoor entry —
-- visible in the SwatchPicker modal so the customer sees what they're
-- choosing instead of a name + grade letter on a blank tile.
--
-- Per-color photos are NOT a separate column; the existing JSONB
-- colors array on materials carries them inline. Schema:
--
--   colors jsonb:  [{ name, code, imageId? }, ...]
--
-- (No DB constraint enforces the imageId shape — the application
-- types it via the MaterialColor interface in src/types/domain.ts.)
--
-- Storage: the existing /storage/v1/images bucket holds the bytes;
-- the image_id column carries the corresponding images.id. saveImage()
-- in db/database.ts already handles MIME / size validation at the
-- boundary, and deleteImage() removes the storage object + the DB row
-- together — so adding/removing a swatch via the materials editor
-- inherits the same lifecycle as every other image in the app.

alter table public.materials
  add column if not exists image_id text references public.images(id) on delete set null;

create index if not exists materials_image_id_idx
  on public.materials(image_id)
  where image_id is not null;

notify pgrst, 'reload schema';
