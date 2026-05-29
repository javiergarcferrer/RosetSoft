-- Quote lines: split "is this a toggleable optional add-on?" from "is it
-- currently included?" so the public client link can offer optionals as
-- bidirectional TOGGLES (turn on AND back off), not a one-way "accept".
--
-- Until now `is_optional` did double duty: it meant BOTH "the dealer offered
-- this as an optional add-on" AND "it's currently excluded from the total".
-- The interactive client link folded an optional in by clearing is_optional —
-- which also erased the fact it was ever optional, so the recipient could
-- never take it back out. A real toggle has to remember the designation.
--
--   optional_offered  the dealer designated this STANDALONE line as an
--                     optional add-on the client may toggle in / out. Stable
--                     across client picks.
--   is_optional       UNCHANGED meaning — true ⇒ currently excluded from the
--                     total (isPricedLine in lib/constants is untouched, so
--                     every total surface, the PDF, commissions and accounting
--                     keep behaving exactly as before). A toggled-in optional
--                     is is_optional=false + optional_offered=true.
--
-- Pure additive column (defaults false ⇒ existing rows behave identically).
-- The row mapper (db/rowMapping) auto-converts optionalOffered <-> the snake
-- column, so no other DB wiring is needed.

alter table public.quote_lines
  add column if not exists optional_offered boolean not null default false;

-- Backfill: every existing STANDALONE optional was, by definition, offered as
-- an optional add-on — mark it so the client link shows a working toggle for
-- quotes that already exist. Scoped to standalone lines: an optional Conjunto
-- (set member) is toggled at the GROUP level (quote_groups.is_optional), not
-- per line, and optional + alternative is already forbidden by a CHECK.
update public.quote_lines
   set optional_offered = true
 where is_optional = true
   and set_group is null
   and alternative_group is null
   and optional_offered = false;

notify pgrst, 'reload schema';
