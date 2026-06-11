-- The LifestyleGarden storefront (www.lifestylegarden.do) answers at
-- alcoversrl.myshopify.com — verified via the storefront's own /admin
-- redirect (301 → https://alcoversrl.myshopify.com/admin), which is the
-- canonical myshopify host for a Shopify custom domain.
--
-- The previous repoint (20260704130000_fix_shopify_domain, applied today
-- after the version-collision unjam) aimed the saved connection at
-- fg9gaq-3c.myshopify.com instead, so the Admin API 401s every call ("token
-- inválido o sin permisos para fg9gaq-3c.myshopify.com"). Point the config
-- (and the non-sensitive mirror on settings) at the real domain. Scoped to
-- the known-bad values so a later manual correction is never clobbered.

update public.shopify_config
   set domain = 'alcoversrl.myshopify.com', updated_at = now()
 where profile_id = 'team'
   and domain in ('fg9gaq-3c.myshopify.com', 'alcoversdq.myshopify.com');

update public.settings
   set shopify_domain = 'alcoversrl.myshopify.com'
 where profile_id = 'team'
   and shopify_domain in ('fg9gaq-3c.myshopify.com', 'alcoversdq.myshopify.com');

notify pgrst, 'reload schema';
