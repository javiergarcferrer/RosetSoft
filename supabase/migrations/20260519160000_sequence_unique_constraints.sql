-- Concurrency guard for sequential numbering (quotes / orders /
-- containers). The application's `nextSequenceNumber` helper computes
-- `max(number) + 1` against the live table, which is a textbook
-- read-then-write race: two clients can both read 1003, both write
-- 1004. Single-team usage made the collision unlikely but never zero,
-- and the previous code path swallowed the resulting insert error as a
-- generic "save failed".
--
-- This migration adds a UNIQUE constraint per (profile_id, number) so
-- the database refuses the duplicate. The application's retry loop
-- (added in this same change-set) catches the resulting 23505 and
-- recomputes a fresh sequence number on the next attempt.
--
-- NULLs in `number` are allowed (drafts that haven't been numbered
-- yet). UNIQUE in PostgreSQL treats each NULL as distinct, so the
-- constraint doesn't block multiple un-numbered drafts.

ALTER TABLE public.quotes
  ADD CONSTRAINT quotes_profile_number_unique
  UNIQUE (profile_id, number);

ALTER TABLE public.orders
  ADD CONSTRAINT orders_profile_number_unique
  UNIQUE (profile_id, number);

ALTER TABLE public.containers
  ADD CONSTRAINT containers_profile_number_unique
  UNIQUE (profile_id, number);

NOTIFY pgrst, 'reload schema';
