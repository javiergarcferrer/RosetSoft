-- Version-skew shim for save_shopify_config.
--
-- A browser tab loaded BEFORE the Dev-Dashboard-only deploy still calls the
-- RPC with a p_token argument (sent as null alongside the client credentials).
-- That signature was dropped, so those tabs got "Could not find the function
-- … in the schema cache" — gibberish to the dealer. PostgREST resolves
-- overloads by the exact named-argument set, so the old shape gets its own
-- thin signature that delegates to the real writer and ignores p_token.
--
-- No parameter defaults ON PURPOSE: a default would make the new 4-named-arg
-- call ambiguous between the two overloads (PGRST203).
--
-- Transitional: safe to drop once no pre-2026-06-11 bundles can be live.

create or replace function public.save_shopify_config(
  p_domain        text,
  p_token         text,
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
  if coalesce(p_client_id, '') = '' or coalesce(p_client_secret, '') = '' then
    -- Old bundle in legacy-token mode: there are no credentials to save.
    raise exception 'La app se actualizó: recarga la página y conecta con el Client ID + Client secret de la app del Dev Dashboard.';
  end if;
  perform public.save_shopify_config(p_domain, p_store, p_client_id, p_client_secret);
end;
$$;
revoke all on function public.save_shopify_config(text, text, text, text, text) from public;
grant execute on function public.save_shopify_config(text, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
