-- Meta social — Instagram + Facebook into JARVIS: page/IG analytics, ad
-- results and scheduled posts, read by the meta-social Edge Function so the
-- dashboard can show the social side of the business next to quotes/orders.
--
-- Credentials follow the house secret pattern (shopify_config /
-- claude_config / whatsapp_config): a WRITE-ONLY table with NO client
-- policies — only the meta-social function touches it with the service role.
-- Unlike the RPC-written secrets, this one is written BY the function's
-- `link` mode, because linking requires Graph API discovery (find the Page,
-- its IG business account and the ad account) that SQL can't do.

create table if not exists public.meta_social_config (
  profile_id    text primary key default 'team' references public.profiles(id) on delete cascade,
  access_token  text not null,                -- long-lived user/system-user token (ads + discovery)
  page_id       text not null default '',
  page_name     text not null default '',
  page_token    text not null default '',     -- page-scoped token (page insights + scheduled posts + IG)
  ig_user_id    text not null default '',
  ig_username   text not null default '',
  ad_account_id text not null default '',     -- "act_…" Marketing API account
  updated_at    timestamptz not null default now()
);
alter table public.meta_social_config enable row level security;
-- Intentionally NO client policies: only the meta-social Edge Function
-- (service role) reads or writes this table.

-- Non-sensitive connection mirrors for the JARVIS UI.
alter table public.settings
  add column if not exists meta_social_connected_at timestamptz,
  add column if not exists meta_social_page_name    text default '',
  add column if not exists meta_social_ig_username  text default '';

notify pgrst, 'reload schema';
