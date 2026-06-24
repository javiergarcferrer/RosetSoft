-- Nota de crédito (e-CF tipo 34) support on sales_postings.
--
-- A nota de crédito is itself a sales_posting (ecf_type='34', its own E34 e-NCF,
-- POSITIVE credited amounts) that REFERENCES the sale it modifies. The 607 + IT-1
-- net it out by its E34 prefix; these columns carry the DGII InformacionReferencia
-- (NCF modificado + código de modificación) and link back to the original posting.
-- Additive + idempotent.

alter table public.sales_postings
  add column if not exists modifies_ncf text,
  add column if not exists modifies_posting_id text,
  add column if not exists codigo_modificacion integer;

-- Find a sale's notas (and compute its remaining creditable balance) quickly.
create index if not exists sales_postings_modifies_posting_id_idx
  on public.sales_postings (modifies_posting_id)
  where modifies_posting_id is not null;

notify pgrst, 'reload schema';
