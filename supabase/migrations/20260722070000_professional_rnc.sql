-- Professionals gain an RNC / cédula, mirroring customers: the Profesionales
-- panel now DGII-looks-up the id and auto-fills the company name. Additive +
-- idempotent — no data touched, just a new nullable column.
alter table public.professionals
  add column if not exists rnc text;

notify pgrst, 'reload schema';
