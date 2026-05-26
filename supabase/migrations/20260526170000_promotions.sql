-- Marketing promotions ("activaciones") — the dealer's reusable record of a
-- Ligne Roset promo package (e.g. "Cabinetry & Bedroom Promo", code BED26,
-- June 11-23 2026, 20% off eligible items). The corporate marketing team
-- sends one of these roughly monthly; this table is where the dealer captures
-- it once and then applies it to quotes.
--
-- v1 is "materialized": applying a promo to a quote writes the discount onto
-- the eligible lines (quote_lines.line_discount_pct) and stamps
-- quotes.promotion_id so the quote knows which activation it carries. No
-- pricing-engine change needed — the existing line-discount math + PDF
-- savings callout already render it.
--
-- Additive + idempotent. PK is app-generated text (newId), profile-scoped to
-- the shared 'team' profile, team-write RLS like the rest of the schema.
-- The row mapper (db/rowMapping) auto-converts camelCase <-> snake_case and
-- *At fields <-> ISO timestamptz, so starts_at/ends_at surface as JS-ms
-- numbers and the jsonb arrays as JS arrays with no extra wiring.

create table if not exists public.promotions (
  id                  text primary key,
  profile_id          text not null,
  name                text not null default '',
  code                text,
  starts_at           timestamptz,
  ends_at             timestamptz,
  discount_pct        numeric not null default 0,
  -- The dealer's share of the discount on a normal eligible model (Roset
  -- co-funds the rest). Informational in v1; the cost-split report uses it
  -- in a later phase.
  dealer_funded_pct   numeric,
  -- Model codes/references where the DEALER absorbs the full discount (Roset
  -- doesn't co-fund) — e.g. ["152","14J","172",...]. JSON array of strings.
  dealer_full_refs    jsonb not null default '[]'::jsonb,
  -- Keywords/references used to SUGGEST which quote lines qualify (the data
  -- is free-text, so we assist rather than auto-decide). JSON array of strings.
  eligible_keywords   jsonb not null default '[]'::jsonb,
  terms               text,
  -- Channel assets ([{channel, lang, url}]) — populated in the distribution
  -- phase; kept here so the record is the single home for an activation.
  assets              jsonb not null default '[]'::jsonb,
  is_enabled          boolean not null default true,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists promotions_profile_idx on public.promotions(profile_id);

alter table public.promotions enable row level security;

-- Single-tenant "team can write" — same shape as customers/quotes/etc.
drop policy if exists promotions_team_all on public.promotions;
create policy promotions_team_all on public.promotions
  for all to authenticated using (true) with check (true);

-- Link a quote to the activation it carries. on delete set null mirrors the
-- other quote FKs (customer_id, professional_id, order_id) — deleting a promo
-- leaves historical quotes intact, just unlinked.
alter table public.quotes
  add column if not exists promotion_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'quotes_promotion_id_fkey'
  ) then
    alter table public.quotes
      add constraint quotes_promotion_id_fkey
      foreign key (promotion_id) references public.promotions(id) on delete set null;
  end if;
end $$;

create index if not exists quotes_promotion_id_idx
  on public.quotes(promotion_id)
  where promotion_id is not null;

notify pgrst, 'reload schema';
