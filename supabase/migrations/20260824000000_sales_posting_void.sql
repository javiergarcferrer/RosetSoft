-- Anulación de factura — void a NOT-yet-transmitted e-NCF (a DGII-compliant
-- sequence gap) or a manual-NCF draft. The reversing asiento is posted as a
-- separate journal entry; this flag just drops the posting out of the 607,
-- IT-1, receivables and the register totals while keeping it visible (Anulada)
-- for audit. An ISSUED e-CF (sent/accepted) is NEVER voided here — it is
-- cancelled with a nota de crédito (E34), which already exists.
alter table public.sales_postings
  add column if not exists voided_at timestamptz,
  add column if not exists voided_reason text;

notify pgrst, 'reload schema';
