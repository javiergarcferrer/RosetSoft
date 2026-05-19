-- Settings: rename the legacy `bpd` jsonb column to `bsc` so the app's
-- write path (Settings → "Tasa de cambio" → Save, which now persists
-- `set('bsc', { buy, sell, updatedAt })`) actually has a column to land
-- in. Without this rename the Supabase REST endpoint rejects the
-- upsert with "Could not find the 'bsc' column of 'settings' in the
-- schema cache" — because the column literally doesn't exist yet.
--
-- The Banco Popular Dominicano (BPD) → Banco Santa Cruz (BSC) switch
-- was made in src/lib/exchangeRate.js a while back; the SQL side was
-- never moved.

DO $$
BEGIN
  -- Rename in place when we still have the old column and not the new
  -- one. Preserves whatever buy/sell/updatedAt the dealer had stored.
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'settings'
      AND column_name = 'bpd'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'settings'
      AND column_name = 'bsc'
  ) THEN
    EXECUTE 'ALTER TABLE public.settings RENAME COLUMN bpd TO bsc';
  END IF;
END
$$;

-- Cover the fresh-install path (where neither column existed before).
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS bsc jsonb
  DEFAULT '{"buy":null,"sell":null,"updatedAt":null}'::jsonb;

-- New default for the rate-mode column. Existing rows with the
-- 'bpd-*' / 'market' vocabulary keep working at the application layer
-- (normalizeRateMode in lib/exchangeRate.js maps them transparently),
-- but we also rewrite them in place so the DB matches what the UI
-- offers — no rows left referring to a code path that's been gone for
-- months.
ALTER TABLE public.settings ALTER COLUMN dop_rate_mode SET DEFAULT 'bsc-sell';

UPDATE public.settings SET dop_rate_mode = 'bsc-buy'
  WHERE dop_rate_mode = 'bpd-buy';
UPDATE public.settings SET dop_rate_mode = 'bsc-sell'
  WHERE dop_rate_mode IN ('bpd-sell', 'market');

-- Force PostgREST to reload its schema cache so the new column is
-- visible to the REST endpoint immediately. Without this, the first
-- few saves after deploy can still hit the "schema cache" error even
-- though the column exists; the next periodic refresh would clear it,
-- but we don't want the dealer to bump into a stale-cache window.
NOTIFY pgrst, 'reload schema';
