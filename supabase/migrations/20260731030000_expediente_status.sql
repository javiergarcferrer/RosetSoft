-- Draft import expedientes.
--
-- An expediente can now be saved as a DRAFT (work-in-progress: collect
-- documents, complete the data as facturas/BL arrive) before it is
-- "contabilizado" (posts the asiento + lands inventory). Existing rows are
-- already posted → default 'posted'. The app writes only 'draft' | 'posted'.

alter table public.import_expedientes
  add column if not exists status text not null default 'posted';

notify pgrst, 'reload schema';
