-- Professionals (architects, decorators, etc.) + per-sale commission tracking,
-- and removal of the legacy quote internal-name field.
--
-- Domain context
-- --------------
-- Dealers often work with outside professionals — interior designers,
-- architects, decorators — who bring clients to the showroom in exchange
-- for a commission on the resulting sale. The professional doesn't sit
-- in the same row as the customer (the *customer* is who pays and
-- receives the goods); they're a third party who introduced the deal
-- and earns a cut.
--
-- Until now the dealer tracked these informally (a note on the quote,
-- or a spreadsheet on the side). This migration formalizes the
-- relationship:
--
--   • A `professionals` table mirroring `customers` — contact info, a
--     per-profile sequential number, plus a *default* commission %
--     (clamped 0–20) that pre-fills new assignments.
--
--   • `quotes.professional_id` (nullable FK) + `quotes.commission_pct`
--     (override). When a professional is assigned to a quote, the quote
--     inherits the professional's default % but the dealer can adjust
--     it per-deal — some professionals negotiate different cuts for
--     different clients.
--
-- The "name" field on quotes goes away in the same migration. It was
-- meant as an internal label ("Residencia Smith — sala") but in practice
-- the number plus the customer chip already identify the quote. Keeping
-- a free-text field that nothing depends on encouraged inconsistent
-- naming and added clutter to the header.
--
-- Why drop instead of soft-deprecate
-- ----------------------------------
-- The column is decorative — no other table joins on it, no PDF
-- semantics depend on it, no business logic reads it. Dropping it
-- cleanly is safer than leaving an unused column that the next person
-- might re-wire and reintroduce drift. Existing values are lost, which
-- the user has explicitly OK'd (they want the field gone).

-- ---------------------------------------------------------------------------
-- 1. Professionals table
-- ---------------------------------------------------------------------------
create table if not exists public.professionals (
  id                       text primary key,
  profile_id               text not null references public.profiles(id) on delete cascade,
  number                   integer,
  name                     text not null,
  company                  text default '',
  email                    text default '',
  phone                    text default '',
  notes                    text default '',
  -- Default commission percentage for sales this professional brings in.
  -- Clamped server-side too; the UI also clamps but the constraint guards
  -- direct DB writes (imports, RPCs, etc.).
  default_commission_pct   numeric default 10 check (
    default_commission_pct >= 0 and default_commission_pct <= 20
  ),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists professionals_profile_idx
  on public.professionals(profile_id);

-- ---------------------------------------------------------------------------
-- 2. Quote → professional link + per-sale commission override
-- ---------------------------------------------------------------------------
-- The two-column design (link + own %) means the commission on each
-- closed sale is *frozen at the time of the deal*. If the dealer later
-- raises the professional's default from 10 → 12, old quotes keep their
-- 10. That's the conservative answer to "does changing the default
-- affect history?": no — only new assignments inherit the new value.
alter table public.quotes
  add column if not exists professional_id text
    references public.professionals(id) on delete set null,
  add column if not exists commission_pct numeric check (
    commission_pct is null or (commission_pct >= 0 and commission_pct <= 20)
  );

create index if not exists quotes_professional_idx
  on public.quotes(professional_id);

-- ---------------------------------------------------------------------------
-- 3. Drop the legacy internal-name field
-- ---------------------------------------------------------------------------
-- See header for rationale. The data here was descriptive only; no row
-- in any other table references it.
alter table public.quotes drop column if exists name;
