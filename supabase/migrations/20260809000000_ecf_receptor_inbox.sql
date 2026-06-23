-- DGII e-CF RECEPTOR inbox — where the receptor Edge Functions archive the
-- inbound documents they answer (so the dealer has a record and fe-recepcion
-- can detect duplicates). Written by fe-recepcion / fe-aprobacioncomercial via
-- the service role; the app reads them. Additive + idempotent.

-- e-CFs other emisores delivered to us (answered with an Acuse de Recibo).
create table if not exists ecf_received (
  id text primary key,
  profile_id text not null default 'team',
  e_ncf text not null,
  tipo_ecf text,
  rnc_emisor text,
  rnc_comprador text,
  monto_total numeric,
  estado text,                 -- '0' recibido, '1' no recibido
  codigo_no_recibido text,     -- DGII NoReceivedCode when estado='1'
  xml text,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- One logical receipt per issuer + e-NCF — lets fe-recepcion flag duplicates.
create unique index if not exists ecf_received_unique
  on ecf_received (profile_id, rnc_emisor, e_ncf);

-- Commercial approvals/rejections received on e-CFs WE issued.
create table if not exists ecf_commercial_approvals (
  id text primary key,
  profile_id text not null default 'team',
  e_ncf text not null,
  rnc_emisor text,
  rnc_comprador text,
  estado text,                 -- '1' aprobado, '2' rechazado
  motivo_rechazo text,
  xml text,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists ecf_commercial_approvals_encf
  on ecf_commercial_approvals (profile_id, e_ncf);

alter table ecf_received enable row level security;
alter table ecf_commercial_approvals enable row level security;

-- Single-tenant "team can read/write" (the actual writes run via the service
-- role inside the Edge Functions; this lets the app read the inbox).
drop policy if exists ecf_received_all on ecf_received;
create policy ecf_received_all on ecf_received
  for all to authenticated using (true) with check (true);
drop policy if exists ecf_commercial_approvals_all on ecf_commercial_approvals;
create policy ecf_commercial_approvals_all on ecf_commercial_approvals
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
