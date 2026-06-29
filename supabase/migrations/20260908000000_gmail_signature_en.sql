-- Second Gmail signature (English).
--
-- The dealer keeps a Spanish and an English signature and picks one per reply.
-- `gmail_signature` (added in 20260907000000) is the Spanish/default; this adds
-- the English variant. Both are plain text on settings (non-sensitive), seeded
-- into the inbox reply composer's signature selector.

alter table public.settings
  add column if not exists gmail_signature_en text;

notify pgrst, 'reload schema';
