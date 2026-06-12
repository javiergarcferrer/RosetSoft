-- Manual Commerce-catalog override for the WhatsApp product picker.
-- wa-send auto-discovers the WABA's catalog from the token (product_catalogs
-- edge, the number's commerce settings, the token's own scopes, the business'
-- catalogs) — but Graph silently filters assets the token can't see, so when
-- the System User lacks the catalog asset the discovery comes up empty. This
-- column (Configuración → WhatsApp → "ID del catálogo") pins the catalog id
-- directly and skips discovery. Non-secret, so it lives on settings (team
-- readable), not in the write-only whatsapp_config.
alter table settings add column if not exists whatsapp_catalog_id text;

notify pgrst, 'reload schema';
