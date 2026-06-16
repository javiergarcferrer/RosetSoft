-- togo_requests — leads from the PUBLIC Togo configurator widget (embedded in the
-- dealer's website via an iframe). A web visitor's contact + their placed plan
-- land HERE as a PENDING request, held on the Togo workspace's "Solicitudes" tab,
-- until the dealer promotes one into the regular quote pipeline (→ a draft quote).
-- Keeping web leads in their OWN table — not directly as draft quotes — stops them
-- from cluttering Cotizaciones before the dealer has triaged them; promotion is an
-- explicit, dealer-driven step.
--
-- Written by the `togo-embed` Edge Function with the SERVICE ROLE (the widget is
-- logged-out → no JWT), read/updated by the team via RLS. `contact`/`items` are
-- JSONB carried straight from the widget payload: the app's rowMapping only
-- converts top-level columns, so the camelCase keys inside (modelId, …) survive
-- the round-trip untouched and replay through the same configurator VM.

create table if not exists public.togo_requests (
  id           text primary key,
  profile_id   text not null default 'team',
  status       text not null default 'pending' check (status in ('pending','converted','dismissed')),
  contact      jsonb not null default '{}'::jsonb,    -- { name, phone, email }
  items        jsonb not null default '[]'::jsonb,     -- [{ modelId, x, y, rot }]
  note         text,
  estimate_usd numeric,                                -- the retail estimate the visitor saw (snapshot)
  quote_id     text,                                   -- set when promoted to a draft quote
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.togo_requests enable row level security;

drop policy if exists togo_requests_rw on public.togo_requests;
create policy togo_requests_rw on public.togo_requests
  for all to authenticated using (true) with check (true);

create index if not exists togo_requests_profile_status_idx
  on public.togo_requests (profile_id, status, created_at desc);

notify pgrst, 'reload schema';
