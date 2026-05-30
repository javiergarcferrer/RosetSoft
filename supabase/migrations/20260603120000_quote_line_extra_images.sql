-- Quote lines: ADDITIONAL product photos beyond the single cover `image_id`.
--
-- A line already carries one product photo (image_id). Dealers quoting
-- furniture want to attach several angles / detail shots so the client sees the
-- piece properly on the interactive share link. We keep image_id as the cover
-- (every surface that shows ONE image keeps using it, unchanged) and add an
-- ordered list of extra image ids; the gallery a customer sees is
-- [image_id, ...extra_image_ids].
--
-- jsonb array of image ids — same shape/handling as quote_lines.components and
-- the colors arrays elsewhere. Null on every existing row ⇒ no extras, behaves
-- identically. The row mapper (db/rowMapping) auto-converts extraImageIds <->
-- this snake column, so no other DB wiring is needed.

alter table public.quote_lines
  add column if not exists extra_image_ids jsonb;

notify pgrst, 'reload schema';
