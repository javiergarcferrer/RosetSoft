-- Heal singleton alternative groups.
--
-- An "alternative group" is a menu of interchangeable lines the customer
-- picks between; exactly one is selected and counts toward the total.
-- A group with a SINGLE member is a degenerate state — it renders as
-- "Alternativa 1 de 1" and (if its lone member is somehow not the
-- selected one) can silently drop out of the quote total.
--
-- Going forward the app maintains the invariant in QuoteBuilder.removeLine
-- (a group that collapses to one survivor has its tag cleared). This
-- migration repairs any rows that reached the degenerate state under the
-- previous logic, which promoted a survivor to "selected" but left the
-- now-meaningless alternative_group tag in place.
--
-- After this runs, every surviving alternative_group has >= 2 members,
-- so the singleton caption is impossible and lone survivors price as the
-- standalone lines they now are.

update public.quote_lines q
set alternative_group = null,
    is_selected_alternative = false
where q.alternative_group is not null
  and (
    select count(*)
    from public.quote_lines s
    where s.alternative_group = q.alternative_group
  ) = 1;

notify pgrst, 'reload schema';
