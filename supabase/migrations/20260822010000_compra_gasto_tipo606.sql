-- User-chosen DGII 606 "Tipo de Bienes y Servicios Comprados" (casilla 3) on a
-- compra/gasto. Until now the code was always derived (tipo606For); this lets
-- the accountant pick it when registering the document (e.g. activo fijo vs.
-- gasto de servicio), and tipo606For prefers the stored value when present.
-- Additive + idempotent.

alter table public.expenses  add column if not exists tipo606 text;
alter table public.purchases add column if not exists tipo606 text;

notify pgrst, 'reload schema';
