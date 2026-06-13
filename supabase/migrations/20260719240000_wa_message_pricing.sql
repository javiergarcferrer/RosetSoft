-- Per-message pricing capture (WhatsApp's 2025+ per-message billing model).
-- Meta stamps a `pricing` object on every delivery-status webhook: the billing
-- category (marketing/utility/authentication/service) and whether the message
-- was billable. wa-webhook records it on the outbound row so messaging cost is
-- reportable (count billable sends by category; the dealer applies their own
-- per-country rate, which Meta revises monthly).
alter table wa_messages add column if not exists pricing_category text;
alter table wa_messages add column if not exists pricing_billable boolean;

notify pgrst, 'reload schema';
