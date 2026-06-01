-- Accounting core: chart of accounts + double-entry general ledger.
--
-- Domain context
-- --------------
-- RosetSoft is evolving from a quoting tool into a full accounting ERP for a
-- Dominican furniture importer. The backbone of any accounting system is a
-- double-entry ledger that posts to a chart of accounts. This migration lands
-- that backbone:
--
--   • `accounts`        — the company's chart of accounts (catálogo de cuentas),
--                          seeded below from the advisor's DGII IR-2-aligned
--                          plan (256 accounts, 6 classes). The `code` is the
--                          business key; only LEAF accounts (`is_postable`)
--                          receive postings — title accounts only roll up.
--   • `journal_entries` — one balanced asiento (header): a posting date, a memo,
--                          a `source` discriminator and an optional reference to
--                          the operational row that generated it (a quote, a
--                          purchase, an expense…). Reversals point back via
--                          `reverses_id` / `reversed_by_id` (entries are never
--                          deleted — they're reversed, for audit).
--   • `journal_lines`   — the asiento's lines: one account, a debit OR a credit
--                          (in DOP, the fiscal/functional currency), plus the
--                          original USD amount + rate for traceability (the
--                          business operates in USD; the books are in DOP).
--
-- The single invariant the app enforces (src/lib/accounting/ledger.ts): every
-- entry's Σ debit = Σ credit. Financial statements and DGII forms are pure
-- projections of these lines (src/core/accounting/*), never a second source of
-- truth.
--
-- Single-tenant: every row is scoped to the shared 'team' profile, like the
-- rest of the schema. RLS is the same "authenticated team can read/write".

-- ---------------------------------------------------------------------------
-- 1. Chart of accounts
-- ---------------------------------------------------------------------------
create table if not exists public.accounts (
  code         text primary key,
  profile_id   text not null default 'team' references public.profiles(id) on delete cascade,
  name         text not null,
  class        integer not null check (class between 1 and 6),
  -- Normal balance side. Classes 1/5/6 are debit-natured; 2/3/4 credit-natured.
  nature       text not null check (nature in ('debit','credit')),
  -- Parent account code (the title account one level up); null at the class root.
  parent_code  text references public.accounts(code) on delete set null,
  -- 1 = class root (e.g. "1 ACTIVOS"); deeper = more specific. Drives report indent.
  level        integer not null default 1,
  -- Only leaf accounts receive postings; title accounts only aggregate children.
  is_postable  boolean not null default false,
  -- Optional DGII form box mapping (IR-2 / IT-1 …), filled in with the advisor.
  dgii_box     text,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists accounts_profile_idx     on public.accounts(profile_id);
create index if not exists accounts_parent_idx       on public.accounts(parent_code);
create index if not exists accounts_class_idx         on public.accounts(class);
create index if not exists accounts_postable_idx      on public.accounts(is_postable);

alter table public.accounts enable row level security;
do $$ begin
  create policy accounts_team_rw on public.accounts
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. Journal entries (asientos) + lines
-- ---------------------------------------------------------------------------
create table if not exists public.journal_entries (
  id             text primary key,
  profile_id     text not null default 'team' references public.profiles(id) on delete cascade,
  number         integer,
  -- Effective accounting date (ms-coerced to/from JS via rowMapping's *_at rule).
  posted_at      timestamptz not null default now(),
  memo           text default '',
  -- What generated this entry. 'manual' for hand-keyed; the rest are emitted by
  -- their respective modules so each operational event books itself.
  source         text not null default 'manual' check (source in (
    'manual','opening','sale','purchase','expense','payment','import',
    'payroll','depreciation','fx','tax','gateway','adjustment'
  )),
  -- Optional link back to the operational row (e.g. ('quotes', <id>)).
  ref_table      text,
  ref_id         text,
  -- Reversal bookkeeping: an entry is never edited/deleted once posted — it's
  -- reversed by a mirror entry. These two columns wire the pair together.
  reverses_id    text references public.journal_entries(id) on delete set null,
  reversed_by_id text references public.journal_entries(id) on delete set null,
  created_by_user_id text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists journal_entries_profile_idx on public.journal_entries(profile_id);
create index if not exists journal_entries_posted_idx   on public.journal_entries(posted_at);
create index if not exists journal_entries_source_idx    on public.journal_entries(source);
create index if not exists journal_entries_ref_idx        on public.journal_entries(ref_table, ref_id);
create unique index if not exists journal_entries_number_uq
  on public.journal_entries(profile_id, number) where number is not null;

alter table public.journal_entries enable row level security;
do $$ begin
  create policy journal_entries_team_rw on public.journal_entries
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

create table if not exists public.journal_lines (
  id            text primary key,
  profile_id    text not null default 'team' references public.profiles(id) on delete cascade,
  entry_id      text not null references public.journal_entries(id) on delete cascade,
  account_code  text not null references public.accounts(code),
  -- Amounts in DOP (the fiscal/functional currency). Exactly one of debit/credit
  -- is non-zero per line; the app validates Σ debit = Σ credit per entry.
  debit         numeric not null default 0 check (debit >= 0),
  credit        numeric not null default 0 check (credit >= 0),
  -- Original USD figure + USD→DOP rate used, for traceability (operations are
  -- priced in USD). Null on lines that are natively DOP (taxes, payroll…).
  usd           numeric,
  rate          numeric,
  memo          text default '',
  -- Optional counterparty (customer / supplier / professional) for sub-ledgers.
  third_party_type text,
  third_party_id   text,
  -- Fiscal comprobante (NCF / e-NCF) tied to this line, when applicable.
  ncf           text,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists journal_lines_profile_idx on public.journal_lines(profile_id);
create index if not exists journal_lines_entry_idx     on public.journal_lines(entry_id);
create index if not exists journal_lines_account_idx    on public.journal_lines(account_code);
create index if not exists journal_lines_party_idx       on public.journal_lines(third_party_type, third_party_id);

alter table public.journal_lines enable row level security;
do $$ begin
  create policy journal_lines_team_rw on public.journal_lines
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 3. Seed the chart of accounts (advisor's catálogo, DGII IR-2-aligned)
-- ---------------------------------------------------------------------------
-- Idempotent: re-running refreshes names/structure without duplicating. The
-- two-pass insert (defer parent FK) isn't needed — parents always sort before
-- children in the source, and the FK is validated at statement end.
insert into public.accounts (code, profile_id, name, class, nature, parent_code, level, is_postable, sort_order) values
  ('1-00-000-00-00-00', 'team', 'ACTIVOS', 1, 'debit', null, 1, false, 1),
  ('1-01-000-00-00-00', 'team', 'ACTIVOS CORRIENTES', 1, 'debit', '1-00-000-00-00-00', 2, false, 2),
  ('1-01-001-00-00-00', 'team', 'CAJAS Y BANCOS', 1, 'debit', '1-01-000-00-00-00', 3, false, 3),
  ('1-01-001-01-00-00', 'team', 'CAJAS', 1, 'debit', '1-01-001-00-00-00', 4, false, 4),
  ('1-01-001-01-01-00', 'team', 'CAJA GENERAL', 1, 'debit', '1-01-001-01-00-00', 5, true, 5),
  ('1-01-001-01-02-00', 'team', 'CAJA CHICA', 1, 'debit', '1-01-001-01-00-00', 5, true, 6),
  ('1-01-001-02-00-00', 'team', 'BANCOS', 1, 'debit', '1-01-001-00-00-00', 4, true, 7),
  ('1-01-002-00-00-00', 'team', 'CUENTAS POR COBRAR CLIENTES', 1, 'debit', '1-01-000-00-00-00', 3, true, 8),
  ('1-01-003-00-00-00', 'team', 'CUENTAS POR COBRAR RELACIONADOS', 1, 'debit', '1-01-000-00-00-00', 3, false, 9),
  ('1-01-003-01-00-00', 'team', 'ADELANTOS A SUPLIDORES', 1, 'debit', '1-01-003-00-00-00', 4, true, 10),
  ('1-01-003-02-00-00', 'team', 'EMPLEADOS Y FUNCIONARIOS', 1, 'debit', '1-01-003-00-00-00', 4, true, 11),
  ('1-01-003-03-00-00', 'team', 'RELACIONADOS (FISICO Y JURIDICO)', 1, 'debit', '1-01-003-00-00-00', 4, true, 12),
  ('1-01-003-04-00-00', 'team', 'ACCIONISTAS', 1, 'debit', '1-01-003-00-00-00', 4, true, 13),
  ('1-01-004-00-00-00', 'team', 'OTRAS CUENTAS POR COBRAR', 1, 'debit', '1-01-000-00-00-00', 3, true, 14),
  ('1-01-005-00-00-00', 'team', 'INVENTARIO PRODUCTOS TERMINADOS', 1, 'debit', '1-01-000-00-00-00', 3, true, 15),
  ('1-01-006-00-00-00', 'team', 'INVENTARIO MATERIA PRIMA', 1, 'debit', '1-01-000-00-00-00', 3, true, 16),
  ('1-01-007-00-00-00', 'team', 'INVENTARIO PRODUCTOS EN PROCESO', 1, 'debit', '1-01-000-00-00-00', 3, true, 17),
  ('1-01-008-00-00-00', 'team', 'OTROS INVENTARIOS', 1, 'debit', '1-01-000-00-00-00', 3, true, 18),
  ('1-01-009-00-00-00', 'team', 'MERCANCIAS EN TRANSITO', 1, 'debit', '1-01-000-00-00-00', 3, true, 19),
  ('1-01-010-00-00-00', 'team', 'GASTOS PAGADOS POR ADELANTADO', 1, 'debit', '1-01-000-00-00-00', 3, false, 20),
  ('1-01-010-01-00-00', 'team', 'SEGUROS CONTRATADOS', 1, 'debit', '1-01-010-00-00-00', 4, false, 21),
  ('1-01-010-01-01-00', 'team', 'SEGURO MEDICO', 1, 'debit', '1-01-010-01-00-00', 5, true, 22),
  ('1-01-010-01-02-00', 'team', 'SEGURO EMPRESARIAL', 1, 'debit', '1-01-010-01-00-00', 5, true, 23),
  ('1-01-010-01-03-00', 'team', 'SEGURO AUTOMOVILES', 1, 'debit', '1-01-010-01-00-00', 5, true, 24),
  ('1-01-010-01-04-00', 'team', 'OTROS GASTOS ANTICIPADOS', 1, 'debit', '1-01-010-01-00-00', 5, true, 25),
  ('1-01-011-00-00-00', 'team', 'OTROS ACTIVOS CORRIENTES', 1, 'debit', '1-01-000-00-00-00', 3, true, 26),
  ('1-01-012-00-00-00', 'team', 'DIVIDENDOS A CUENTAS ENTREGADOS EN EL EJERCICIO', 1, 'debit', '1-01-000-00-00-00', 3, true, 27),
  ('1-02-000-00-00-00', 'team', 'ACTIVOS FIJOS', 1, 'debit', '1-00-000-00-00-00', 2, false, 28),
  ('1-02-001-00-00-00', 'team', 'EDIFICACIONES (CAT #1)', 1, 'debit', '1-02-000-00-00-00', 3, true, 29),
  ('1-02-002-00-00-00', 'team', 'EDIFICACIONES AGROPECUARIAS (CAT #1)', 1, 'debit', '1-02-000-00-00-00', 3, true, 30),
  ('1-02-003-00-00-00', 'team', 'AUTOMOBILES Y EQUIPOS (CAT #2)', 1, 'debit', '1-02-000-00-00-00', 3, true, 31),
  ('1-02-004-00-00-00', 'team', 'OTROS FIJOS DEPRECIABLES (CAT #3)', 1, 'debit', '1-02-000-00-00-00', 3, true, 32),
  ('1-02-005-00-00-00', 'team', 'TERRENOS (URBANOS) NO DEPRECIABLES', 1, 'debit', '1-02-000-00-00-00', 3, true, 33),
  ('1-02-006-00-00-00', 'team', 'TERRENOS (RURALES) NO DEPRECIABLES', 1, 'debit', '1-02-000-00-00-00', 3, true, 34),
  ('1-02-007-00-00-00', 'team', 'REVALUACION DE ACTIVOS Y FUTURAS COMPRAS', 1, 'debit', '1-02-000-00-00-00', 3, true, 35),
  ('1-03-000-00-00-00', 'team', 'INVERSIONES', 1, 'debit', '1-00-000-00-00-00', 2, false, 36),
  ('1-03-001-00-00-00', 'team', 'DEPOSITOS', 1, 'debit', '1-03-000-00-00-00', 3, true, 37),
  ('1-03-002-00-00-00', 'team', 'ACCIONES', 1, 'debit', '1-03-000-00-00-00', 3, true, 38),
  ('1-03-003-00-00-00', 'team', 'OTRAS INVERSIONES (FIDEICOMISOS)', 1, 'debit', '1-03-000-00-00-00', 3, true, 39),
  ('1-04-000-00-00-00', 'team', 'OTROS ACTIVOS', 1, 'debit', '1-00-000-00-00-00', 2, false, 40),
  ('1-04-001-00-00-00', 'team', 'ACTIVOS NO AMORTIZABLES', 1, 'debit', '1-04-000-00-00-00', 3, true, 41),
  ('1-04-002-00-00-00', 'team', 'IMPUESTOSADELANTADOS A INSTITUCIONES DEL ESTADO', 1, 'debit', '1-04-000-00-00-00', 3, false, 42),
  ('1-04-002-01-00-00', 'team', 'I.S.R. DIFERIDO ANTICIPADO (PAGADO)', 1, 'debit', '1-04-002-00-00-00', 4, true, 43),
  ('1-04-002-02-00-00', 'team', 'ANTICIPO ISR POR COMPENSAR', 1, 'debit', '1-04-002-00-00-00', 4, true, 44),
  ('1-04-002-03-00-00', 'team', 'I.S.R. RETENIDO INSTITUCIONES FINANCIERAS 1%', 1, 'debit', '1-04-002-00-00-00', 4, true, 45),
  ('1-04-002-04-00-00', 'team', 'SALDO A FAVOR ISR Y OTROS IMPUESTOS', 1, 'debit', '1-04-002-00-00-00', 4, true, 46),
  ('1-04-002-05-00-00', 'team', 'I.S.R. RETENIDO GUBERNAMENTAL 5%', 1, 'debit', '1-04-002-00-00-00', 4, true, 47),
  ('1-04-002-06-00-00', 'team', 'ITBIS ADELANTADO EN COMPRAS', 1, 'debit', '1-04-002-00-00-00', 4, true, 48),
  ('1-04-003-00-00-00', 'team', 'ACTIVOS AMORTIZABLES', 1, 'debit', '1-04-000-00-00-00', 3, false, 49),
  ('1-04-003-01-00-00', 'team', 'MEJORAS EN PROPIEDAD ARRENDADA', 1, 'debit', '1-04-003-00-00-00', 4, true, 50),
  ('1-04-003-02-00-00', 'team', 'AMORTIZACION MEJORA ARRENDADA', 1, 'debit', '1-04-003-00-00-00', 4, true, 51),
  ('1-04-003-03-00-00', 'team', 'OTROS ACTIVOS AMORTIZABLES', 1, 'debit', '1-04-003-00-00-00', 4, true, 52),
  ('1-05-000-00-00-00', 'team', 'PROVISIONES PARA RIESGOS Y GASTOS', 1, 'debit', '1-00-000-00-00-00', 2, false, 53),
  ('1-05-001-00-00-00', 'team', 'DEPRECIACION ACUMULADA (CAT #1)', 1, 'debit', '1-05-000-00-00-00', 3, true, 54),
  ('1-05-002-00-00-00', 'team', 'DEPRECIACION ACUM. AGROPECUARIA (CAT #1)', 1, 'debit', '1-05-000-00-00-00', 3, true, 55),
  ('1-05-003-00-00-00', 'team', 'DEPRECIACION ACUMULADA (CAT #2)', 1, 'debit', '1-05-000-00-00-00', 3, true, 56),
  ('1-05-004-00-00-00', 'team', 'DEPRECIACION ACUMULADA (CAT #3)', 1, 'debit', '1-05-000-00-00-00', 3, true, 57),
  ('1-05-005-00-00-00', 'team', 'CUENTAS INCOBRABLES', 1, 'debit', '1-05-000-00-00-00', 3, true, 58),
  ('1-05-006-00-00-00', 'team', 'PROVISION DE INVENTARIO', 1, 'debit', '1-05-000-00-00-00', 3, true, 59),
  ('1-05-007-00-00-00', 'team', 'OTRAS PROVISIONES', 1, 'debit', '1-05-000-00-00-00', 3, true, 60),
  ('2-00-000-00-00-00', 'team', 'PASIVOS', 2, 'credit', null, 1, false, 61),
  ('2-01-000-00-00-00', 'team', 'ACREEDORES A CORTO PLAZO', 2, 'credit', '2-00-000-00-00-00', 2, false, 62),
  ('2-01-001-00-00-00', 'team', 'PRESTAMOS A CORTO PLAZO', 2, 'credit', '2-01-000-00-00-00', 3, true, 63),
  ('2-01-002-00-00-00', 'team', 'CUENTAS POR PAGAR', 2, 'credit', '2-01-000-00-00-00', 3, false, 64),
  ('2-01-002-01-00-00', 'team', 'SUPLIDORES', 2, 'credit', '2-01-002-00-00-00', 4, true, 65),
  ('2-01-002-02-00-00', 'team', 'FUNCIONARIOS Y EMPLEADOS', 2, 'credit', '2-01-002-00-00-00', 4, true, 66),
  ('2-01-002-03-00-00', 'team', 'OTRAS CUENTAS POR PAGAR', 2, 'credit', '2-01-002-00-00-00', 4, true, 67),
  ('2-01-002-04-00-00', 'team', 'RELACIONADOS (FISICO Y JURIDICO)', 2, 'credit', '2-01-002-00-00-00', 4, true, 68),
  ('2-01-002-05-00-00', 'team', 'ACCIONISTAS', 2, 'credit', '2-01-002-00-00-00', 4, true, 69),
  ('2-01-003-00-00-00', 'team', 'IMPUESTOS POR PAGAR', 2, 'credit', '2-01-000-00-00-00', 3, false, 70),
  ('2-01-003-01-00-00', 'team', 'I.T.B.I.S POR PAGAR', 2, 'credit', '2-01-003-00-00-00', 4, true, 71),
  ('2-01-003-02-00-00', 'team', 'I.T.B.I.S RETENIDO', 2, 'credit', '2-01-003-00-00-00', 4, true, 72),
  ('2-01-003-03-00-00', 'team', 'ANTICIPO I.S.R.', 2, 'credit', '2-01-003-00-00-00', 4, true, 73),
  ('2-01-003-04-00-00', 'team', 'TESORERIA SEGURIDAD SOCIAL', 2, 'credit', '2-01-003-00-00-00', 4, true, 74),
  ('2-01-003-05-00-00', 'team', 'INFOTEP', 2, 'credit', '2-01-003-00-00-00', 4, true, 75),
  ('2-01-003-06-00-00', 'team', 'IR3', 2, 'credit', '2-01-003-00-00-00', 4, true, 76),
  ('2-01-003-07-00-00', 'team', 'IR17', 2, 'credit', '2-01-003-00-00-00', 4, true, 77),
  ('2-01-003-08-00-00', 'team', 'CRS POR PAGAR', 2, 'credit', '2-01-003-00-00-00', 4, true, 78),
  ('2-01-003-09-00-00', 'team', 'ISR POR PAGAR DEL PERIORO', 2, 'credit', '2-01-003-00-00-00', 4, true, 79),
  ('2-01-003-10-00-00', 'team', 'IMPUESTO A LOS ACTIVOS', 2, 'credit', '2-01-003-00-00-00', 4, true, 80),
  ('2-01-004-00-00-00', 'team', 'OTRAS CUENTAS', 2, 'credit', '2-01-000-00-00-00', 3, false, 81),
  ('2-01-004-01-00-00', 'team', 'NOMINAS POR PAGAR', 2, 'credit', '2-01-004-00-00-00', 4, true, 82),
  ('2-01-004-02-00-00', 'team', 'BONIFICACIONES POR PAGAR', 2, 'credit', '2-01-004-00-00-00', 4, true, 83),
  ('2-01-004-03-00-00', 'team', 'ACUMULACIONES POR PAGAR', 2, 'credit', '2-01-004-00-00-00', 4, true, 84),
  ('2-01-005-00-00-00', 'team', 'COBROS ANTICIPADOS', 2, 'credit', '2-01-000-00-00-00', 3, true, 85),
  ('2-01-006-00-00-00', 'team', 'APORTES PARA FUTURA CAPITALIZACION', 2, 'credit', '2-01-000-00-00-00', 3, true, 86),
  ('2-02-000-00-00-00', 'team', 'ACREEDORES A LARGO PLAZO', 2, 'credit', '2-00-000-00-00-00', 2, false, 87),
  ('2-02-001-00-00-00', 'team', 'PRESTAMOS HIPOTECARIOS', 2, 'credit', '2-02-000-00-00-00', 3, true, 88),
  ('2-02-002-00-00-00', 'team', 'PRESTAMOS COMERCIALES (LOCALES)', 2, 'credit', '2-02-000-00-00-00', 3, true, 89),
  ('2-02-003-00-00-00', 'team', 'PRESTAMOS COMERCIALES (EXTERIOR)', 2, 'credit', '2-02-000-00-00-00', 3, true, 90),
  ('2-02-004-00-00-00', 'team', 'PREST. ENTIDADES RELACIONADAS (LOCALES)', 2, 'credit', '2-02-000-00-00-00', 3, true, 91),
  ('2-02-005-00-00-00', 'team', 'PREST. ENTIDADES RELACIONADAS (EXTERIOR)', 2, 'credit', '2-02-000-00-00-00', 3, true, 92),
  ('2-02-006-00-00-00', 'team', 'PREST. ENTIDADES ACOGIDAS A REGIMENES ESPECIALES', 2, 'credit', '2-02-000-00-00-00', 3, true, 93),
  ('2-02-007-00-00-00', 'team', 'PREST. CON ORGANISMOS INTERNACIONALES', 2, 'credit', '2-02-000-00-00-00', 3, true, 94),
  ('2-02-008-00-00-00', 'team', 'PREST. CON ACCIONISTAS', 2, 'credit', '2-02-000-00-00-00', 3, true, 95),
  ('2-03-000-00-00-00', 'team', 'OTROS PASIVOS', 2, 'credit', '2-00-000-00-00-00', 2, true, 96),
  ('3-00-000-00-00-00', 'team', 'PATRIMONIO', 3, 'credit', null, 1, false, 97),
  ('3-01-000-00-00-00', 'team', 'CAPITAL SUSCRITO Y PAGADO', 3, 'credit', '3-00-000-00-00-00', 2, true, 98),
  ('3-02-000-00-00-00', 'team', 'RESERVA LEGAL', 3, 'credit', '3-00-000-00-00-00', 2, true, 99),
  ('3-03-000-00-00-00', 'team', 'SUPERAVIT POR REVALUACION DE ACTIVOS', 3, 'credit', '3-00-000-00-00-00', 2, true, 100),
  ('3-04-000-00-00-00', 'team', 'RESULTADOS ANTERIORES', 3, 'credit', '3-00-000-00-00-00', 2, true, 101),
  ('3-05-000-00-00-00', 'team', 'RESULTADOS DEL PERIODO MENOS ISR', 3, 'credit', '3-00-000-00-00-00', 2, true, 102),
  ('3-06-000-00-00-00', 'team', 'OTRAS RESERVAS', 3, 'credit', '3-00-000-00-00-00', 2, true, 103),
  ('4-00-000-00-00-00', 'team', 'INGRESOS', 4, 'credit', null, 1, false, 104),
  ('4-01-000-00-00-00', 'team', 'INGRESOS DE OPERACIONES NETOS', 4, 'credit', '4-00-000-00-00-00', 2, false, 105),
  ('4-01-001-00-00-00', 'team', 'INGRESOS VENTAS LOCALES', 4, 'credit', '4-01-000-00-00-00', 3, false, 106),
  ('4-01-001-01-00-00', 'team', 'VENTAS LOCALES', 4, 'credit', '4-01-001-00-00-00', 4, true, 107),
  ('4-01-001-02-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-001-00-00-00', 4, true, 108),
  ('4-01-001-03-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-001-00-00-00', 4, true, 109),
  ('4-01-001-04-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-001-00-00-00', 4, true, 110),
  ('4-01-001-05-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-001-00-00-00', 4, true, 111),
  ('4-01-001-06-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-001-00-00-00', 4, true, 112),
  ('4-01-001-07-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-001-00-00-00', 4, true, 113),
  ('4-01-001-08-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-001-00-00-00', 4, true, 114),
  ('4-01-001-09-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-001-00-00-00', 4, true, 115),
  ('4-01-002-00-00-00', 'team', 'INGRESOS EXPORTACIONES', 4, 'credit', '4-01-000-00-00-00', 3, false, 116),
  ('4-01-002-01-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-002-00-00-00', 4, true, 117),
  ('4-01-002-02-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-002-00-00-00', 4, true, 118),
  ('4-01-002-03-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-002-00-00-00', 4, true, 119),
  ('4-01-002-04-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-002-00-00-00', 4, true, 120),
  ('4-01-002-05-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-002-00-00-00', 4, true, 121),
  ('4-01-002-06-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-002-00-00-00', 4, true, 122),
  ('4-01-002-07-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-002-00-00-00', 4, true, 123),
  ('4-01-002-08-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-002-00-00-00', 4, true, 124),
  ('4-01-002-09-00-00', 'team', 'NOMBRE DEL INGRESO', 4, 'credit', '4-01-002-00-00-00', 4, true, 125),
  ('4-01-003-00-00-00', 'team', 'DEVOLUCIONES SOBRE VENTAS', 4, 'credit', '4-01-000-00-00-00', 3, true, 126),
  ('4-01-004-00-00-00', 'team', 'DESCUENTOS SOBRE VENTAS', 4, 'credit', '4-01-000-00-00-00', 3, true, 127),
  ('4-01-005-00-00-00', 'team', 'OTROS INGRESOS', 4, 'credit', '4-01-000-00-00-00', 3, true, 128),
  ('4-02-000-00-00-00', 'team', 'INGRESOS FINANCIEROS', 4, 'credit', '4-00-000-00-00-00', 2, false, 129),
  ('4-02-001-00-00-00', 'team', 'INGRESOS FINANCIEROS (REGULADOS)', 4, 'credit', '4-02-000-00-00-00', 3, true, 130),
  ('4-02-002-00-00-00', 'team', 'INGRESOS FINANCIEROS (NO REGULADOS)', 4, 'credit', '4-02-000-00-00-00', 3, true, 131),
  ('4-02-003-00-00-00', 'team', 'POR DIVIDENDOS', 4, 'credit', '4-02-000-00-00-00', 3, true, 132),
  ('4-02-004-00-00-00', 'team', 'POR PRESTAMOS CON ENTIDADES RELACIONADAS', 4, 'credit', '4-02-000-00-00-00', 3, true, 133),
  ('4-02-005-00-00-00', 'team', 'POR PRESTAMOS CON ENTIDADES NO RELACIONADAS', 4, 'credit', '4-02-000-00-00-00', 3, true, 134),
  ('4-02-006-00-00-00', 'team', 'OTROS INGRESOS FINANCIEROS', 4, 'credit', '4-02-000-00-00-00', 3, true, 135),
  ('4-03-000-00-00-00', 'team', 'INGRESOS EXTRAORDINARIOS', 4, 'credit', '4-00-000-00-00-00', 2, false, 136),
  ('4-03-001-00-00-00', 'team', 'POR VENTA DE ACTIVOS DEPRECIABLES', 4, 'credit', '4-03-000-00-00-00', 3, true, 137),
  ('4-03-002-00-00-00', 'team', 'POR VENTA DE BIENES DE CAPITAL', 4, 'credit', '4-03-000-00-00-00', 3, true, 138),
  ('4-03-003-00-00-00', 'team', 'POR DIFERENCIAS CAMBIARIAS', 4, 'credit', '4-03-000-00-00-00', 3, true, 139),
  ('4-03-004-00-00-00', 'team', 'INGRESOS DE EJERCICIOS ANTERIORES', 4, 'credit', '4-03-000-00-00-00', 3, true, 140),
  ('4-03-005-00-00-00', 'team', 'OTROS INGRESOS EXTRAORDINARIOS', 4, 'credit', '4-03-000-00-00-00', 3, true, 141),
  ('5-00-000-00-00-00', 'team', 'COSTOS', 5, 'debit', null, 1, false, 142),
  ('5-01-000-00-00-00', 'team', 'COSTO DE VENTA', 5, 'debit', '5-00-000-00-00-00', 2, true, 143),
  ('6-00-000-00-00-00', 'team', 'GASTOS', 6, 'debit', null, 1, false, 144),
  ('6-01-000-00-00-00', 'team', 'GASTOS DE PERSONAL', 6, 'debit', '6-00-000-00-00-00', 2, false, 145),
  ('6-01-001-00-00-00', 'team', 'SUELDOS Y SALARIOS', 6, 'debit', '6-01-000-00-00-00', 3, false, 146),
  ('6-01-001-01-00-00', 'team', 'SALARIOS Y COMISIONES', 6, 'debit', '6-01-001-00-00-00', 4, true, 147),
  ('6-01-001-02-00-00', 'team', 'OTRAS RENUMERACIONES', 6, 'debit', '6-01-001-00-00-00', 4, true, 148),
  ('6-01-001-03-00-00', 'team', 'HORAS EXTRAS', 6, 'debit', '6-01-001-00-00-00', 4, true, 149),
  ('6-01-002-00-00-00', 'team', 'RETRIBUCIONES COMPLEMENTARIAS', 6, 'debit', '6-01-000-00-00-00', 3, true, 150),
  ('6-01-003-00-00-00', 'team', 'SEGUROS DE PERSONAL CONSUMIDOS', 6, 'debit', '6-01-000-00-00-00', 3, true, 151),
  ('6-01-005-00-00-00', 'team', 'APORTES A LA SEGURIDAD SOCIAL', 6, 'debit', '6-01-000-00-00-00', 3, true, 152),
  ('6-01-006-00-00-00', 'team', 'APORTE AL INFOTEP', 6, 'debit', '6-01-000-00-00-00', 3, true, 153),
  ('6-01-007-00-00-00', 'team', 'OTROS GASTOS DE PERSONAL', 6, 'debit', '6-01-000-00-00-00', 3, false, 154),
  ('6-01-007-01-00-00', 'team', 'REGALIA PASCUAL', 6, 'debit', '6-01-007-00-00-00', 4, true, 155),
  ('6-01-007-02-00-00', 'team', 'VACACIONES', 6, 'debit', '6-01-007-00-00-00', 4, true, 156),
  ('6-01-007-03-00-00', 'team', 'CURSOS Y CAPACITACIONES', 6, 'debit', '6-01-007-00-00-00', 4, true, 157),
  ('6-01-007-04-00-00', 'team', 'BONIFICACIONES PAGADAS', 6, 'debit', '6-01-007-00-00-00', 4, true, 158),
  ('6-01-007-05-00-00', 'team', 'PREAVISO Y CESANTIA', 6, 'debit', '6-01-007-00-00-00', 4, true, 159),
  ('6-01-007-99-00-00', 'team', 'OTROS GASTOS DE PERSONAL', 6, 'debit', '6-01-007-00-00-00', 4, true, 160),
  ('6-01-008-00-00-00', 'team', 'ITBIS LLEVADO A LA PROPORCIONALIDAD', 6, 'debit', '6-01-000-00-00-00', 3, true, 161),
  ('6-02-000-00-00-00', 'team', 'GASTOS POR TRAB. SUMINISTROS Y SERVICIOS', 6, 'debit', '6-00-000-00-00-00', 2, false, 162),
  ('6-02-001-00-00-00', 'team', 'HONORARIOS PROFESIONALES (FISICOS)', 6, 'debit', '6-02-000-00-00-00', 3, true, 163),
  ('6-02-002-00-00-00', 'team', 'HONORARIOS PROFESIONALES (JURIDICOS)', 6, 'debit', '6-02-000-00-00-00', 3, true, 164),
  ('6-02-003-00-00-00', 'team', 'HONORARIOS AL EXTERIOR (LEY 392-07)', 6, 'debit', '6-02-000-00-00-00', 3, true, 165),
  ('6-02-004-00-00-00', 'team', 'HONORARIOS AL EXTERIOR (FISICOS Y JURIDICOS)', 6, 'debit', '6-02-000-00-00-00', 3, true, 166),
  ('6-02-005-00-00-00', 'team', 'SEGURID., MENSAJ., TRANSP. Y OTROS (FIS)', 6, 'debit', '6-02-000-00-00-00', 3, true, 167),
  ('6-02-006-00-00-00', 'team', 'SEGURID., MENSAJ., TRANSP. Y OTROS (JUR)', 6, 'debit', '6-02-000-00-00-00', 3, true, 168),
  ('6-02-007-00-00-00', 'team', 'OTROS GASTOS POR TRAB., SUMINIS. Y SERV.', 6, 'debit', '6-02-000-00-00-00', 3, false, 169),
  ('6-02-007-01-00-00', 'team', 'UTILIDADES', 6, 'debit', '6-02-007-00-00-00', 4, false, 170),
  ('6-02-007-01-01-00', 'team', 'LUZ Y FUERZA', 6, 'debit', '6-02-007-01-00-00', 5, true, 171),
  ('6-02-007-01-02-00', 'team', 'AGUA Y BASURA', 6, 'debit', '6-02-007-01-00-00', 5, true, 172),
  ('6-02-007-01-03-00', 'team', 'TELEFONO E INTERNET', 6, 'debit', '6-02-007-01-00-00', 5, true, 173),
  ('6-02-007-01-04-00', 'team', 'SERVICIOS DE CABLE Y OTROS', 6, 'debit', '6-02-007-01-00-00', 5, true, 174),
  ('6-02-007-02-00-00', 'team', 'SUMINISTRO GASTABLE DE OFICINA', 6, 'debit', '6-02-007-00-00-00', 4, true, 175),
  ('6-02-007-03-00-00', 'team', 'MATERIAL GASTABLE DE LIMPIEZA', 6, 'debit', '6-02-007-00-00-00', 4, true, 176),
  ('6-02-007-04-00-00', 'team', 'COMBUSTIBLES Y LUBRICANTES', 6, 'debit', '6-02-007-00-00-00', 4, true, 177),
  ('6-02-007-05-00-00', 'team', 'AMENIDADES DE OFICINA', 6, 'debit', '6-02-007-00-00-00', 4, true, 178),
  ('6-02-007-06-00-00', 'team', 'TRANSPORTES Y PEAJES', 6, 'debit', '6-02-007-00-00-00', 4, true, 179),
  ('6-02-007-07-00-00', 'team', 'DIETAS Y VIATICOS', 6, 'debit', '6-02-007-00-00-00', 4, true, 180),
  ('6-02-007-08-00-00', 'team', 'UNIFORMES', 6, 'debit', '6-02-007-00-00-00', 4, true, 181),
  ('6-02-007-09-00-00', 'team', 'EMBELLECIMIENTO Y JARDINERIA', 6, 'debit', '6-02-007-00-00-00', 4, true, 182),
  ('6-02-007-10-00-00', 'team', 'FUMIGACION', 6, 'debit', '6-02-007-00-00-00', 4, true, 183),
  ('6-02-007-11-00-00', 'team', 'LIMPIEZA DE OFICINA', 6, 'debit', '6-02-007-00-00-00', 4, true, 184),
  ('6-02-007-12-00-00', 'team', 'GASTO DISPONIBLE', 6, 'debit', '6-02-007-00-00-00', 4, true, 185),
  ('6-02-007-13-00-00', 'team', 'GASTO DISPONIBLE', 6, 'debit', '6-02-007-00-00-00', 4, true, 186),
  ('6-02-007-14-00-00', 'team', 'GASTO DISPONIBLE', 6, 'debit', '6-02-007-00-00-00', 4, true, 187),
  ('6-02-007-15-00-00', 'team', 'GASTO DISPONIBLE', 6, 'debit', '6-02-007-00-00-00', 4, true, 188),
  ('6-02-007-16-00-00', 'team', 'GASTO DISPONIBLE', 6, 'debit', '6-02-007-00-00-00', 4, true, 189),
  ('6-02-007-17-00-00', 'team', 'GASTO DISPONIBLE', 6, 'debit', '6-02-007-00-00-00', 4, true, 190),
  ('6-02-007-18-00-00', 'team', 'GASTO DISPONIBLE', 6, 'debit', '6-02-007-00-00-00', 4, true, 191),
  ('6-02-007-99-00-00', 'team', 'OTROS GASTOS Y SUMINISTROS', 6, 'debit', '6-02-007-00-00-00', 4, true, 192),
  ('6-02-008-00-00-00', 'team', 'ITBIS PAGADO EN OPERACIONES EXENTAS', 6, 'debit', '6-02-000-00-00-00', 3, true, 193),
  ('6-03-000-00-00-00', 'team', 'ARRENDAMIENTOS', 6, 'debit', '6-00-000-00-00-00', 2, false, 194),
  ('6-03-001-00-00-00', 'team', 'PERSONAS FISICAS', 6, 'debit', '6-03-000-00-00-00', 3, true, 195),
  ('6-03-002-00-00-00', 'team', 'PERSONAS JURIDICAS', 6, 'debit', '6-03-000-00-00-00', 3, true, 196),
  ('6-03-003-00-00-00', 'team', 'OTROS ARRENDAMIENTOS', 6, 'debit', '6-03-000-00-00-00', 3, true, 197),
  ('6-03-004-00-00-00', 'team', 'ITBIS PAGADO EN OPERACIONES EXENTAS', 6, 'debit', '6-03-000-00-00-00', 3, true, 198),
  ('6-04-000-00-00-00', 'team', 'GASTOS DE ACTIVOS FIJOS', 6, 'debit', '6-00-000-00-00-00', 2, false, 199),
  ('6-04-001-00-00-00', 'team', 'DEPRECIACION CATEGORIA #1', 6, 'debit', '6-04-000-00-00-00', 3, true, 200),
  ('6-04-002-00-00-00', 'team', 'DEPRECIACION CATEGORIA #2', 6, 'debit', '6-04-000-00-00-00', 3, true, 201),
  ('6-04-003-00-00-00', 'team', 'DEPRECIACION CATEGORIA #3', 6, 'debit', '6-04-000-00-00-00', 3, true, 202),
  ('6-04-004-00-00-00', 'team', 'REPARACIONES CATEGORIA #1', 6, 'debit', '6-04-000-00-00-00', 3, true, 203),
  ('6-04-005-00-00-00', 'team', 'REPARACIONES CATEGORIA #2 Y #3', 6, 'debit', '6-04-000-00-00-00', 3, true, 204),
  ('6-04-006-00-00-00', 'team', 'MANTENIMIENTO DE ACTIVOS FIJOS', 6, 'debit', '6-04-000-00-00-00', 3, true, 205),
  ('6-04-007-00-00-00', 'team', 'AMORTIZACION DE BIENES INTANGIBLES', 6, 'debit', '6-04-000-00-00-00', 3, true, 206),
  ('6-04-008-00-00-00', 'team', 'AMORTIZACION MEJORAS ARRENDADAS', 6, 'debit', '6-04-000-00-00-00', 3, true, 207),
  ('6-04-009-00-00-00', 'team', 'ITBIS PAGADO EN OPERACIONES EXENTAS', 6, 'debit', '6-04-000-00-00-00', 3, true, 208),
  ('6-05-000-00-00-00', 'team', 'GASTOS DE REPRESENTACION', 6, 'debit', '6-00-000-00-00-00', 2, false, 209),
  ('6-05-001-00-00-00', 'team', 'RELACIONES PUBLICAS', 6, 'debit', '6-05-000-00-00-00', 3, true, 210),
  ('6-05-002-00-00-00', 'team', 'PUBLICIDAD', 6, 'debit', '6-05-000-00-00-00', 3, true, 211),
  ('6-05-003-00-00-00', 'team', 'VIAJES', 6, 'debit', '6-05-000-00-00-00', 3, true, 212),
  ('6-05-004-00-00-00', 'team', 'DONACIONES', 6, 'debit', '6-05-000-00-00-00', 3, true, 213),
  ('6-05-005-00-00-00', 'team', 'DONACIONES A PROINDUSTRIA (LEY 392-07)', 6, 'debit', '6-05-000-00-00-00', 3, true, 214),
  ('6-05-006-00-00-00', 'team', 'OTROS GASTOS DE REPRESENTACION', 6, 'debit', '6-05-000-00-00-00', 3, true, 215),
  ('6-05-007-00-00-00', 'team', 'PROMOCIONES', 6, 'debit', '6-05-000-00-00-00', 3, true, 216),
  ('6-05-008-00-00-00', 'team', 'ITBIS PAGADO EN OPERACIONES EXENTAS', 6, 'debit', '6-05-000-00-00-00', 3, true, 217),
  ('6-06-000-00-00-00', 'team', 'OTRAS DEDUCCIONES ADMITIDAS', 6, 'debit', '6-00-000-00-00-00', 2, false, 218),
  ('6-06-001-00-00-00', 'team', 'PRIMAS DE SEGUROS CONSUMIDOS', 6, 'debit', '6-06-000-00-00-00', 3, false, 219),
  ('6-06-001-01-00-00', 'team', 'SEGURO EMPRESARIAL', 6, 'debit', '6-06-001-00-00-00', 4, true, 220),
  ('6-06-001-02-00-00', 'team', 'SEGURO AUTOMOVILES', 6, 'debit', '6-06-001-00-00-00', 4, true, 221),
  ('6-06-002-00-00-00', 'team', 'CUOTAS Y OTRAS CONTRIBUCIONES', 6, 'debit', '6-06-000-00-00-00', 3, true, 222),
  ('6-06-003-00-00-00', 'team', 'DESTRUCCION DE INVENTARIOS', 6, 'debit', '6-06-000-00-00-00', 3, true, 223),
  ('6-06-004-00-00-00', 'team', 'CUOTAS DE CRS PERIODO', 6, 'debit', '6-06-000-00-00-00', 3, true, 224),
  ('6-07-000-00-00-00', 'team', 'GASTOS FINANCIEROS', 6, 'debit', '6-00-000-00-00-00', 2, false, 225),
  ('6-07-001-00-00-00', 'team', 'POR PRESTAMOS CON INST. FINANC. (LOCAL)', 6, 'debit', '6-07-000-00-00-00', 3, true, 226),
  ('6-07-002-00-00-00', 'team', 'POR PRESTAMOS ENTIDADES (EXTERIOR)', 6, 'debit', '6-07-000-00-00-00', 3, true, 227),
  ('6-07-003-00-00-00', 'team', 'POR PREST. ENTIDADES RELAC. (LOCALES)', 6, 'debit', '6-07-000-00-00-00', 3, true, 228),
  ('6-07-004-00-00-00', 'team', 'POR PREST. ENTIDADES RELAC. (EXTERIOR)', 6, 'debit', '6-07-000-00-00-00', 3, true, 229),
  ('6-07-005-00-00-00', 'team', 'POR PRESTAMOS PERSONAS FISICAS', 6, 'debit', '6-07-000-00-00-00', 3, true, 230),
  ('6-07-006-00-00-00', 'team', 'POR PRESTAMOS PERSONAS FISICAS RELACIONADA (LOCALES)', 6, 'debit', '6-07-000-00-00-00', 3, true, 231),
  ('6-07-007-00-00-00', 'team', 'POR PRESTAMOS PERSONAS FISICAS RELACIONADA (EXTERIOR)', 6, 'debit', '6-07-000-00-00-00', 3, true, 232),
  ('6-07-008-00-00-00', 'team', 'POR RETENCIONES BANCARIAS (0.15%)', 6, 'debit', '6-07-000-00-00-00', 3, true, 233),
  ('6-07-009-00-00-00', 'team', 'POR PRESTAMOS A EMPRESAS ACOGIDAS REGIMENES ESPECIALES', 6, 'debit', '6-07-000-00-00-00', 3, true, 234),
  ('6-07-010-00-00-00', 'team', 'OTROS GASTOS FINANCIEROS', 6, 'debit', '6-07-000-00-00-00', 3, false, 235),
  ('6-07-010-01-00-00', 'team', 'CARGOS Y COMISIONES BANCARIAS', 6, 'debit', '6-07-010-00-00-00', 4, true, 236),
  ('6-07-010-02-00-00', 'team', 'COMISIONES TARJETAS DE CREDITO', 6, 'debit', '6-07-010-00-00-00', 4, false, 237),
  ('6-07-010-02-01-00', 'team', 'CARDNET', 6, 'debit', '6-07-010-02-00-00', 5, true, 238),
  ('6-07-010-02-02-00', 'team', 'VISANET', 6, 'debit', '6-07-010-02-00-00', 5, true, 239),
  ('6-07-010-02-03-00', 'team', 'AMERICAN EXPRESS', 6, 'debit', '6-07-010-02-00-00', 5, true, 240),
  ('6-07-010-02-04-00', 'team', 'BLUE', 6, 'debit', '6-07-010-02-00-00', 5, true, 241),
  ('6-08-000-00-00-00', 'team', 'GASTOS EXTRAORDINARIOS', 6, 'debit', '6-00-000-00-00-00', 2, false, 242),
  ('6-08-001-00-00-00', 'team', 'POR PERDIDAS EN VENTAS DE ACT. DEPREC.', 6, 'debit', '6-08-000-00-00-00', 3, true, 243),
  ('6-08-002-00-00-00', 'team', 'POR PERDIDA EN VENTAS BIENES DE CAPITAL', 6, 'debit', '6-08-000-00-00-00', 3, true, 244),
  ('6-08-003-00-00-00', 'team', 'CUENTAS INCOBRABLES', 6, 'debit', '6-08-000-00-00-00', 3, true, 245),
  ('6-08-004-00-00-00', 'team', 'PROVISION CUENTAS INCOBRABLES (AUTORIZADAS)', 6, 'debit', '6-08-000-00-00-00', 3, true, 246),
  ('6-08-005-00-00-00', 'team', 'POR DIFERENCIAS NEGATIVAS CAMBIARIAS', 6, 'debit', '6-08-000-00-00-00', 3, true, 247),
  ('6-08-006-00-00-00', 'team', 'OTROS (IMPUESTOS) Y GASTOS NO ADMITIDOS', 6, 'debit', '6-08-000-00-00-00', 3, true, 248),
  ('6-08-007-00-00-00', 'team', 'IMPUESTO A LOS ACTIVOS', 6, 'debit', '6-08-000-00-00-00', 3, true, 249),
  ('6-08-008-00-00-00', 'team', 'PROVISIONES DE INVENTARIO', 6, 'debit', '6-08-000-00-00-00', 3, true, 250),
  ('6-08-009-00-00-00', 'team', 'OTRAS PROVISIONES', 6, 'debit', '6-08-000-00-00-00', 3, true, 251)
on conflict (code) do update set
  name = excluded.name,
  class = excluded.class,
  nature = excluded.nature,
  parent_code = excluded.parent_code,
  level = excluded.level,
  is_postable = excluded.is_postable,
  sort_order = excluded.sort_order,
  updated_at = now();

notify pgrst, 'reload schema';
