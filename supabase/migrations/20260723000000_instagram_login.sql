-- Instagram-only, via "Instagram API with Instagram login".
--
-- The dealer connects their Instagram professional account DIRECTLY through
-- Instagram Business Login (no Facebook Page, no pages_* permissions). The
-- long-lived IG user token + the Instagram app credentials live in the
-- existing write-only meta_social_config table (service role only, no client
-- policies). These columns are ADDITIVE: the old Facebook/Page/Ads columns
-- stay (now unused) so no pasted credential is ever erased.

alter table public.meta_social_config
  add column if not exists ig_app_id            text not null default '',  -- Instagram app id (client_id)
  add column if not exists ig_app_secret        text not null default '',  -- Instagram app secret (write-only)
  add column if not exists ig_access_token      text not null default '',  -- long-lived IG user token (60d)
  add column if not exists ig_token_expires_at  timestamptz,               -- when ig_access_token lapses
  add column if not exists oauth_state          text not null default '',  -- one-shot CSRF state for the OAuth round-trip
  add column if not exists oauth_return_to      text not null default '';  -- app URL to bounce back to after consent

-- The legacy long-lived user/system-user token is no longer required (the IG
-- user token now lives in ig_access_token). Relax the column so an
-- Instagram-login row can be written without one.
alter table public.meta_social_config alter column access_token drop not null;
alter table public.meta_social_config alter column access_token set default '';

-- Non-sensitive mirror for the Settings UI: the App ID is not a secret (the
-- secret stays write-only in meta_social_config). Lets the card show that the
-- credentials are configured and pre-fill the field.
alter table public.settings
  add column if not exists meta_social_ig_app_id text default '';

notify pgrst, 'reload schema';
