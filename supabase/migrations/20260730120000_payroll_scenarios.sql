-- Payroll scenarios — extend nómina for overtime/absences/bono/deductions,
-- the regalía and liquidación run kinds, and the employer-size band.
--
-- Additive + idempotent. The per-employee adjustment inputs ride inside the
-- existing payroll_runs.items JSONB (no column needed); these columns hold the
-- run-level rollup + classification.

alter table public.employees
  add column if not exists company_size text;

alter table public.payroll_runs
  add column if not exists other_deductions numeric not null default 0,
  add column if not exists kind text not null default 'monthly';

notify pgrst, 'reload schema';
