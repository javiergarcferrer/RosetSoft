-- Allow the `documents` bucket to hold receipt HTML.
--
-- The Gmail ingestion path (meta-receipts) saves a Meta Ads payment receipt as
-- the gasto's attachment. Meta's per-charge receipts are HTML emails (no PDF on
-- card/threshold billing), so we keep the receipt as a self-contained .html
-- document — the dealer opens it and sees the full receipt. Widen the bucket's
-- MIME allowlist to admit text/html alongside the existing PDF + image types.
-- Purely additive; every previously-allowed type stays allowed.
--
-- Safe: the bucket is served from the Storage origin (not the app origin), so
-- the app's session/localStorage is out of reach of anything in a stored file;
-- and these receipts come from Meta to the dealer's own inbox, not arbitrary
-- uploads.
update storage.buckets
  set allowed_mime_types = array[
    'application/pdf',
    'text/html',
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'image/heic', 'image/heif', 'image/avif'
  ]
  where id = 'documents';

notify pgrst, 'reload schema';
