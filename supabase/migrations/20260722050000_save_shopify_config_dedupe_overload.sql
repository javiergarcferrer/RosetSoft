-- Collapse the save_shopify_config overload set back to exactly ONE function.
--
-- Symptom (PostgREST PGRST203):
--   "Could not choose the best candidate function between:
--      save_shopify_config(p_domain, p_store, p_client_id, p_client_secret)
--      save_shopify_config(p_domain, p_token, p_store, p_client_id, p_client_secret)"
--   → Saving the Shopify connection in Configuración fails outright.
--
-- How prod ended up with two overloads:
--   • 20260705140000 made the canonical writer the 4-arg, NO-DEFAULT shape
--     (p_domain, p_store, p_client_id, p_client_secret) and dropped the old
--     token-bearing signature.
--   • 20260705150000 added a deliberately NO-DEFAULT 5-arg compat shim
--     (…, p_token, …) so version-skewed tabs still resolved unambiguously
--     (its comment spells out: "No parameter defaults ON PURPOSE — a default
--     would make the new 4-named-arg call ambiguous (PGRST203)").
--   • 20260719150000 (the credential-RPC admin-guard sweep) then re-created
--     save_shopify_config from the PRE-cutover template — the 5-arg shape WITH
--     defaults (p_token DEFAULT null, p_store DEFAULT 'alcover', …). That
--     re-introduced exactly the defaults the shim had avoided.
--
-- Result: the app calls the RPC with {p_domain, p_store, p_client_id,
-- p_client_secret}. That now matches the 4-arg overload outright AND the 5-arg
-- one via p_token's default → PostgREST can't choose → PGRST203.
--
-- Second, quieter defect from the same sweep: its is_admin() guard landed only
-- on the 5-arg overload; the canonical 4-arg writer (20260705140000) was left
-- UNGUARDED. So simply dropping the 5-arg shape would also delete the only
-- guarded copy. Fix both at once: drop the dead 5-arg overload (the static
-- token path is gone — Dev Dashboard client-credentials only, so nothing sends
-- p_token anymore) and fold the admin guard onto the surviving 4-arg writer.

drop function if exists public.save_shopify_config(text, text, text, text, text);

create or replace function public.save_shopify_config(
  p_domain        text,
  p_store         text,
  p_client_id     text,
  p_client_secret text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Solo un administrador puede modificar la conexión de Shopify.'
      using errcode = '42501';
  end if;
  if p_store not in ('alcover', 'lifestylegarden') then
    raise exception 'unknown shopify store: %', p_store;
  end if;
  if coalesce(p_client_id, '') = '' or coalesce(p_client_secret, '') = '' then
    raise exception 'client id and client secret are required';
  end if;
  insert into public.shopify_config (profile_id, store, domain, client_id, client_secret, access_token, token_expires_at, updated_at)
  values ('team', p_store, p_domain, p_client_id, p_client_secret, null, null, now())
  on conflict (profile_id, store) do update
    set domain           = excluded.domain,
        client_id        = excluded.client_id,
        client_secret    = excluded.client_secret,
        access_token     = null,
        token_expires_at = null,
        updated_at       = now();
end;
$$;
revoke all on function public.save_shopify_config(text, text, text, text) from public;
grant execute on function public.save_shopify_config(text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
