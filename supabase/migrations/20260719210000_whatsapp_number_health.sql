-- Number health mirrors: the WhatsApp number's quality rating (GREEN/YELLOW/
-- RED) and current messaging limit tier. Written by wa-send's connection test
-- and refreshed by wa-webhook on the phone_number_quality_update event, so the
-- dealer sees a degraded number (which throttles or blocks campaigns) before
-- sends fail. Non-secret display mirrors on settings (the rating itself lives
-- at Meta).
alter table settings add column if not exists whatsapp_quality_rating text;
alter table settings add column if not exists whatsapp_messaging_limit text;

notify pgrst, 'reload schema';
