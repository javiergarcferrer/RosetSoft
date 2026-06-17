-- Google integration (Gmail + Google Drive) — one Google account, one OAuth.
--
-- The dealer connects a single Google Workspace/Gmail account via Google's
-- OAuth 2.0 consent (offline access → a refresh token). That one grant covers
-- BOTH surfaces: Gmail (send quotes / files / mailing-list mail) and Drive
-- (create a folder per importation, upload + list documents). The OAuth client
-- credentials + the long-lived refresh token live in a WRITE-ONLY store
-- (service role only, no client policies) — exactly like meta_social_config /
-- whatsapp_config. The access token is a short-lived (~1h) server-owned cache
-- the google-api Edge Function refreshes from the refresh token; nothing here
-- ever reaches the browser.

create table if not exists public.google_oauth_config (
  profile_id        text primary key default 'team',
  client_id         text not null default '',   -- OAuth 2.0 client id (non-secret)
  client_secret     text not null default '',   -- OAuth 2.0 client secret (write-only)
  access_token      text not null default '',    -- server-owned ~1h access token cache
  refresh_token     text not null default '',    -- long-lived offline-access token
  token_expires_at  timestamptz,                 -- when access_token lapses
  scopes            text not null default '',    -- space-separated granted scopes
  oauth_state       text not null default '',    -- one-shot CSRF state for the round-trip
  oauth_return_to   text not null default '',    -- app URL to bounce back to after consent
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- WRITE-ONLY: enable RLS but grant NO client policies. Only the service role
-- (the google-api Edge Function) can read/write the credential row, so the
-- refresh token never reaches an authenticated browser session.
alter table public.google_oauth_config enable row level security;

-- Non-sensitive mirrors for the Settings UI (the settings row IS client-read).
-- The client id is not a secret; connected_at/email let the cards show status;
-- drive_root_folder_id is the parent folder we file per-importation subfolders
-- under (the "RosetSoft" workspace folder, created on first use).
alter table public.settings
  add column if not exists google_connected_at        timestamptz,
  add column if not exists google_email               text default '',
  add column if not exists google_client_id           text default '',
  add column if not exists google_drive_root_folder_id text default '';

-- A Drive folder id per importation (expediente). Created on first save by the
-- google-api Edge Function; documents for that container land inside it.
alter table public.import_expedientes
  add column if not exists drive_folder_id  text default '',
  add column if not exists drive_folder_url text default '';

notify pgrst, 'reload schema';
