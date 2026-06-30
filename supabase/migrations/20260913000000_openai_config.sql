-- OpenAI config — the image-generation uplink: an Edge Function calls the
-- OpenAI API (DALL·E 3 for image generation, gpt-4o for vision over dropped
-- inspiration references) so the dealer can generate ads/artwork.
-- The API key is a secret: WRITE-ONLY table (no client SELECT). Only the
-- service-role reader (the Edge Function) ever touches the key. Mirrors the
-- claude_config / shopify_config / meta_social_config pattern — no dashboard
-- secret, no manual step. Non-sensitive status mirrors onto settings.

create table if not exists public.openai_config (
  profile_id    text primary key references public.profiles(id) on delete cascade,
  api_key       text,
  image_model   text default 'dall-e-3',
  vision_model  text default 'gpt-4o',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
alter table public.openai_config enable row level security;
-- Intentionally NO client policies: only the service-role reader (the Edge
-- Function) ever touches the key.

-- Non-sensitive connection status for the image-generation UI.
alter table public.settings
  add column if not exists openai_connected_at timestamptz;

notify pgrst, 'reload schema';
