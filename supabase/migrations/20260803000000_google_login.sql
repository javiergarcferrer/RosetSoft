-- "Sign in with Google" — domain-gated OAuth login that REUSES the existing
-- Google OAuth client (the same client_id/secret google_oauth_config already
-- holds for Gmail + Drive). No new credential store: the login flow only READS
-- those creds to drive the consent round-trip; it never writes tokens there.
--
-- The single new piece of config is which email domain may sign in this way.
-- An empty value means "fall back to the connected Google account's domain"
-- (settings.google_email) — so a freshly-connected org needs zero extra setup
-- (e.g. a workspace connected as someone@alcover.do allows @alcover.do logins).
alter table public.settings
  add column if not exists google_login_domain text default '';

notify pgrst, 'reload schema';
