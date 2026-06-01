-- e-CF signing credentials + issuer fiscal data — the sign/send layer's secrets.
--
-- The team uploads their DGII digital certificate (.p12) once in the app. It
-- lands here, in a WRITE-ONLY table: authenticated team members can insert/
-- update it, but there is NO select policy, so the browser can never read the
-- bytes or password back. The `ecf-send` Edge Function reads it with the service
-- role (which bypasses RLS). Non-sensitive status (uploaded? which environment?)
-- lives on `settings`, which the UI can read normally.
--
-- This keeps the whole flow app-driven — no dashboard secret, no manual step.

create table if not exists public.ecf_credentials (
  profile_id      text primary key default 'team' references public.profiles(id) on delete cascade,
  p12_base64      text not null,
  password        text not null,
  -- 'dev' (TesteCF) | 'cert' (CerteCF) | 'prod' (eCF).
  environment     text not null default 'cert' check (environment in ('dev','cert','prod')),
  uploaded_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.ecf_credentials enable row level security;
-- Write-only for the team: upload / replace, but never read back.
do $$ begin
  create policy ecf_credentials_insert on public.ecf_credentials
    for insert to authenticated with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy ecf_credentials_update on public.ecf_credentials
    for update to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
-- Intentionally NO select / delete policy: the bytes only flow out via the
-- ecf-send function (service role).

-- Issuer (emisor) fiscal data + e-CF environment status for the UI.
alter table public.settings
  add column if not exists company_rnc           text default '',
  add column if not exists ecf_cert_uploaded_at  timestamptz,
  add column if not exists ecf_environment        text default 'cert';

notify pgrst, 'reload schema';
