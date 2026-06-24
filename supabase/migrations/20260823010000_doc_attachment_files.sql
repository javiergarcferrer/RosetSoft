-- Direct receipt-file upload for compras/gastos. Until now the only way to
-- attach a comprobante was to paste an external URL into `attachment_url`; the
-- dealer wants to drag a photo or PDF straight in and see it previewed.
--
-- The file lands in the existing public `documents` bucket. That bucket was
-- created PDF-only (signed contracts); widen it to also accept receipt photos
-- (phone JPEG/PNG/HEIC, etc.) so a snapshot of a paper receipt is a valid
-- attachment too. Purely additive — application/pdf stays allowed, so the
-- contract-share flow is untouched.
update storage.buckets
  set allowed_mime_types = array[
    'application/pdf',
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'image/heic', 'image/heif', 'image/avif'
  ]
  where id = 'documents';

-- Record the uploaded file's original name + content type next to the URL so
-- the detail view can render the right preview (image inline vs PDF embed) and
-- show a human filename. Null for a legacy/external pasted link.
alter table expenses  add column if not exists attachment_name text;
alter table expenses  add column if not exists attachment_type text;
alter table purchases add column if not exists attachment_name text;
alter table purchases add column if not exists attachment_type text;

notify pgrst, 'reload schema';
