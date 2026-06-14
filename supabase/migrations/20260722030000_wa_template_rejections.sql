-- Durable WhatsApp template REJECTION records — why Meta rejected a message
-- template. wa-webhook reads `reason` off a message_template_status_update but
-- the settings.whatsapp_template_status map is overwritten on every status
-- event, so a REJECTED reason doesn't survive. This table keeps the LATEST
-- rejection per (profile_id, template_name, language) so the Difusión panel can
-- show the dealer the exact cause to fix. One row per template+language.
-- Additive + idempotent; PK is an app/webhook-generated text id like every
-- other table (`<profile>:<name>:<language>`).
create table if not exists public.wa_template_rejections (
  id              text primary key,
  profile_id      text not null default 'team',
  template_name   text not null,
  language        text not null default '',
  rejected_reason text,
  status          text not null default 'REJECTED',
  updated_at      timestamptz not null default now()
);

create unique index if not exists wa_template_rejections_key
  on public.wa_template_rejections (profile_id, template_name, language);

alter table public.wa_template_rejections enable row level security;
drop policy if exists "team can read wa_template_rejections" on public.wa_template_rejections;
create policy "team can read wa_template_rejections" on public.wa_template_rejections
  for select to authenticated using (true);
drop policy if exists "team can write wa_template_rejections" on public.wa_template_rejections;
create policy "team can write wa_template_rejections" on public.wa_template_rejections
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
