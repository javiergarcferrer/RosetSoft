-- Accounting configuration: tax parameters + the posting-account map.
--
-- Every event-posting module (sales at delivery, purchases, expenses, customs
-- imports, payment-gateway settlements) needs to know two things: the tax rates
-- in force (ITBIS, customs duty, retención percentages) and WHICH chart account
-- plays each well-known role (the "Ventas locales" account, the "ITBIS por
-- pagar" account, "Suplidores", "Cobros anticipados", …). Rather than hard-code
-- account codes across the codebase, we store an overridable map.
--
-- It lives as one JSONB column on the shared `settings` row (single-tenant), so
-- there's no new table or RLS to manage — `settings` is already the team's
-- config row. Sensible defaults live in code (src/lib/accounting/config.ts),
-- pre-wired to this catálogo's real codes; this column only holds the
-- accountant's overrides + the tax rates.
--
-- Shape (camelCased in JS via rowMapping):
--   { itbisRate, dutyRate, retentionIsrServicesRate, retentionItbisRate,
--     postingMap: { <role>: <accountCode>, ... } }

alter table public.settings
  add column if not exists accounting_config jsonb not null default '{}'::jsonb;

notify pgrst, 'reload schema';
