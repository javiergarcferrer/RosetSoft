-- LifestyleGarden photos live on Shopify's CDN — never in our bucket.
--
-- images.external_url marks a row as a remote POINTER: the row carries the
-- CDN url and NO storage bytes (storage_path null). ImageView /
-- downloadImageBytes resolve it straight from the CDN, so every existing
-- surface that renders by images.id (editor, client link, PDF, store) keeps
-- working unchanged. The catalog pull writes one pointer per store photo with
-- id = lsgimg-<sha1 of url> — the SAME id scheme the old byte-mirror used, so
-- quote lines that snapshotted a mirrored id keep resolving once the pointer
-- pass overwrites that row (and the orphaned bytes are swept from storage).
alter table public.images add column if not exists external_url text;

-- products: the FULL Shopify gallery per variant row.
--   image_srcs      ordered CDN url list, cover first (jsonb array of text).
--   extra_image_ids pointer ids for image_srcs[1..] — image_id stays the
--                   cover pointer. A catalog insert copies image_id +
--                   extra_image_ids onto the quote line, so the client link
--                   shows the whole gallery with zero extra steps.
alter table public.products add column if not exists image_srcs jsonb;
alter table public.products add column if not exists extra_image_ids jsonb;

notify pgrst, 'reload schema';
