-- Re-invoicing after an anulación — fix the "error invoicing a once-anulled
-- order" bug.
--
-- The unique index that prevents double-invoicing a quote
-- (sales_postings_quote_uq) covered VOIDED postings too. So a quote whose only
-- invoice had been anulada could never be re-invoiced: post_sale's INSERT hit
-- the unique index (23505) and its retry loop just kept re-raising it, leaving
-- the dealer stuck with a generic error on a quote the app correctly shows back
-- in "Por facturar" (postedQuoteIds already filters voided postings out).
--
-- An anulada posting is NOT an active invoice — it stays on file for audit but
-- must not block re-billing. Narrow the guard to ACTIVE postings: at most one
-- NON-voided invoice per quote. A second invoice can now be issued once the
-- first is anulada, with its own fresh e-NCF.
drop index if exists public.sales_postings_quote_uq;
create unique index if not exists sales_postings_quote_uq
  on public.sales_postings (quote_id)
  where quote_id is not null and voided_at is null;

notify pgrst, 'reload schema';
