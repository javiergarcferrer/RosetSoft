-- Roset Soft cloud schema (Supabase / Postgres).
--
-- Single-tenant: every authenticated user on the project belongs to one team
-- and can read/write all rows. The `profiles` table holds team members (one
-- row per Supabase auth user) plus a shared settings row.
--
-- Run this once in the Supabase SQL Editor (Project → SQL → New query).
--
-- After running, also run storage.sql to create the `images` bucket and its
-- access policies.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Profiles + Settings
-- ---------------------------------------------------------------------------
-- One shared profile row holds the team's settings. Each row in profiles is a
-- team member; on first sign-in the app upserts the current auth user.
create table if not exists public.profiles (
  id          text primary key,                  -- auth.uid()::text for team members; 'team' for the shared row
  name        text not null default 'Member',
  email       text,
  created_at  timestamptz not null default now()
);

create table if not exists public.settings (
  profile_id           text primary key references public.profiles(id) on delete cascade,
  company_name         text default 'Tu Empresa',
  company_address      text default 'Santo Domingo, República Dominicana',
  company_email        text default '',
  company_phone        text default '',
  logo_image_id        text,
  default_currency     text default 'USD',
  currency_rates       jsonb default '{"USD":1,"DOP":60}'::jsonb,
  bpd                  jsonb default '{"buy":null,"sell":null,"updatedAt":null}'::jsonb,
  market               jsonb default '{"rate":null,"date":null,"source":null}'::jsonb,
  dop_rate_mode        text default 'bpd-sell',
  default_margin_pct   numeric default 0,
  default_discount_pct numeric default 0,
  quote_terms          text default 'Cotización válida por 30 días. Precios en pesos dominicanos. Tiempo de entrega aproximado: 12–16 semanas. Sujeto a disponibilidad.',
  quote_footer         text default '',
  quote_counter        integer default 1000
);

-- ---------------------------------------------------------------------------
-- Catalog: categories, products, variants
-- ---------------------------------------------------------------------------
create table if not exists public.categories (
  id          text primary key,
  name        text not null,
  sort_order  integer default 999
);
create index if not exists categories_sort_order_idx on public.categories(sort_order);

create table if not exists public.materials (
  id                            text primary key,
  kind                          text,
  name                          text,
  grade                         text,
  wear                          text,
  martindale                    numeric,
  width                         text,
  price_per_unit                numeric,
  composition                   text default '',
  notes                         text default '',
  restricted_to_product_names   jsonb default '[]'::jsonb
);
create index if not exists materials_kind_idx on public.materials(kind);
create index if not exists materials_name_idx on public.materials(name);

create table if not exists public.material_colors (
  id              text primary key,
  material_id     text not null references public.materials(id) on delete cascade,
  name            text,
  code            text,
  swatch_image_id text
);
create index if not exists material_colors_material_id_idx on public.material_colors(material_id);

create table if not exists public.products (
  id                          text primary key,
  category_id                 text references public.categories(id) on delete set null,
  name                        text not null,
  designer                    text default '',
  year                        integer,
  description                 text default '',
  model_code                  text default '',
  technical_impossibilities   jsonb default '[]'::jsonb,
  hero_image_id               text,
  pages                       jsonb default '[]'::jsonb
);
create index if not exists products_category_idx on public.products(category_id);
create index if not exists products_name_idx on public.products(name);

create table if not exists public.product_variants (
  id              text primary key,
  product_id      text not null references public.products(id) on delete cascade,
  name            text,
  reference       text default '',
  yardage         text default '',
  dimensions      text default '',
  price_by_grade  jsonb default '{}'::jsonb,
  price_fixed     numeric,
  sort_order      integer default 0,
  image_id        text
);
create index if not exists product_variants_product_idx on public.product_variants(product_id);
create index if not exists product_variants_reference_idx on public.product_variants(reference);

-- ---------------------------------------------------------------------------
-- Images: metadata for objects stored in the `images` Storage bucket.
-- The actual blob lives at `images/<storage_path>`; the row tracks ownership.
-- ---------------------------------------------------------------------------
create table if not exists public.images (
  id            text primary key,
  kind          text,
  owner_id      text,
  label         text default '',
  content_type  text,
  size          bigint,
  storage_path  text,
  created_at    timestamptz not null default now()
);
create index if not exists images_owner_idx on public.images(owner_id);
create index if not exists images_kind_idx on public.images(kind);

-- ---------------------------------------------------------------------------
-- Customers + Quotes
-- ---------------------------------------------------------------------------
create table if not exists public.customers (
  id          text primary key,
  profile_id  text not null references public.profiles(id) on delete cascade,
  name        text not null,
  company     text default '',
  email       text default '',
  phone       text default '',
  address     text default '',
  city        text default '',
  state       text default '',
  zip         text default '',
  country     text default '',
  notes       text default '',
  created_at  timestamptz not null default now()
);
create index if not exists customers_profile_idx on public.customers(profile_id);

create table if not exists public.quotes (
  id              text primary key,
  profile_id      text not null references public.profiles(id) on delete cascade,
  customer_id     text references public.customers(id) on delete set null,
  number          integer,
  name            text default '',
  status          text default 'draft',
  is_cart         boolean default false,
  currency_code   text default 'USD',
  rates           jsonb default '{"USD":1}'::jsonb,
  margin_pct      numeric default 0,
  discount_pct    numeric default 0,
  tax_pct         numeric default 0,
  shipping        numeric default 0,
  terms           text default '',
  notes           text default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists quotes_profile_updated_idx on public.quotes(profile_id, updated_at desc);
create index if not exists quotes_profile_is_cart_idx  on public.quotes(profile_id, is_cart);

create table if not exists public.quote_lines (
  id                  text primary key,
  quote_id            text not null references public.quotes(id) on delete cascade,
  product_variant_id  text references public.product_variants(id) on delete set null,
  material_id         text references public.materials(id) on delete set null,
  color_id            text references public.material_colors(id) on delete set null,
  qty                 numeric default 1,
  unit_price          numeric default 0,
  price_override      numeric,
  line_margin_pct     numeric default 0,
  line_discount_pct   numeric default 0,
  notes               text default '',
  sort_order          integer default 0
);
create index if not exists quote_lines_quote_idx on public.quote_lines(quote_id, sort_order);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- This is a single-tenant team app: every authenticated user can read and
-- write everything. Anonymous users get nothing.
do $$
declare
  t text;
  table_names text[] := array[
    'profiles','settings','categories','materials','material_colors',
    'products','product_variants','images','customers','quotes','quote_lines'
  ];
begin
  foreach t in array table_names loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "team can read"  on public.%I', t);
    execute format('drop policy if exists "team can write" on public.%I', t);
    execute format(
      'create policy "team can read" on public.%I for select to authenticated using (true)',
      t
    );
    execute format(
      'create policy "team can write" on public.%I for all to authenticated using (true) with check (true)',
      t
    );
  end loop;
end$$;

-- Bootstrap: ensure the shared "team" profile + its settings row exist so the
-- app finds something on first run. The app can also create these on demand.
insert into public.profiles (id, name)
values ('team', 'Team')
on conflict (id) do nothing;

insert into public.settings (profile_id)
values ('team')
on conflict (profile_id) do nothing;
