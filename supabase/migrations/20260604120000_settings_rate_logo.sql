-- Settings: logo of the exchange-rate source bank (Banco Popular Dominicano),
-- shown next to the converted DOP rate on the client share link and the PDF.
--
-- The dealer uploads the official bank logo once (an SVG or PNG) — same image
-- infra as the company logo (settings.logo_image_id). Null ⇒ no logo shown,
-- so existing settings rows behave identically. The row mapper auto-converts
-- rateLogoImageId <-> this snake column.

alter table public.settings
  add column if not exists rate_logo_image_id text;

notify pgrst, 'reload schema';
