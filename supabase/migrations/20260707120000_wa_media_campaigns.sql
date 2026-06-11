-- WhatsApp: inbound/outbound media persistence + broadcast campaigns.
--
-- Media: a WhatsApp media id is only downloadable for a short window (the
-- signed URL Meta hands back expires in ~5 minutes), so `wa-webhook` (inbound)
-- and `wa-send` (outbound) persist the bytes into the `images` Storage bucket
-- under wa/<uuid> at write time and stamp the path + mime on the message row.
-- The chat UI then renders media straight from Storage like every other image.
--
-- Campaigns ("Difusión"): one row per template broadcast — the marketing lever
-- of the WhatsApp Business Platform (Click-to-WhatsApp ads land inbound with a
-- `referral` payload; outbound marketing is an approved MARKETING template sent
-- to a chosen audience). Per-recipient results stay in wa_messages (joined by
-- campaign_id) so delivery/read rollups always reflect the live webhook truth.

alter table public.wa_messages
  add column if not exists media_path  text,
  add column if not exists media_mime  text,
  add column if not exists campaign_id text;

create index if not exists wa_messages_campaign_idx
  on public.wa_messages (campaign_id) where campaign_id is not null;

create table if not exists public.wa_campaigns (
  id              text primary key,
  profile_id      text not null default 'team' references public.profiles(id) on delete cascade,
  name            text not null default '',
  template_name   text not null,
  template_lang   text not null default 'es',
  audience        text not null default '',
  recipient_count integer not null default 0,
  sent_count      integer not null default 0,
  failed_count    integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists wa_campaigns_profile_idx
  on public.wa_campaigns (profile_id, created_at desc);

alter table public.wa_campaigns enable row level security;
drop policy if exists "team can read wa_campaigns" on public.wa_campaigns;
create policy "team can read wa_campaigns" on public.wa_campaigns
  for select to authenticated using (true);
drop policy if exists "team can write wa_campaigns" on public.wa_campaigns;
create policy "team can write wa_campaigns" on public.wa_campaigns
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
