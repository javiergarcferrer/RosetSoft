-- Invoice-level allocation — a payment can be applied to specific documents
-- (facturas/compras/gastos). `allocations` is [{ docId, docType, amount }]. When
-- present, the aging applies them to those docs first; the unallocated remainder
-- falls back to FIFO (so old payments keep working unchanged).

alter table public.payments
  add column if not exists allocations jsonb not null default '[]'::jsonb;

notify pgrst, 'reload schema';
