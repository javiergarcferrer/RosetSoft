-- Bank-statement import rules — deterministic categorization for the
-- reconciliation import (Banco Popular first). When an imported line's
-- description matches `pattern`, the leftover posts to `account_code`.
-- Additive + idempotent.

create table if not exists bank_rules (
  id                text primary key,
  profile_id        text not null default 'team',
  bank              text,
  bank_account_code text,
  match_type        text not null default 'contains',
  pattern           text not null,
  account_code      text not null,
  label             text,
  priority          integer not null default 0,
  auto_confirm      boolean default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table bank_rules drop constraint if exists bank_rules_match_type_chk;
alter table bank_rules add  constraint bank_rules_match_type_chk check (match_type in ('contains', 'equals', 'startsWith'));

create index if not exists bank_rules_profile_idx on bank_rules (profile_id);

alter table bank_rules enable row level security;
drop policy if exists bank_rules_rw on bank_rules;
create policy bank_rules_rw on bank_rules for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
