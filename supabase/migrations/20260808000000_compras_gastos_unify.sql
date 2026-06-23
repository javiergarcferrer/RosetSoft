-- Unify Compras + Gastos into one pane.
--
-- Both are supplier invoices (comprobantes de compra/gasto) that post a balanced
-- asiento and feed the 606 — only the destination differs (inventory vs. an
-- asset/expense account). To present them as one filterable list with a single
-- registration form, two small additive columns:
--   • expenses.expediente_id — a gasto can be LINKED to an import expediente,
--     exactly like a purchase (e.g. a local service tied to a shipment).
--     Reference only; on delete set null just unlinks.
--   • purchases.description — a free-text memo (the gasto path already had one),
--     so an asset/service purchase reads well on the asiento + the merged list.
-- Additive + idempotent; existing rows are unaffected.

alter table public.expenses
  add column if not exists expediente_id text references public.import_expedientes(id) on delete set null;
create index if not exists expenses_expediente_idx on public.expenses(expediente_id);

alter table public.purchases
  add column if not exists description text not null default '';

notify pgrst, 'reload schema';
