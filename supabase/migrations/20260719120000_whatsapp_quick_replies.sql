-- Quick replies (canned responses) for the WhatsApp composer.
-- A small team-shared library of reusable snippets the dealer inserts with one
-- tap instead of retyping greetings / stock-check / payment-info messages.
-- Each entry is { id, label, text }; the text may carry {{nombre}} / {{negocio}}
-- placeholders filled at insert time (core/crm fillQuickReply). Non-secret, so
-- it lives on settings (team-readable) as a jsonb array, NOT in the write-only
-- whatsapp_config — and rowMapping surfaces it as `whatsappQuickReplies`
-- end-to-end once this column exists.
alter table settings add column if not exists whatsapp_quick_replies jsonb not null default '[]'::jsonb;

notify pgrst, 'reload schema';
