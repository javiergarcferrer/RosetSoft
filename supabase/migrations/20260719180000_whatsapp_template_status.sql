-- Latest known status/quality per WhatsApp message template, keyed by template
-- name. Written by wa-webhook from Meta's message_template_status_update and
-- message_template_quality_update events (a template Meta APPROVED can later be
-- PAUSED/DISABLED for complaints — silently breaking quote sends). Surfaced in
-- Configuración → WhatsApp so the dealer is warned proactively. Non-secret, so
-- it lives on settings (team-readable) as a jsonb map:
--   { "<template_name>": { "status": "PAUSED", "quality": "RED",
--                          "reason": "…", "at": 1718…ms } }
alter table settings add column if not exists whatsapp_template_status jsonb not null default '{}'::jsonb;

notify pgrst, 'reload schema';
