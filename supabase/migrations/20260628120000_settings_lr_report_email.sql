-- Recipient for the monthly Ligne Roset sales report. The report page prefills
-- a "send to Ligne Roset" email draft to this address, so the dealer sets it
-- once in Settings and never retypes it. Plain text (a single email address);
-- null ⇒ the draft opens with an empty recipient for the user to fill.
alter table settings add column if not exists lr_report_email text;

notify pgrst, 'reload schema';
