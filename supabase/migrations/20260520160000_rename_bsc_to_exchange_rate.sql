-- Rename settings.bsc -> settings.exchange_rate.
--
-- "bsc" stood for Banco Santa Cruz, but the rate now comes from Banco
-- Popular, so the bank-specific name was misleading. exchange_rate is
-- bank-neutral and describes the data (the published USD<->DOP buy/sell
-- snapshot). The column's history is bpd -> bsc (20260519140000) ->
-- exchange_rate.
--
-- readExchangeRate() in lib/exchangeRate.ts reads `exchangeRate` first
-- and falls back to the legacy `bsc` / `bpd` shapes, so reads survive the
-- brief window between the frontend deploy and this migration applying.

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'settings' and column_name = 'bsc'
  ) and not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'settings' and column_name = 'exchange_rate'
  ) then
    execute 'alter table public.settings rename column bsc to exchange_rate';
  end if;
end$$;

-- Fresh-install / safety: ensure the column exists even if the rename
-- above didn't run (e.g. a brand-new DB that never had `bsc`).
alter table public.settings
  add column if not exists exchange_rate jsonb
  default '{"buy":null,"sell":null,"updatedAt":null}'::jsonb;

-- PostgREST caches the schema; nudge it so the renamed column is visible
-- to the REST endpoint immediately instead of after the next refresh.
notify pgrst, 'reload schema';
