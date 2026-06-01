/**
 * Payroll Model (nómina, RD) — TSS deductions + ISR (escala) + the asiento.
 *
 * Per employee: SFS + AFP employee deductions, ISR on (salary − TSS) via the DR
 * monthly scale, net = salary − TSS − ISR; plus employer SFS + AFP + INFOTEP.
 * The run's asiento:
 *   Debit  Sueldos                       Σ gross
 *   Debit  Aportes patronales (SS)       Σ (sfsPat + afpPat)
 *   Debit  INFOTEP (patronal)            Σ infotepPat
 *   Credit Nóminas por pagar             Σ net
 *   Credit TSS por pagar                 Σ (tssEmp + sfsPat + afpPat)
 *   Credit INFOTEP por pagar             Σ infotepPat
 *   Credit Retención ISR (IR-17)         Σ isr
 *
 * Rates are the DR defaults (confirm yearly with the asesor — they change). No
 * caps applied in v1 (a refinement). Pure: no React, no Supabase.
 */
import { round2, buildJournalEntry, type DraftLine } from './ledger.js';
import { requireAccount, type ResolvedAccountingConfig } from './config.js';
import type { JournalEntry, JournalLine, PayrollItem } from '../../types/domain.ts';

/** TSS + INFOTEP contribution rates (%) — DR defaults. */
export const DR_PAYROLL = {
  sfsEmp: 3.04, sfsPat: 7.09, // Seguro Familiar de Salud
  afpEmp: 2.87, afpPat: 7.10, // AFP (pensiones)
  infotepPat: 1.0,            // INFOTEP patronal
};

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
  sfsPat: number; afpPat: number; infotepPat: number;
}

/** Compute one employee's payroll line from their monthly salary. */
export function computePayrollItem(salary: number, rates = DR_PAYROLL): PayrollComputed {
  const s = round2(salary);
  const sfsEmp = round2((s * rates.sfsEmp) / 100);
  const afpEmp = round2((s * rates.afpEmp) / 100);
  const tssEmp = round2(sfsEmp + afpEmp);
  const isr = monthlyIsr(s - tssEmp);
  return {
    gross: s,
    sfsEmp,
    afpEmp,
    isr,
    net: round2(s - tssEmp - isr),
    sfsPat: round2((s * rates.sfsPat) / 100),
    afpPat: round2((s * rates.afpPat) / 100),
    infotepPat: round2((s * rates.infotepPat) / 100),
  };
}

const sum = (items: PayrollItem[], f: keyof PayrollItem) =>
  round2((items || []).reduce((a, i) => a + (Number(i[f]) || 0), 0));

/** Run-level totals from the item lines. */
export function payrollTotals(items: PayrollItem[]) {
  const sfsPat = sum(items, 'sfsPat');
  const afpPat = sum(items, 'afpPat');
  return {
    gross: sum(items, 'gross'),
    tssEmp: round2(sum(items, 'sfsEmp') + sum(items, 'afpEmp')),
    isr: sum(items, 'isr'),
    net: sum(items, 'net'),
    employerSs: round2(sfsPat + afpPat),
    employerInfotep: sum(items, 'infotepPat'),
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
  ].filter((l) => (l.debit || 0) > 0 || (l.credit || 0) > 0);

  return buildJournalEntry({
    newId, postedAt, source: 'payroll', memo: memo || 'Nómina',
    refTable: 'payroll_runs', lines,
  });
}
