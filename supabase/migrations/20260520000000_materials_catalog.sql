-- Material catalog.
--
-- Re-introduces a normalised fabric/leather/outdoor catalog so the
-- dealer can pick from the Ligne Roset 10.2025 price list instead of
-- typing fabric names + color codes by hand on every line. The previous
-- catalog tables (products / materials / material_colors / categories)
-- were dropped in migration 20260516120000_strip_catalog_quote_only —
-- that was the right call at the time because the dealer's workflow
-- was "read the PDF, type it in" and the catalog was getting in the
-- way. Now the dealer wants the catalog back, scoped tight: only
-- materials (the things you select when configuring a sofa), not
-- products (the sofas themselves — those still come from the PDF and
-- live free-form on each quote line).
--
-- Shape (single table, colors as JSONB):
--
--   id              text primary key
--   profile_id      shared 'team' row owns all materials
--   category        'fabric' | 'leather' | 'outdoor'
--   name            "ALCANTARA - A", "DIVA", "CHARTRES"
--   grade           single letter, maps to GRADE_GROUPS in subtype.ts
--   wear_rating     "3C" / "2B" / "A" — the LR wear-resistance code
--   wear_double_rubs   the Martindale / double-rubs integer (50000 etc.)
--   measure         numeric — width in inches (fabrics/outdoor) or
--                   thickness in mm (leather)
--   measure_unit    'in' | 'mm' — disambiguates the measure column
--   price           numeric, USD per yard (fabric/outdoor) or per
--                   square metre (leather)
--   price_unit      'yard' | 'sm'
--   composition     free text — "COTTON 80%, POLYESTER 20%"
--   colors          jsonb — array of { name, code } pairs. Co-located
--                   with the material because they're never queried
--                   independently of their parent and a separate
--                   material_colors table would need a join on every
--                   read for ~850 rows.
--   notes           free text — advisories ("ELIOS SLING IS FOR
--                   EXCLUSIVE USE ON THE SABBIA CHILIENNE ONLY.")
--   created_at, updated_at
--
-- RLS follows the existing team-read/team-write pattern.

create table if not exists public.materials (
  id                 text primary key,
  profile_id         text not null references public.profiles(id) on delete cascade,
  category           text not null check (category in ('fabric', 'leather', 'outdoor')),
  name               text not null,
  grade              text,
  wear_rating        text,
  wear_double_rubs   integer,
  measure            numeric,
  measure_unit       text check (measure_unit in ('in', 'mm') or measure_unit is null),
  price              numeric,
  price_unit         text check (price_unit in ('yard', 'sm') or price_unit is null),
  composition        text,
  colors             jsonb not null default '[]'::jsonb,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists materials_profile_category_idx
  on public.materials(profile_id, category);

-- Names are unique per (profile, category). Two fabrics with the same
-- name in the same catalog would be a data-entry mistake; the
-- application surfaces the conflict and refuses the write.
create unique index if not exists materials_profile_category_name_unique
  on public.materials(profile_id, category, lower(name));

alter table public.materials enable row level security;
drop policy if exists "team can read"  on public.materials;
drop policy if exists "team can write" on public.materials;
create policy "team can read"  on public.materials
  for select to authenticated using (true);
create policy "team can write" on public.materials
  for all    to authenticated using (true) with check (true);

-- Touch trigger to keep updated_at honest on every write.
create or replace function public.materials_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists materials_set_updated_at on public.materials;
create trigger materials_set_updated_at
  before update on public.materials
  for each row
  execute function public.materials_set_updated_at();

notify pgrst, 'reload schema';
