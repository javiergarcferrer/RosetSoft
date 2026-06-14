-- professionals.city — give the city its own column, mirroring customers.city,
-- so the Profesionales directory can be filtered by Ciudad the same way Clientes
-- is. Additive + idempotent; existing rows default to '' (the seed only carried
-- a freeform DIRECCIÓN, never a parsed city), and a seller fills it in inline.
alter table public.professionals add column if not exists city text not null default '';

notify pgrst, 'reload schema';
