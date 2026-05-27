-- Quote groups: per-group attributes for Conjuntos (sets) and Alternativas.
--
-- Until now a "group" was just a shared id string on quote_lines
-- (set_group / alternative_group) with nowhere to hang group-level state.
-- This table is that home, keyed by the SAME id the lines already carry — so
-- the flat grouping + the adjacency-based groupRuns keep working unchanged; we
-- only add attributes alongside.
--
-- v1 attribute: is_optional.
--   • set + is_optional         → the whole Conjunto is an optional add-on
--                                 (take-all-or-nothing): excluded from the
--                                 total until accepted. Implemented by
--                                 materializing is_optional=true onto the
--                                 member lines, so every total surface that
--                                 already filters isPricedLine stays correct
--                                 with no change.
--   • alternative + is_optional → "pick one OR none": the menu may be left
--                                 with zero selected, contributing 0 (the
--                                 existing isPricedLine already excludes
--                                 non-selected alternatives).
--
-- Foundation for nesting later (add parent_group_id + selection columns then)
-- without reworking this.

create table if not exists public.quote_groups (
  id          text primary key,
  quote_id    text not null references public.quotes(id) on delete cascade,
  type        text not null check (type in ('set','alternative')),
  is_optional boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists quote_groups_quote_idx on public.quote_groups(quote_id);

alter table public.quote_groups enable row level security;
drop policy if exists quote_groups_team_all on public.quote_groups;
create policy quote_groups_team_all on public.quote_groups
  for all to authenticated using (true) with check (true);

-- Relax the set/optional invariant. An optional Conjunto materializes
-- is_optional=true onto its member lines (so the existing pricing predicate
-- keeps every total surface correct), which the old constraint forbade. A set
-- member still must NOT also be an alternative.
alter table public.quote_lines
  drop constraint if exists quote_lines_set_xor_optional_alternative;
alter table public.quote_lines
  drop constraint if exists quote_lines_set_xor_alternative;
alter table public.quote_lines
  add constraint quote_lines_set_xor_alternative
  check (not (set_group is not null and alternative_group is not null));

notify pgrst, 'reload schema';
