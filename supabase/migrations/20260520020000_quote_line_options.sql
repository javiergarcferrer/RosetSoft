-- Quote lines: optional add-ons + alternatives ("Option A" from the
-- product-options design discussion).
--
-- Two flags + one group-key let the dealer model the two patterns the
-- customer mental model actually distinguishes:
--
--   Optional add-on   "Add this if you want — costs extra"
--                     Line rendered with an "Opcional" badge,
--                     excluded from the quote total until the
--                     customer accepts (the dealer un-toggles).
--
--   Alternative       "Pick one of these — same role, different
--                     price/style". Lines sharing the same
--                     `alternative_group` string are siblings;
--                     exactly one has `is_selected_alternative = true`
--                     and counts toward the total. The non-selected
--                     ones still render so the customer can see the
--                     options.
--
-- Pure additive columns — no defaults change for existing rows
-- (`is_optional` and `is_selected_alternative` default to false;
-- `alternative_group` defaults to null). Existing quote lines
-- continue to behave exactly as before.
--
-- The pricing layer (lib/pricing → isPricedLine in lib/constants)
-- composes the two predicates so every list view, dashboard,
-- commissions report, and PDF total respects the new semantics
-- in a single edit. See the matching application change in
-- src/lib/constants.ts.

alter table public.quote_lines
  add column if not exists is_optional boolean not null default false,
  add column if not exists alternative_group text,
  add column if not exists is_selected_alternative boolean not null default false;

-- Locate alternatives within a quote quickly when computing group
-- membership or rendering the picker. (quote_id, alternative_group)
-- is the natural lookup key — the index gives O(group-size) reads
-- instead of full-quote scans every render.
create index if not exists quote_lines_alternative_group_idx
  on public.quote_lines(quote_id, alternative_group)
  where alternative_group is not null;

-- Belt-and-suspenders invariant: if a line is in an alternative
-- group it cannot also be optional. Optional + alternative is a
-- meaningless combination (an optional alternative would be
-- "maybe pick one of these or maybe not"); the UI shouldn't let
-- the dealer construct it but the DB refuses just in case.
alter table public.quote_lines
  drop constraint if exists quote_lines_optional_xor_alternative;
alter table public.quote_lines
  add constraint quote_lines_optional_xor_alternative
  check (not (is_optional = true and alternative_group is not null));

notify pgrst, 'reload schema';
