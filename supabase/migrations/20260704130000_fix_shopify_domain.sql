-- (Renamed from 20260703120000 — that version collided with ecf_txn_rpcs.sql,
-- and a duplicate version jams the whole pending migration chain. Re-running
-- is safe: both updates are scoped to the known-bad value.)
--
-- One-time data fix: the Shopify connection was saved with the store's old /
-- misremembered domain (alcoversdq.myshopify.com). The real store (ALCOVER)
-- answers at fg9gaq-3c.myshopify.com — verified live against the connected
-- Shopify account — so the Admin API rejected every call as "invalid token"
-- even though the token itself is fine. Point the saved config (and the
-- non-sensitive mirror on settings) at the canonical domain. Scoped to the
-- known-bad value so a later manual correction is never clobbered.

update public.shopify_config
   set domain = 'fg9gaq-3c.myshopify.com', updated_at = now()
 where profile_id = 'team' and domain = 'alcoversdq.myshopify.com';

update public.settings
   set shopify_domain = 'fg9gaq-3c.myshopify.com'
 where profile_id = 'team' and shopify_domain = 'alcoversdq.myshopify.com';

notify pgrst, 'reload schema';
