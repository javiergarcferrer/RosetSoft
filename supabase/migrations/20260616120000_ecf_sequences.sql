-- e-NCF sequences + e-CF lifecycle — the buildable foundation of DGII e-CF
-- (comprobante fiscal electrónico) emission, ahead of the sign/send layer.
--
-- DGII authorizes ranges of e-NCF per e-CF type (31 crédito fiscal, 32 consumo,
-- 33 nota débito, 34 nota crédito, …). An e-NCF is `E` + tipo(2) + secuencia(10)
-- = 13 chars (e.g. E310000000001). The sequence also carries an expiry
-- (FechaVencimientoSecuencia) that goes into the e-CF. This table holds those
-- authorized ranges; the app assigns the next e-NCF on invoicing.
--
-- sales_postings gains the e-CF lifecycle fields (type + the sign/send results)
-- so the 607 / RFCE / QR can be produced once the send layer lands.
--
-- Single-tenant + team RLS. Amounts/dates per the usual conventions.

create table if not exists public.ecf_sequences (
  id           text primary key,
  profile_id   text not null default 'team' references public.profiles(id) on delete cascade,
  -- e-CF type code: '31','32','33','34','41','43','44','45','46','47'.
  ecf_type     text not null,
  seq_from     numeric not null default 1,
  seq_to       numeric not null default 0,
  -- Next sequence to issue (starts at seq_from). Bumped as e-NCF are assigned.
  next_seq     numeric not null default 1,
  -- Authorization expiry (FechaVencimientoSecuencia on the e-CF).
  expires_at   timestamptz,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists ecf_sequences_profile_idx on public.ecf_sequences(profile_id);
create index if not exists ecf_sequences_type_idx      on public.ecf_sequences(profile_id, ecf_type, active);

alter table public.ecf_sequences enable row level security;
do $$ begin
  create policy ecf_sequences_team_rw on public.ecf_sequences
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

-- e-CF lifecycle on the sale posting.
alter table public.sales_postings
  add column if not exists ecf_type      text default '',
  add column if not exists ecf_status    text default '',   -- ''|pending|signed|sent|accepted|rejected
  add column if not exists track_id       text default '',   -- DGII trackId after transmission
  add column if not exists security_code  text default '';   -- 6-digit code from the signature (QR)

-- Safety net: a posted e-NCF must be unique per company (catches a double-issue).
create unique index if not exists sales_postings_ncf_uq
  on public.sales_postings(profile_id, ncf) where ncf <> '';

notify pgrst, 'reload schema';
