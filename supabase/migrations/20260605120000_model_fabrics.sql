-- model_fabrics — per-model (family-root) restriction of which catalog fabrics a
-- given Ligne Roset model can actually be upholstered in. Not every fabric in a
-- pricing grade is a technical possibility for a frame; the dealer pastes the
-- model's ligne-roset.com product page and we store the offered patterns here so
-- the material picker can restrict to in-grade AND offered.
--
-- Keyed by the 8-digit family root (see splitSkuGrade in src/lib/catalog.ts), so
-- linking a model once applies to every future quote of it. Independent of the
-- `products` table, so the catalog CSV re-import never disturbs it.
-- Mirrors the camelCase `ModelFabrics` domain type via rowMapping. Additive +
-- idempotent: safe to re-run.
create table if not exists model_fabrics (
  id text primary key,                 -- the family root (e.g. "15420000")
  profile_id text not null default 'team',
  source_url text,                     -- the linked Ligne Roset product page
  title text,                          -- the product page <title>
  pattern_names jsonb not null default '[]'::jsonb,  -- normalized offered fabric names
  fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table model_fabrics enable row level security;

-- Single-tenant: any authenticated team member can read/write.
do $$ begin
  create policy model_fabrics_all on model_fabrics
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
