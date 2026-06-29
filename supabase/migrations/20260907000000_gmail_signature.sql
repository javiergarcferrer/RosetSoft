-- Gmail signature — the block appended to outbound replies from the inbox.
--
-- The Gmail tab now lets the dealer REPLY to a thread (google-api `gmailReply`,
-- reusing the already-granted gmail.send scope). A signature is plain text the
-- dealer configures once in Integraciones → Gmail; the reply composer seeds it
-- into every new draft. Non-sensitive, so it lives on settings like the rest of
-- the Gmail mirrors (gmail_synced_at, google_email) — not in the credential store.

alter table public.settings
  add column if not exists gmail_signature text;

notify pgrst, 'reload schema';
