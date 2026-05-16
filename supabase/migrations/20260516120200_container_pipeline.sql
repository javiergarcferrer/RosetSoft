-- Container pipeline stages + per-transition timestamps.
--
-- Replaces the binary status='open'/'dispatched' model with a 6-stage
-- pipeline so the container detail page can show "where in the order
-- journey are we" with concrete dates for each milestone:
--
--   filling     accepting quotes, building toward the dispatch minimum
--   submitting  minimum reached, locking down specs + deposits
--   ordered     order placed with Ligne Roset
--   in_transit  shipped from factory, on the ocean
--   landing     arrived in DR, clearing customs / scheduling deliveries
--   complete    every customer received their items, every balance paid

ALTER TABLE containers
  ADD COLUMN IF NOT EXISTS stage        text DEFAULT 'filling',
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS ordered_at   timestamptz,
  ADD COLUMN IF NOT EXISTS shipped_at   timestamptz,
  ADD COLUMN IF NOT EXISTS landed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- Backfill: existing 'dispatched' rows collapse onto the new 'complete'
-- terminal; their dispatched_at becomes completed_at. Everything else
-- starts in 'filling'.
UPDATE containers
  SET stage = 'complete',
      completed_at = COALESCE(dispatched_at, updated_at)
  WHERE status = 'dispatched' AND (stage IS NULL OR stage = 'filling');

UPDATE containers
  SET stage = 'filling'
  WHERE stage IS NULL;

-- Per-quote fulfillment milestones inside a container — independent
-- timestamps so the dealer can mark deposit_paid without first marking
-- customer_notified (real-world ordering is not always neat).
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS customer_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS deposit_paid_at      timestamptz,
  ADD COLUMN IF NOT EXISTS specs_locked_at      timestamptz,
  ADD COLUMN IF NOT EXISTS balance_paid_at      timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_at         timestamptz;

-- Default container flag on settings — when set, new quotes auto-pin
-- to this container so the dealer doesn't have to remember on every
-- quote which container is "currently filling".
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS default_container_id text;
