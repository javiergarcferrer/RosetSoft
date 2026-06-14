-- DGII verification badge: persist the taxpayer's estado (e.g. "ACTIVO") on
-- customers + professionals so a successful RNC lookup shows a PERMANENT green
-- "✓ RAZÓN SOCIAL · ACTIVO" (trust signal) and locks the Empresa field — both
-- derive from this column, not from ephemeral UI state. Additive + idempotent.
alter table public.customers     add column if not exists rnc_status text;
alter table public.professionals add column if not exists rnc_status text;

notify pgrst, 'reload schema';
