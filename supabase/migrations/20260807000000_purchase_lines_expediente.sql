-- Multi-line purchases + the expediente link.
--
-- A goods purchase (compra) is a supplier INVOICE that can carry several
-- article LINES (each its own item, qty and cost), not just one item. The lines
-- live in a JSONB column (PurchaseLine[] = {id,itemId,name,reference,qty,cost},
-- camelCase preserved — same shape the expediente stores its embarques in); the
-- legacy item_id/qty columns stay for old single-item rows. base/itbis remain
-- the invoice totals (Σ line cost), so the 606 + asiento are unchanged.
--
-- A compra can also be LINKED to an import expediente for traceability (e.g. a
-- local merchandise invoice tied to a shipment). The link is a reference only —
-- the expediente still computes its own landed cost from its own facturas; the
-- compra keeps posting its own asiento. on delete set null so deleting the
-- expediente just unlinks. Additive + idempotent.

alter table public.purchases
  add column if not exists lines        jsonb not null default '[]'::jsonb,
  add column if not exists expediente_id text references public.import_expedientes(id) on delete set null;

create index if not exists purchases_expediente_idx on public.purchases(expediente_id);

notify pgrst, 'reload schema';
