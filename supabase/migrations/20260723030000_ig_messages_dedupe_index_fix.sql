-- FIX: ig_messages dedupe index must be a PLAIN unique index, not a PARTIAL one.
--
-- The original index was `unique (ig_message_id) where ig_message_id is not null`.
-- A PARTIAL unique index cannot serve as the arbiter for
-- `INSERT … ON CONFLICT (ig_message_id) DO NOTHING` unless the partial predicate
-- is repeated in the statement — which PostgREST's `.upsert({ onConflict })` does
-- NOT emit. So the meta-webhook (inbound DMs) and meta-social igBackfill upserts
-- failed with `42P10: there is no unique or exclusion constraint matching the ON
-- CONFLICT specification` on EVERY call — the error was caught and swallowed, so
-- inbound Instagram DMs were silently never stored. (Verified against Postgres.)
--
-- A PLAIN unique index fixes it: it IS a valid ON CONFLICT arbiter, it still
-- dedupes real Meta message ids on retry, AND it still allows many outbound rows
-- with a null ig_message_id — Postgres treats NULLs as DISTINCT in a unique index,
-- so multiple nulls coexist without `NULLS NOT DISTINCT`.

drop index if exists ig_messages_ig_message_id_key;
create unique index if not exists ig_messages_ig_message_id_key
  on public.ig_messages (ig_message_id);

notify pgrst, 'reload schema';
