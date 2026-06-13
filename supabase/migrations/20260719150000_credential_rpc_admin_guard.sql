-- Security hardening: the credential-writing RPCs become a real authorization
-- boundary, not a UI convention. Until now every save_* function granted
-- EXECUTE to `authenticated` with no role check, so a logged-in employee
-- (CRM-only) could overwrite the DGII signing cert, the Anthropic key, or the
-- Shopify / WhatsApp tokens straight from the JS console — despite the app
-- presenting these as admin-only Configuración. We re-CREATE each writer with a
-- role guard at the top of its body; the upsert logic is otherwise byte-for-
-- byte the same as the migration that introduced it.
--
-- Who may write each credential mirrors who can REACH its config surface today
-- (so no legitimate flow breaks):
--   • Shopify / WhatsApp / Claude — admin only (Settings + JARVIS are admin-
--     only screens). public.is_admin(auth.uid()).
--   • e-CF certificate            — admin OR accounting (Configuración contable
--     sits behind AccountingGate, which the accounting role passes).
--
-- auth.uid() resolves the caller from the request JWT even inside a SECURITY
-- DEFINER body (same mechanism the profiles privilege-escalation trigger relies
-- on); an anonymous call yields NULL → no admin row → blocked. errcode 42501
-- (insufficient_privilege) so the client surfaces it as a permission error.
--
-- Pinned alongside tests/credentialDurability.test.js: this file only REPLACES
-- the writers (the upserts live in dollar-quoted bodies the guard strips), it
-- never mutates a credential row at the top level.

-- ── e-CF certificate — admin OR accounting ────────────────────────────────
create or replace function public.save_ecf_credentials(
  p_p12 text, p_password text, p_environment text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles
     where id = auth.uid()::text and active = true and role in ('admin', 'accounting')
  ) then
    raise exception 'Solo Contabilidad o un administrador puede modificar el certificado e-CF.'
      using errcode = '42501';
  end if;
  insert into public.ecf_credentials (profile_id, p12_base64, password, environment, uploaded_at, updated_at)
  values ('team', p_p12, p_password, coalesce(nullif(p_environment, ''), 'cert'), now(), now())
  on conflict (profile_id) do update
    set p12_base64  = excluded.p12_base64,
        password    = excluded.password,
        environment = excluded.environment,
        updated_at  = now();
end;
$$;
revoke all on function public.save_ecf_credentials(text, text, text) from public;
grant execute on function public.save_ecf_credentials(text, text, text) to authenticated;

-- ── Shopify connection — admin only ───────────────────────────────────────
create or replace function public.save_shopify_config(
  p_domain        text,
  p_token         text default null,
  p_store         text default 'alcover',
  p_client_id     text default null,
  p_client_secret text default null
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
  if coalesce(p_token, '') = ''
     and (coalesce(p_client_id, '') = '' or coalesce(p_client_secret, '') = '') then
    raise exception 'provide an access token or a client id + secret';
  end if;
  insert into public.shopify_config (profile_id, store, domain, access_token, client_id, client_secret, updated_at)
  values ('team', p_store, p_domain, nullif(p_token, ''), nullif(p_client_id, ''), nullif(p_client_secret, ''), now())
  on conflict (profile_id, store) do update
    set domain        = excluded.domain,
        access_token  = excluded.access_token,
        client_id     = excluded.client_id,
        client_secret = excluded.client_secret,
        updated_at    = now();
end;
$$;
revoke all on function public.save_shopify_config(text, text, text, text, text) from public;
grant execute on function public.save_shopify_config(text, text, text, text, text) to authenticated;

-- ── WhatsApp connection — admin only ──────────────────────────────────────
create or replace function public.save_whatsapp_config(
  p_access_token text, p_phone_number_id text, p_waba_id text, p_app_secret text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Solo un administrador puede modificar la conexión de WhatsApp.'
      using errcode = '42501';
  end if;
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

-- ── Claude (Anthropic) key — admin only ───────────────────────────────────
create or replace function public.save_claude_config(p_api_key text, p_model text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Solo un administrador puede modificar la conexión de Claude.'
      using errcode = '42501';
  end if;
  if coalesce(p_api_key, '') !~ '^sk-ant-' then
    -- Catches password-manager autofill garbage before it bricks the channel.
    raise exception 'La llave debe ser una API key de Anthropic (empieza con sk-ant-).';
  end if;
  insert into public.claude_config (profile_id, api_key, model, updated_at)
  values ('team', p_api_key, coalesce(nullif(p_model, ''), 'claude-opus-4-8'), now())
  on conflict (profile_id) do update
    set api_key = excluded.api_key, model = excluded.model, updated_at = now();
  update public.settings
    set claude_connected_at = now(),
        claude_model = coalesce(nullif(p_model, ''), 'claude-opus-4-8')
    where profile_id = 'team';
end;
$$;
revoke all on function public.save_claude_config(text, text) from public;
grant execute on function public.save_claude_config(text, text) to authenticated;

notify pgrst, 'reload schema';
