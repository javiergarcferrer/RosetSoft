-- Quote-template metadata for WhatsApp sends. The Settings card now PICKS the
-- approved template (instead of free-typing its name), and stores alongside it
-- what sendQuoteLink needs to build the right send: the template's language,
-- how many body variables it has, and whether the public link rides a URL
-- BUTTON's {{1}} suffix instead of a body variable.
alter table settings add column if not exists whatsapp_quote_template_lang text;
alter table settings add column if not exists whatsapp_quote_template_button boolean;
alter table settings add column if not exists whatsapp_quote_template_vars integer;

notify pgrst, 'reload schema';
