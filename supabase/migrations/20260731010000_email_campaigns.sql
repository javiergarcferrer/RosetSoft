-- Email campaigns (Difusión → Correo) — the mailing-list send history.
--
-- One row per broadcast sent through Gmail to a chosen audience of contacts.
-- Unlike WhatsApp campaigns there is no delivery webhook, so sent/failed are
-- frozen here at send time (the client loops one personalized email per
-- recipient and reports the tallies). Normal team-scoped data (NOT a credential
-- store): single-tenant "team can write" RLS like the rest of the app.

create table if not exists public.email_campaigns (
  id              text primary key,
  profile_id      text not null default 'team',
  name            text not null default '',
  subject         text not null default '',
  audience        text default '',
  recipient_count integer not null default 0,
  sent_count      integer not null default 0,
  failed_count    integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists email_campaigns_profile_idx on public.email_campaigns (profile_id);

alter table public.email_campaigns enable row level security;

drop policy if exists email_campaigns_team_all on public.email_campaigns;
create policy email_campaigns_team_all on public.email_campaigns
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
