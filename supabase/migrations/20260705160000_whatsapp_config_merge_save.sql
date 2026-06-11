-- save_whatsapp_config: merge, never blank.
--
-- The original writer overwrote the whole row, so re-pasting ONE value (say a
-- fresh access token after the temporary one expired) silently blanked the
-- others the form left empty — the "my credentials keep getting erased"
-- complaint. Now an empty parameter means KEEP the saved value; only the
-- first-ever save requires the token + phone-number id. Pasting a single
-- field updates just that field.
--
-- (Pinned alongside tests/credentialDurability.test.js, which bans migrations
-- from mutating credential rows — this file only replaces the writer.)

create or replace function public.save_whatsapp_config(
  p_access_token text, p_phone_number_id text, p_waba_id text, p_app_secret text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.whatsapp_config where profile_id = 'team') then
    if coalesce(p_access_token, '') = '' or coalesce(p_phone_number_id, '') = '' then
      raise exception 'para conectar por primera vez se necesitan el token de acceso y el Phone Number ID';
    end if;
    insert into public.whatsapp_config (profile_id, access_token, phone_number_id, waba_id, app_secret, updated_at)
    values ('team', p_access_token, p_phone_number_id, coalesce(p_waba_id, ''), coalesce(p_app_secret, ''), now());
  else
    update public.whatsapp_config
       set access_token    = coalesce(nullif(p_access_token, ''),    access_token),
           phone_number_id = coalesce(nullif(p_phone_number_id, ''), phone_number_id),
           waba_id         = coalesce(nullif(p_waba_id, ''),         waba_id),
           app_secret      = coalesce(nullif(p_app_secret, ''),      app_secret),
           updated_at      = now()
     where profile_id = 'team';
  end if;
end;
$$;
revoke all on function public.save_whatsapp_config(text, text, text, text) from public;
grant execute on function public.save_whatsapp_config(text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
