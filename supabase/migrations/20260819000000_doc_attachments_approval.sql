-- Attachments + approval on supplier documents (gastos / compras). Additive.
-- approval_status is null by default = treated as approved (non-gating); a doc
-- can be flagged pendiente/rechazada for review. attachment_url points at the
-- receipt (e.g. a Drive link).

alter table expenses  add column if not exists attachment_url  text;
alter table expenses  add column if not exists approval_status text;
alter table expenses  add column if not exists approved_by     text;
alter table expenses  add column if not exists approved_at     timestamptz;

alter table purchases add column if not exists attachment_url  text;
alter table purchases add column if not exists approval_status text;
alter table purchases add column if not exists approved_by     text;
alter table purchases add column if not exists approved_at     timestamptz;

notify pgrst, 'reload schema';
