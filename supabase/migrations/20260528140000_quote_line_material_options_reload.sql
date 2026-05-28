-- Ensure the quote_lines.material_options column exists in production and the
-- PostgREST schema cache is fresh. The original add (20260528130000) is
-- idempotent; re-running it as a new migration guarantees the column is present
-- and forces a schema reload — resolving a "could not find the 'material_options'
-- column in the schema cache" error on first use of the material-options editor
-- (a brand-new column whose cache may not have reloaded on the prior deploy).
alter table public.quote_lines
  add column if not exists material_options jsonb;

notify pgrst, 'reload schema';
