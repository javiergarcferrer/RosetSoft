-- WhatsApp Business (Cloud API) integration — credentials + message log.
--
-- Credentials follow the shopify_config pattern: a WRITE-ONLY table (no client
-- SELECT), written through a SECURITY DEFINER RPC, read only by the `wa-send` /
-- `wa-webhook` Edge Functions via the service role. Non-sensitive status
-- (connected_at, display number, verify token — a shared webhook handshake
-- string, not a secret) lives on `settings` for the UI.

create table if not exists public.whatsapp_config (
  profile_id      text primary key default 'team' references public.profiles(id) on delete cascade,
  access_token    text not null,
  phone_number_id text not null,
  waba_id         text not null default '',
  app_secret      text not null default '',
  updated_at      timestamptz not null default now()
);
alter table public.whatsapp_config enable row level security;
-- Intentionally NO client policies: only the SECURITY DEFINER writer below and
-- the service-role readers (the Edge Functions) ever touch the token.

create or replace function public.save_whatsapp_config(
  p_access_token text, p_phone_number_id text, p_waba_id text, p_app_secret text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.whatsapp_config (profile_id, access_token, phone_number_id, waba_id, app_secret, updated_at)
  values ('team', p_access_token, p_phone_number_id, p_waba_id, p_app_secret, now())
  on conflict (profile_id) do update
    set access_token    = excluded.access_token,
        phone_number_id = excluded.phone_number_id,
        waba_id         = excluded.waba_id,
        -- Keep the previously saved secret when the form re-submits without it
        -- (the input is write-only in the UI, so an edit of just the token
        -- must not blank the webhook signature check).
        app_secret      = case when excluded.app_secret = '' then whatsapp_config.app_secret else excluded.app_secret end,
        updated_at      = now();
end;
$$;
revoke all on function public.save_whatsapp_config(text, text, text, text) from public;
grant execute on function public.save_whatsapp_config(text, text, text, text) to authenticated;

-- Non-sensitive connection status for the Settings UI.
alter table public.settings
  add column if not exists whatsapp_connected_at  timestamptz,
  add column if not exists whatsapp_verify_token  text default '',
  add column if not exists whatsapp_display_number text default '',
  add column if not exists whatsapp_verified_name  text default '',
  add column if not exists whatsapp_quote_template text default '';

-- The conversation log — one row per inbound or outbound WhatsApp message.
-- Inbound rows are written by `wa-webhook` (service role); outbound by
-- `wa-send`. Threads group by `phone` (normalized digits); customer /
-- professional links are resolved by phone match at write time.
create table if not exists public.wa_messages (
  id              text primary key,
  profile_id      text not null default 'team',
  direction       text not null check (direction in ('in', 'out')),
  -- Meta's message id (wamid.…) — dedupe key for webhook retries and the join
  -- key for delivery-status updates.
  wa_id           text,
  phone           text not null,
  profile_name    text,
  customer_id     text references public.customers(id) on delete set null,
  professional_id text references public.professionals(id) on delete set null,
  quote_id        text references public.quotes(id) on delete set null,
  kind            text not null default 'text',
  body            text not null default '',
  template_name   text,
  -- in: received · out: accepted → sent → delivered → read, or failed.
  status          text not null default 'received',
  error           text,
  payload         jsonb,
  read_at         timestamptz,
  status_at       timestamptz,
  created_at      timestamptz not null default now()
);
create unique index if not exists wa_messages_wa_id_key on public.wa_messages (wa_id) where wa_id is not null;
create index if not exists wa_messages_thread_idx on public.wa_messages (profile_id, phone, created_at desc);

alter table public.wa_messages enable row level security;
drop policy if exists "team can read wa_messages" on public.wa_messages;
create policy "team can read wa_messages" on public.wa_messages
  for select to authenticated using (true);
drop policy if exists "team can write wa_messages" on public.wa_messages;
create policy "team can write wa_messages" on public.wa_messages
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
