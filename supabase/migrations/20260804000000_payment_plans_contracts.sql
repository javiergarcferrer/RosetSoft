-- Per-quote payment plans + digital contracts.
--
-- The dealer finances a quote: a 50% down payment plus N equal monthly cuotas
-- ("cuota fija") at a monthly interest rate. The plan row carries BOTH the
-- amortized schedule AND the signable contract: a public tokenized link
-- (#/contrato/<token>, served by the `contract-share` Edge Function exactly like
-- quote-share) lets the client read the terms + schedule and sign on their
-- phone. The drawn signature + the rendered, signed PDF are archived so the
-- contract is stored digitally.
--
--   share_token / share_enabled  same revoke-without-dropping gate as quotes.
--   schedule (jsonb)             the amortized rows from lib/paymentPlan
--                                (camelCase, dueAt as JS-ms — passed through).
--   signature_image_id           → images (the drawn signature PNG).
--   signed_pdf_path              object path in the `documents` bucket.

create table if not exists public.payment_plans (
  id                text primary key,
  profile_id        text not null,
  quote_id          text references public.quotes(id) on delete cascade,
  customer_id       text,
  number            integer,

  -- Financials (USD — the quote currency; shown in DOP at the live rate).
  total_usd         numeric not null default 0,
  down_payment_pct  numeric not null default 50,
  down_payment_usd  numeric not null default 0,
  financed_usd      numeric not null default 0,
  monthly_rate_pct  numeric not null default 0,
  installment_count integer not null default 1,
  first_due_at      timestamptz,
  schedule          jsonb,

  status            text not null default 'draft'
                      check (status in ('draft', 'active', 'completed', 'cancelled')),
  contract_body     text,

  -- Public, signable share link (mirrors quotes.share_token / share_enabled).
  share_token       text,
  share_enabled     boolean not null default false,

  -- Digital signing record.
  signed_at         timestamptz,
  signer_name       text,
  signer_doc        text,
  signature_image_id text,
  signed_pdf_path   text,
  signed_ip         text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Additive guards so a re-run on an existing table reconciles columns.
alter table public.payment_plans
  add column if not exists customer_id text,
  add column if not exists contract_body text,
  add column if not exists signer_doc text,
  add column if not exists signature_image_id text,
  add column if not exists signed_pdf_path text,
  add column if not exists signed_ip text;

-- One plan per token; partial so the many null tokens don't collide.
create unique index if not exists payment_plans_share_token_idx
  on public.payment_plans(share_token)
  where share_token is not null;

create index if not exists payment_plans_quote_idx on public.payment_plans(quote_id);
create index if not exists payment_plans_profile_idx on public.payment_plans(profile_id);
create unique index if not exists payment_plans_number_idx
  on public.payment_plans(profile_id, number)
  where number is not null;

-- Single-tenant "team can write" RLS, like the rest of the CRM tables. The
-- public contract link never touches this table directly — the `contract-share`
-- Edge Function reads/writes it with the service role, gated on the token.
alter table public.payment_plans enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_plans' and policyname = 'payment_plans team all') then
    create policy "payment_plans team all" on public.payment_plans
      for all to authenticated using (true) with check (true);
  end if;
end $$;

-- A public-read bucket for the archived signed contract PDFs. The signed PDF is
-- uploaded by the `contract-share` Edge Function (service role) when the client
-- signs; the dealer reads it back to download/print. Public-read so a stored
-- link resolves without auth, like the `images` and `social` buckets.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents', 'documents', true,
  52428800, -- 50 MB
  array['application/pdf']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents read') then
    create policy "documents read" on storage.objects for select using (bucket_id = 'documents');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents write') then
    create policy "documents write" on storage.objects for insert to authenticated with check (bucket_id = 'documents');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents update') then
    create policy "documents update" on storage.objects for update to authenticated using (bucket_id = 'documents');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'documents delete') then
    create policy "documents delete" on storage.objects for delete to authenticated using (bucket_id = 'documents');
  end if;
end $$;

-- Dealer-wide default monthly interest rate (editable per plan in the UI).
alter table public.settings
  add column if not exists payment_plan_monthly_rate_pct numeric;

notify pgrst, 'reload schema';
