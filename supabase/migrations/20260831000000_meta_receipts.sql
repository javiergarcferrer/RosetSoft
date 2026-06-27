-- Meta Ads receipts → the books, automatically.
--
-- The `meta-receipts` Edge Function pulls one BILLING RECORD per closed cycle
-- from the Marketing API (the monthly invoice when the account is on Net-30
-- invoicing, else the cycle's account-level spend) and parks it here as a
-- PENDING draft. The dealer reviews the draft in Compras y gastos and posts it
-- → a real `expenses` row (exterior "Meta" supplier, ITBIS 0, 606 tipo 02) with
-- the receipt PRE-ATTACHED; the draft then flips to `posted`. Human-in-the-loop
-- by design (mirrors recurring templates): a foreign charge is never silently
-- booked, and the spend figure is reconciled against the card statement first.
--
-- This is a normal app table (team-readable; the queue UI reads it via the
-- Dexie API) — NOT a credential store. The Edge Function writes it with the
-- service role; the View updates `status`/`expense_id` on post.

create table if not exists meta_receipts (
  id              text primary key,
  profile_id      text not null default 'team',
  ad_account_id   text not null,
  -- `YYYY-MM` billing cycle; (account, period) is the dedup key (see unique).
  period          text not null,
  period_start_at timestamptz,
  period_end_at   timestamptz,
  currency        text,                      -- account currency ('USD'|'DOP')
  amount          numeric,                   -- billed amount, account currency
  amount_dop      numeric,                   -- denormalized display (amount × rate)
  dop_rate        numeric,                   -- USD→DOP snapshot taken at sync
  source          text default 'spend',      -- 'invoice' | 'spend'
  invoice_url     text,                      -- PDF link / billing deep link
  invoice_number  text,
  status          text not null default 'pending'
                  check (status in ('pending','posted','dismissed')),
  expense_id      text,                      -- the gasto created on post
  raw             jsonb,                     -- the untouched Graph payload
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One row per (account, cycle): re-syncing a cycle UPSERTs the same row, so a
-- draft is never double-created and a posted/dismissed one is never resurrected.
create unique index if not exists meta_receipts_account_period
  on meta_receipts (profile_id, ad_account_id, period);

create index if not exists meta_receipts_status
  on meta_receipts (profile_id, status, period_end_at desc);

alter table meta_receipts enable row level security;

-- Single-tenant: the team reads + posts; the Edge Function uses the service role.
drop policy if exists meta_receipts_team_all on meta_receipts;
create policy meta_receipts_team_all on meta_receipts
  for all to authenticated using (true) with check (true);

-- ── Cron: pull the prior month's billing on the 2nd at 09:00 AST ─────────────
-- Self-arming, exactly like the bpd-rate / IG-scheduler idiom: a migration can't
-- know the project URL + service key, so the FIRST authenticated meta-receipts
-- invoke (the "Sincronizar" button or a prior cron run) registers the job, which
-- then self-heals on every successful sync and survives a project restore.
-- `0 13 2 * *` = 13:00 UTC on the 2nd = 09:00 in the DR (UTC-4) — a day after
-- the cycle closes, so the month's charges have settled.
create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function ensure_meta_receipts_cron(p_url text, p_secret text)
returns void
language plpgsql security definer set search_path = public, cron, net as $$
begin
  if exists (select 1 from cron.job where jobname = 'meta-receipts-monthly') then
    perform cron.unschedule('meta-receipts-monthly');
  end if;
  perform cron.schedule('meta-receipts-monthly', '0 13 2 * *',
    'select net.http_post(url:=' || quote_literal(p_url)
    || ', headers:=jsonb_build_object(''Authorization'', ' || quote_literal('Bearer ' || p_secret)
    || ', ''Content-Type'', ''application/json''), body:=''{"cron":true}''::jsonb, timeout_milliseconds:=60000);');
end $$;

revoke all on function ensure_meta_receipts_cron(text, text) from public;
grant execute on function ensure_meta_receipts_cron(text, text) to service_role;

notify pgrst, 'reload schema';
