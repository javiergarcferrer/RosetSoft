-- Inbound WhatsApp messages were NEVER inserted: wa-webhook dedupes Meta's
-- retries with upsert ON CONFLICT (wa_id), but the unique index on wa_id was
-- PARTIAL (WHERE wa_id IS NOT NULL) and Postgres cannot infer ON CONFLICT
-- (wa_id) against a partial index — so every inbound insert errored (silently:
-- the webhook answers 200 by design) while delivery statuses, plain UPDATEs,
-- kept working. Replace it with a FULL unique constraint: NULLs stay distinct
-- by default, so failed sends (wa_id null) are unaffected.
drop index if exists wa_messages_wa_id_key;
alter table wa_messages drop constraint if exists wa_messages_wa_id_unique;
alter table wa_messages add constraint wa_messages_wa_id_unique unique (wa_id);

notify pgrst, 'reload schema';
