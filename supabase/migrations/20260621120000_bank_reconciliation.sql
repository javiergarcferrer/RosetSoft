-- Bank reconciliation — mark ledger bank-account lines as reconciled against
-- the bank statement. A reconciled line carries the timestamp it was cleared;
-- the page compares the reconciled balance to the statement's ending balance.

alter table public.journal_lines
  add column if not exists reconciled_at timestamptz;

create index if not exists journal_lines_reconciled_idx on public.journal_lines(reconciled_at);

notify pgrst, 'reload schema';
