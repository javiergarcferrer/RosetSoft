-- Brand-catalog product images.
--
-- LSG products carry a photo from the Shopify store: `image_src` is the
-- store's CDN URL (set by every importCatalog run), and `image_id` points at
-- the copy the import MIRRORS into our own images bucket (so quote lines can
-- snapshot it and the client link / PDF render it through the existing
-- imageId pipeline, with no new render paths). Ligne Roset rows keep both
-- empty — the price-list CSV has no photos.

alter table public.products
  add column if not exists image_id  text references public.images(id) on delete set null,
  add column if not exists image_src text not null default '';

notify pgrst, 'reload schema';
