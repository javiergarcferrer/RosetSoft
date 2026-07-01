-- Store Gmail's Authentication-Results header (SPF/DKIM/DMARC verdicts) per
-- message. The Facturas tab's sender-trust gate (resolveInvoiceTrust) reads this
-- to flag spoofed supplier invoices — BEC / fake-invoice defense. Additive; the
-- sync populates it going forward, older rows stay null (→ "review", fail-safe).
alter table public.gmail_messages
  add column if not exists auth_results text;

notify pgrst, 'reload schema';
