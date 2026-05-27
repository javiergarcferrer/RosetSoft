-- Quote lines: "Conjunto" (set) grouping — the TAKE-ALL twin of the
-- alternative group.
--
--   Conjunto          "Buy all of these together" — distinct standalone
--                     products SOLD TOGETHER (e.g. an armchair + an
--                     ottoman). Lines sharing the same `set_group` string
--                     are members of one set. UNLIKE alternatives, EVERY
--                     member is priced normally and counts toward the
--                     total; they're just visually grouped and roll up to
--                     one "Total del conjunto" = the simple SUM of each
--                     member's own line total. There is NO separate set
--                     price and NO set-level discount — each piece keeps
--                     its own price / qty / discount.
--
-- Distinct from a "Composición"/compound line (`components`): a compound
-- is ONE article made of parts sharing one photo; a Conjunto is N FULL
-- lines, each with its own photo / grade / price.
--
-- Pure additive column — no defaults change for existing rows
-- (`set_group` defaults to null). Existing quote lines continue to
-- behave exactly as before. Because every set member is priced,
-- isPricedLine (lib/constants) needs NO change for sets.
--
-- The row mapper (db/rowMapping) auto-converts setGroup <-> set_group,
-- so no other DB wiring is needed.

alter table public.quote_lines
  add column if not exists set_group text;

-- Locate set members within a quote quickly when rendering the group
-- or computing its total. (quote_id, set_group) is the natural lookup
-- key — mirrors the alternative_group index for O(group-size) reads
-- instead of full-quote scans every render.
create index if not exists quote_lines_set_group_idx
  on public.quote_lines(quote_id, set_group)
  where set_group is not null;

-- Belt-and-suspenders invariant: a line in a set must NOT also be
-- optional or in an alternative group. A set is "take ALL", an
-- alternative is "pick ONE", and optional is "maybe take this" —
-- combining them is meaningless. The UI strips the optional /
-- alternative metadata when a line joins a set; the DB refuses the
-- combination just in case. Mirrors the existing
-- quote_lines_optional_xor_alternative constraint.
alter table public.quote_lines
  drop constraint if exists quote_lines_set_xor_optional_alternative;
alter table public.quote_lines
  add constraint quote_lines_set_xor_optional_alternative
  check (not (set_group is not null and (is_optional = true or alternative_group is not null)));

notify pgrst, 'reload schema';
