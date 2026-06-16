/**
 * Payroll Model (nómina, RD) — TSS deductions + ISR (escala) + the asiento.
 *
 * Per employee: SFS + AFP employee deductions, ISR on (salary − TSS) via the DR
 * monthly scale, net = salary − TSS − ISR; plus employer SFS + AFP + SRL +
 * INFOTEP. Every insurance contributes on the salary CAPPED at its TSS tope
 * (SFS 10× / AFP 20× / SRL 4× the salario mínimo cotizable) — the TSS bills on
 * the tope, never above it. SRL (riesgos laborales) is employer-only and rides
 * inside "aportes patronales" with SFS+AFP so the asiento matches the single
 * monthly TSS invoice. The run's asiento:
 *   Debit  Sueldos                       Σ gross
 *   Debit  Aportes patronales (SS)       Σ (sfsPat + afpPat + srlPat)
 *   Debit  INFOTEP (patronal)            Σ infotepPat
 *   Credit Nóminas por pagar             Σ net
 *   Credit TSS por pagar                 Σ (tssEmp + sfsPat + afpPat + srlPat)
 *   Credit INFOTEP por pagar             Σ infotepPat
 *   Credit Retención ISR (IR-17)         Σ isr
 *
 * Rates AND topes are the DR defaults (confirm yearly with the asesor — the
 * topes move with the salario mínimo cotizable). Pure: no React, no Supabase.
 */
import { round2, buildJournalEntry, type DraftLine } from './ledger.js';
import { requireAccount, type ResolvedAccountingConfig } from './config.js';
import type { JournalEntry, JournalLine, PayrollItem } from '../../types/domain.ts';

/** TSS + INFOTEP contribution rates (%) — DR, employee + employer split.
 *  These percentages are date-stable; only the topes move (see SMC_HISTORY). */
const RATES = {
  sfsEmp: 3.04, sfsPat: 7.09, // Seguro Familiar de Salud
  afpEmp: 2.87, afpPat: 7.10, // AFP (pensiones)
  infotepPat: 1.0,            // INFOTEP patronal (sin tope)
  srlPat: 1.2,                // Seguro de Riesgos Laborales (promedio; patronal)
};

/** TSS rates + salary topes — DR defaults (topes vigentes desde feb-2026,
 *  salario mínimo cotizable RD$23,223). Prefer `ratesForPeriod(year, month)` so
 *  a back-dated run uses the topes that were in force then. */
export const DR_PAYROLL = {
  ...RATES,
  sfsSalaryCap: 232_230,      // 10 × salario mínimo cotizable
  afpSalaryCap: 464_460,      // 20 × salario mínimo cotizable
  srlSalaryCap: 92_892,       //  4 × salario mínimo cotizable
};

/** Salario mínimo cotizable (SMC) history — the TSS topes are SMC × {10,20,4},
 *  so they step up whenever the SMC does. Each entry is effective from `from`
 *  (YYYY-MM, inclusive) until the next. Confirm new steps with the asesor. */
export const SMC_HISTORY = [
  { from: '2024-01', smc: 19_351.50 },
  { from: '2025-04', smc: 21_674.80 },
  { from: '2026-02', smc: 23_223.00 },
];

/** The TSS rates + topes in force for a pay period (caps move with the SMC). */
export function ratesForPeriod(year: number, month = 1) {
  const iso = `${year}-${String(month).padStart(2, '0')}`;
  let smc = SMC_HISTORY[0].smc;
  for (const e of SMC_HISTORY) if (iso >= e.from) smc = e.smc;
  return {
    ...RATES,
    smc,
    sfsSalaryCap: round2(smc * 10),
    afpSalaryCap: round2(smc * 20),
    srlSalaryCap: round2(smc * 4),
  };
}

/** Monthly→daily / monthly→hourly divisors (DR administrative convention:
 *  a 44 h week = 5.5 working days × 52 ÷ 12 = 23.83 days/month). */
export const DAILY_DIVISOR = 23.83;
export const MONTHLY_HOURS = round2(DAILY_DIVISOR * 8); // ≈190.64

/** Premium MULTIPLIERS applied to (hours × ordinary-hour value) — the resulting
 *  amount is what's ADDED for those hours (Código de Trabajo):
 *   - ot35  hours 45–68 / week → 1.35× (Art. 203)
 *   - ot100 hours > 68 / week  → 2.00× (Art. 203)
 *   - night jornada nocturna 21:00–07:00 → 0.15× surcharge only (Art. 204)
 *   - holiday feriado / descanso semanal worked → 1.00× on top (Arts. 164/165) */
export const PREMIUM_FACTOR = { ot35: 1.35, ot100: 2.0, night: 0.15, holiday: 1.0 };

/** Pay for overtime / premium hours, given a monthly salary and hours by kind. */
export function overtimePay(
  monthlySalary: number,
  hours: { ot35?: number; ot100?: number; night?: number; holiday?: number } = {},
  divisorHours = MONTHLY_HOURS,
): number {
  const hourly = (Number(monthlySalary) || 0) / (divisorHours || MONTHLY_HOURS);
  let pay = 0;
  for (const k of ['ot35', 'ot100', 'night', 'holiday'] as const) {
    pay += (Number(hours[k]) || 0) * hourly * PREMIUM_FACTOR[k];
  }
  return round2(pay);
}

/** DR annual ISR scale (vigente). */
const ISR_BRACKETS = [
  { upTo: 416220.00, from: 0, base: 0, rate: 0 },
  { upTo: 624329.00, from: 416220.00, base: 0, rate: 0.15 },
  { upTo: 867123.00, from: 624329.00, base: 31216.00, rate: 0.20 },
  { upTo: Infinity, from: 867123.00, base: 79776.00, rate: 0.25 },
];

/** Annual ISR for a taxable annual income, per the scale. */
export function annualIsr(annual: number): number {
  const a = Number(annual) || 0;
  for (const b of ISR_BRACKETS) {
    if (a <= b.upTo) return round2(b.base + (a - b.from) * b.rate);
  }
  return 0;
}

/** Monthly ISR = annual ISR on (monthly taxable × 12) ÷ 12. */
export function monthlyIsr(monthlyTaxable: number): number {
  return round2(annualIsr((Number(monthlyTaxable) || 0) * 12) / 12);
}

export interface PayrollComputed {
  gross: number; sfsEmp: number; afpEmp: number; isr: number; net: number;
  sfsPat: number; afpPat: number; srlPat: number; infotepPat: number;
  /** Extra accrued earnings folded into gross (overtime, bonus, commission…). */
  earnings: number;
  /** Non-statutory amounts withheld from net (loans, advances, garnishment). */
  otherDeductions: number;
}

/** One extra earning on a payroll line. `taxable` ⇒ enters the ISR base;
 *  `cotizable` ⇒ enters the TSS salario cotizable. Overtime/commission are
 *  both; bonificación is taxable-only; viáticos are neither. */
export interface PayrollEarning { label?: string; amount: number; taxable?: boolean; cotizable?: boolean; }
export interface PayrollDeduction { label?: string; amount: number; }
export interface PayrollOptions {
  rates?: typeof DR_PAYROLL;
  earnings?: PayrollEarning[];
  /** Unpaid absence in days — reduces the ordinary salary actually earned. */
  absenceDays?: number;
  absenceDivisor?: number;
  deductions?: PayrollDeduction[];
}

/** A salary capped at an insurance's tope (no tope configured ⇒ uncapped). */
function cotizable(salary: number, cap: number | undefined): number {
  return cap && cap > 0 ? Math.min(salary, cap) : salary;
}

const totalOf = (xs: { amount: number }[] | undefined, pred: (x: PayrollEarning) => boolean = () => true) =>
  round2((xs || []).reduce((a, x) => a + (pred(x as PayrollEarning) ? Number(x.amount) || 0 : 0), 0));

/**
 * Compute one employee's payroll line. The second arg is OPTIONAL adjustments:
 * extra earnings (overtime/bonus — each flagged taxable/cotizable), unpaid
 * absence days, and non-statutory deductions. With no adjustments this is the
 * plain monthly line (back-compatible: `computePayrollItem(salary)`).
 *
 * ISR base = (ordinary + taxable earnings) − employee TSS; salario cotizable =
 * (ordinary + cotizable earnings), capped per insurance; net = gross − TSS −
 * ISR − other deductions.
 */
export function computePayrollItem(salary: number, opts: PayrollOptions = {}): PayrollComputed {
  const rates = opts.rates || DR_PAYROLL;
  const base = round2(salary);
  const divisor = opts.absenceDivisor && opts.absenceDivisor > 0 ? opts.absenceDivisor : DAILY_DIVISOR;
  const absence = round2((base / divisor) * Math.max(0, Number(opts.absenceDays) || 0));
  const earned = round2(base - absence); // ordinary salary actually earned

  const earnings = round2(totalOf(opts.earnings));
  const cotizableExtra = totalOf(opts.earnings, (e) => !!e.cotizable);
  const taxableExtra = totalOf(opts.earnings, (e) => !!e.taxable);

  const gross = round2(earned + earnings);        // total accrued ("Sueldos")
  const cotBase = round2(earned + cotizableExtra); // salario cotizable
  const sfsBase = cotizable(cotBase, rates.sfsSalaryCap);
  const afpBase = cotizable(cotBase, rates.afpSalaryCap);
  const srlBase = cotizable(cotBase, rates.srlSalaryCap);
  const sfsEmp = round2((sfsBase * rates.sfsEmp) / 100);
  const afpEmp = round2((afpBase * rates.afpEmp) / 100);
  const tssEmp = round2(sfsEmp + afpEmp);
  const isr = monthlyIsr(round2(earned + taxableExtra - tssEmp));
  const otherDeductions = totalOf(opts.deductions);
  return {
    gross,
    sfsEmp,
    afpEmp,
    isr,
    earnings,
    otherDeductions,
    net: round2(gross - tssEmp - isr - otherDeductions),
    sfsPat: round2((sfsBase * rates.sfsPat) / 100),
    afpPat: round2((afpBase * rates.afpPat) / 100),
    srlPat: round2((srlBase * (rates.srlPat || 0)) / 100),
    infotepPat: round2((gross * rates.infotepPat) / 100),
  };
}

const sum = (items: PayrollItem[], f: keyof PayrollItem) =>
  round2((items || []).reduce((a, i) => a + (Number(i[f]) || 0), 0));

/** Run-level totals from the item lines. (Items from runs saved before the SRL
 *  field existed simply sum 0 there — replays stay exact.) */
export function payrollTotals(items: PayrollItem[]) {
  const sfsPat = sum(items, 'sfsPat');
  const afpPat = sum(items, 'afpPat');
  const srlPat = sum(items, 'srlPat');
  return {
    gross: sum(items, 'gross'),
    tssEmp: round2(sum(items, 'sfsEmp') + sum(items, 'afpEmp')),
    isr: sum(items, 'isr'),
    net: sum(items, 'net'),
    // SRL folds into the employer-SS figure: one TSS invoice, one rollup —
    // and the persisted run row keeps its existing column set.
    employerSs: round2(sfsPat + afpPat + srlPat),
    employerInfotep: sum(items, 'infotepPat'),
    // Non-statutory withholdings (loans/advances/garnishment); 0 for legacy runs.
    otherDeductions: sum(items, 'otherDeductions'),
  };
}

export function buildPayrollEntry({
  newId, config, items, postedAt, memo,
}: {
  newId: () => string;
  config: ResolvedAccountingConfig;
  items: PayrollItem[];
  postedAt?: number;
  memo?: string;
}): { entry: JournalEntry; lines: JournalLine[] } {
  const t = payrollTotals(items);
  if (t.gross <= 0) throw new Error('La nómina no tiene montos.');
  const tssTotal = round2(t.tssEmp + t.employerSs);

  const lines: DraftLine[] = [
    { accountCode: requireAccount(config, 'salaries'), debit: t.gross },
    { accountCode: requireAccount(config, 'employerSS'), debit: t.employerSs },
    { accountCode: requireAccount(config, 'employerInfotep'), debit: t.employerInfotep },
    { accountCode: requireAccount(config, 'payrollPayable'), credit: t.net },
    { accountCode: requireAccount(config, 'tssPayable'), credit: tssTotal },
    { accountCode: requireAccount(config, 'infotepPayable'), credit: t.employerInfotep },
    { accountCode: requireAccount(config, 'isrWithheld'), credit: t.isr },
    // Other withholdings (loans/advances/garnishment) — only when present.
    { accountCode: requireAccount(config, 'payrollDeductions'), credit: t.otherDeductions || 0 },
  ].filter((l) => (l.debit || 0) > 0 || (l.credit || 0) > 0);

  return buildJournalEntry({
    newId, postedAt, source: 'payroll', memo: memo || 'Nómina',
    refTable: 'payroll_runs', lines,
  });
}

interface EntryArgs { newId: () => string; config: ResolvedAccountingConfig; postedAt?: number; memo?: string; }

/**
 * Regalía pascual asiento: the regalía is a salary expense, exempt from TSS and
 * (up to its 1/12) from ISR — so no employer/TSS lines, only an ISR withholding
 * if a voluntary excess was paid.
 *   Debit  Sueldos           Σ regalía
 *   Credit Nóminas por pagar Σ neto
 *   Credit Retención ISR     Σ isr (excess only; usually 0)
 */
export function buildRegaliaEntry({ newId, config, gross, isr = 0, postedAt, memo }: EntryArgs & { gross: number; isr?: number }) {
  const g = round2(gross);
  if (g <= 0) throw new Error('La regalía no tiene montos.');
  const withheld = round2(isr);
  const lines: DraftLine[] = [
    { accountCode: requireAccount(config, 'salaries'), debit: g },
    { accountCode: requireAccount(config, 'payrollPayable'), credit: round2(g - withheld) },
    { accountCode: requireAccount(config, 'isrWithheld'), credit: withheld },
  ].filter((l) => (l.debit || 0) > 0 || (l.credit || 0) > 0);
  return buildJournalEntry({ newId, postedAt, source: 'payroll', memo: memo || 'Regalía pascual', refTable: 'payroll_runs', lines });
}

/**
 * Liquidación (prestaciones) asiento: preaviso/cesantía/asistencia book to the
 * indemnities expense (ISR/TSS-exempt); vacaciones + regalía to salaries.
 *   Debit  Prestaciones laborales  indemnities
 *   Debit  Sueldos                 salaryItems
 *   Credit Nóminas por pagar       neto
 *   Credit Retención ISR           isr (on the taxable part, if any)
 */
export function buildLiquidacionEntry({ newId, config, indemnities, salaryItems, isr = 0, postedAt, memo }: EntryArgs & { indemnities: number; salaryItems: number; isr?: number }) {
  const ind = round2(indemnities);
  const sal = round2(salaryItems);
  const gross = round2(ind + sal);
  if (gross <= 0) throw new Error('La liquidación no tiene montos.');
  const withheld = round2(isr);
  const lines: DraftLine[] = [
    { accountCode: requireAccount(config, 'laborIndemnities'), debit: ind },
    { accountCode: requireAccount(config, 'salaries'), debit: sal },
    { accountCode: requireAccount(config, 'payrollPayable'), credit: round2(gross - withheld) },
    { accountCode: requireAccount(config, 'isrWithheld'), credit: withheld },
  ].filter((l) => (l.debit || 0) > 0 || (l.credit || 0) > 0);
  return buildJournalEntry({ newId, postedAt, source: 'payroll', memo: memo || 'Liquidación', refTable: 'payroll_runs', lines });
}

/**
 * Bonificación (participación en los beneficios) asiento: a salary expense,
 * TAXABLE for ISR (unlike the regalía) and out of the TSS base; the employee's
 * 0.5% INFOTEP on bonuses is withheld here.
 *   Debit  Sueldos           Σ bonificación
 *   Credit Nóminas por pagar Σ neto
 *   Credit Retención ISR     Σ isr
 *   Credit INFOTEP por pagar Σ infotep (0.5% employee)
 */
export function buildBonificacionEntry({ newId, config, gross, isr = 0, infotep = 0, postedAt, memo }: EntryArgs & { gross: number; isr?: number; infotep?: number }) {
  const g = round2(gross);
  if (g <= 0) throw new Error('La bonificación no tiene montos.');
  const isrW = round2(isr);
  const infW = round2(infotep);
  const lines: DraftLine[] = [
    { accountCode: requireAccount(config, 'salaries'), debit: g },
    { accountCode: requireAccount(config, 'payrollPayable'), credit: round2(g - isrW - infW) },
    { accountCode: requireAccount(config, 'isrWithheld'), credit: isrW },
    { accountCode: requireAccount(config, 'infotepPayable'), credit: infW },
  ].filter((l) => (l.debit || 0) > 0 || (l.credit || 0) > 0);
  return buildJournalEntry({ newId, postedAt, source: 'payroll', memo: memo || 'Bonificación anual', refTable: 'payroll_runs', lines });
}
