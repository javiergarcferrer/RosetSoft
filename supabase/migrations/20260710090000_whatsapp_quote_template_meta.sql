-- CHAIN-REPAIR PLACEHOLDER — do not delete or rename.
--
-- This migration was applied to prod under THIS version (20260710090000) and
-- then renamed in-repo to 20260714120000 by a parallel session. The migration
-- runner aborts the WHOLE pending chain when a version recorded in
-- supabase_migrations.schema_migrations has no matching local file — which
-- silently froze every migration after 20260713130000. Restoring the filename
-- unjams the chain; the renamed twin re-applies the same idempotent DDL,
-- which is a no-op.
alter table settings add column if not exists whatsapp_quote_template_lang text;
alter table settings add column if not exists whatsapp_quote_template_button boolean;
alter table settings add column if not exists whatsapp_quote_template_vars integer;

notify pgrst, 'reload schema';
