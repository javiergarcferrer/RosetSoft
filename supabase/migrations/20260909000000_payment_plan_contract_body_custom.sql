-- Payment plans: distinguish a dealer-WRITTEN contract body from the auto one.
--
-- The contract description used to be frozen as text on first save, so editing
-- the stages (e.g. 50/20/20/10 → 50/25/25) updated the schedule but left the
-- paragraph claiming the old split — the prose and the numbers drifted apart.
--
-- The fix derives the description from the plan on every surface UNLESS the
-- dealer typed their own text. This flag marks that override: false (the
-- default, incl. every existing row) ⇒ derive the description live, so any
-- legacy frozen body that drifted is simply ignored and the contract self-heals.

alter table public.payment_plans
  add column if not exists contract_body_custom boolean not null default false;

notify pgrst, 'reload schema';
