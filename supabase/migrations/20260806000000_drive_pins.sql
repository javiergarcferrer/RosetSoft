-- Pinned Google Drive folders — team-shared quick-access shortcuts.
--
-- The "Mi Drive" workspace (a standalone Drive browser) lets the team pin any
-- Drive folder so it's one click away. Pins are non-sensitive (just folder
-- id/name/url the connected account can already see), team-shared like the rest
-- of the settings row, so they live as a JSONB array on settings rather than a
-- separate table. Each entry is { id, name, url }.
alter table public.settings
  add column if not exists google_drive_pins jsonb not null default '[]'::jsonb;

notify pgrst, 'reload schema';
