-- Multi-embarque expedientes: an expediente can span several embarques (BLs),
-- each with several supplier facturas, each with product lines (FOB + selectivo).
-- The nested structure lives in the `embarques` JSONB; `selectivo` stores the
-- derived ISC total for the list view (cif/duty/import_itbis already exist).
alter table public.import_expedientes
  add column if not exists embarques jsonb,
  add column if not exists selectivo numeric not null default 0;

notify pgrst, 'reload schema';
