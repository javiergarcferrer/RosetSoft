-- Public, shareable interactive quote links.
--
-- A dealer can hand a client a link (#/q/<token>) that opens a full-screen,
-- read-only-but-interactive client view: the client toggles optionals and
-- picks among alternatives, and their choices persist back so the dealer
-- sees what the client wants. The client's picks live in `client_selections`
-- and NEVER mutate the dealer's own lines (plan A — non-destructive).
--
--   share_token       random secret embedded in the URL; null until shared.
--   share_enabled      gate so the dealer can revoke without dropping the
--                      token (re-enabling reuses the same link).
--   client_selections  JSONB: { alternatives: {group: lineId},
--                              optionals: {lineId: bool}, updatedAt }.

alter table public.quotes
  add column if not exists share_token text,
  add column if not exists share_enabled boolean not null default false,
  add column if not exists client_selections jsonb;

-- One quote per token; partial so the many null tokens don't collide.
create unique index if not exists quotes_share_token_idx
  on public.quotes(share_token)
  where share_token is not null;

-- The logged-OUT share viewer renders product photos / uploaded swatches via
-- <ImageView>, which reads the `images` metadata table to resolve the public
-- Storage URL. That table is otherwise authenticated-only. The `images`
-- BUCKET is already public-read (see init_storage), so the storage_path this
-- exposes only yields a URL anyone could already fetch — let anon SELECT the
-- metadata so the viewer's images resolve. (Writes stay authenticated.)
drop policy if exists "images anon read" on public.images;
create policy "images anon read"
  on public.images for select
  to anon
  using (true);

notify pgrst, 'reload schema';
