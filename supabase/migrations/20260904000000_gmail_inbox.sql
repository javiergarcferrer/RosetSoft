-- Gmail inbox — a stored mirror of the connected Google account's mail.
--
-- The dealer already connects ONE Google account via OAuth (google_oauth_config,
-- gmail.readonly granted — see 20260731000000_google_oauth.sql). The inbox reuses
-- that grant: the `google-api` Edge Function's `gmailSync` action pulls recent
-- inbox/sent messages and parks them here (service role), and the React inbox
-- reads this table — exactly the wa_messages / meta_receipts pattern (server
-- writes, client reads, no secret ever reaches the browser).
--
-- Brand classification (Ligne Roset / LifestyleGarden / Otros) and invoice
-- detection are pure DERIVATIONS done client-side in the ViewModel
-- (core/crm/views/gmailInbox.js), so this table only stores the raw email
-- fields. `brand` here is a MANUAL override the dealer sets to re-file a thread;
-- null means "let the rules decide".

-- The message log — one row per Gmail message (inbound or our outbound). The PK
-- IS Gmail's own message id, so a re-sync upserts (idempotent dedupe) rather
-- than duplicating. Threads group by `thread_id` (Gmail's threadId).
create table if not exists public.gmail_messages (
  id               text primary key,            -- Gmail message id (dedupe key)
  profile_id       text not null default 'team',
  thread_id        text not null default '',    -- Gmail threadId — the inbox thread key
  direction        text not null default 'in' check (direction in ('in', 'out')),
  from_email       text not null default '',
  from_name        text not null default '',
  to_email         text not null default '',
  subject          text not null default '',
  snippet          text not null default '',
  body_text        text not null default '',
  body_html        text not null default '',
  -- Manual brand override (a products.brand id, or 'otros'); null ⇒ auto-classify.
  brand            text,
  label_ids        jsonb,                        -- Gmail label ids (INBOX, SENT, UNREAD, …)
  has_attachment   boolean not null default false,
  attachment_count integer not null default 0,
  attachments      jsonb,                        -- [{ filename, mimeType, size, attachmentId }]
  customer_id      text references public.customers(id) on delete set null,
  is_read          boolean not null default false,
  received_at      timestamptz,                  -- Gmail internalDate
  payload          jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists gmail_messages_thread_idx on public.gmail_messages (profile_id, thread_id);
create index if not exists gmail_messages_received_idx on public.gmail_messages (profile_id, received_at desc);

alter table public.gmail_messages enable row level security;
drop policy if exists "team can read gmail_messages" on public.gmail_messages;
create policy "team can read gmail_messages" on public.gmail_messages
  for select to authenticated using (true);
drop policy if exists "team can write gmail_messages" on public.gmail_messages;
create policy "team can write gmail_messages" on public.gmail_messages
  for all to authenticated using (true) with check (true);

-- Non-sensitive sync status for the inbox UI (the tokens stay in google_oauth_config).
alter table public.settings
  add column if not exists gmail_synced_at timestamptz;

notify pgrst, 'reload schema';
