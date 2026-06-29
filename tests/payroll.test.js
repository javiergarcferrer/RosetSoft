/**
 * Tests for the payroll Model (src/lib/accounting/payroll.ts) — the DR ISR
 * scale, per-employee deductions, and the balanced nómina asiento.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccountingConfig } from '../src/lib/accounting/config.js';
import {
  annualIsr, monthlyIsr, computePayrollItem, payrollTotals, buildPayrollEntry, DR_PAYROLL,
  ratesForPeriod, overtimePay, MONTHLY_HOURS, PREMIUM_FACTOR, DAILY_DIVISOR,
  buildRegaliaEntry, buildLiquidacionEntry, buildBonificacionEntry,
} from '../src/lib/accounting/payroll.js';
import { debitTotal, creditTotal } from '../src/lib/accounting/ledger.js';

const config = resolveAccountingConfig(null);
const M = config.postingMap;
function ids() { let n = 0; return () => `id${++n}`; }

test('annualIsr follows the DR scale at each bracket', () => {
  assert.equal(annualIsr(400000), 0);                       // exempt
  assert.equal(annualIsr(416220), 0);                       // top of exempt
  assert.equal(annualIsr(500000), round2((500000 - 416220) * 0.15));
  assert.equal(annualIsr(700000), round2(31216 + (700000 - 624329) * 0.20));
  assert.equal(annualIsr(1000000), round2(79776 + (1000000 - 867123) * 0.25));
});

test('monthlyIsr annualizes then divides', () => {
  // 50k/month taxable → 600k/year → (600000-416220)*0.15 = 27567 → /12
  assert.equal(monthlyIsr(50000), round2(((600000 - 416220) * 0.15) / 12));
});

test('computePayrollItem: TSS deductions + net', () => {
  const it = computePayrollItem(50000);
  assert.equal(it.sfsEmp, round2(50000 * DR_PAYROLL.sfsEmp / 100));
  assert.equal(it.afpEmp, round2(50000 * DR_PAYROLL.afpEmp / 100));
  assert.equal(it.sfsPat, round2(50000 * DR_PAYROLL.sfsPat / 100));
  assert.equal(it.infotepPat, round2(50000 * DR_PAYROLL.infotepPat / 100));
  // 50k sits under every tope, so SRL contributes on the full salary.
  assert.equal(it.srlPat, round2(50000 * DR_PAYROLL.srlPat / 100));
  // net = gross − (sfsEmp+afpEmp) − isr
  assert.equal(it.net, round2(50000 - it.sfsEmp - it.afpEmp - it.isr));
});

test('INFOTEP patronal is computed on the cotizable base, not gross (viáticos excluded)', () => {
  const salary = 50_000;
  // Viáticos: taxable? no, cotizable? no → in gross ("Sueldos") but OUT of the
  // TSS/INFOTEP contributory base.
  const it = computePayrollItem(salary, { earnings: [{ label: 'Viáticos', amount: 8_000 }] });
  assert.equal(it.gross, round2(salary + 8_000));
  // INFOTEP rides the cotizable base (= ordinary salary here), NOT the gross.
  assert.equal(it.infotepPat, round2(salary * DR_PAYROLL.infotepPat / 100));
  assert.notEqual(it.infotepPat, round2(it.gross * DR_PAYROLL.infotepPat / 100));
});

test('computePayrollItem applies the TSS topes per insurance', () => {
  const s = 500_000; // above every tope
  const it = computePayrollItem(s);
  // SFS contributes on its tope (10× mínimo), AFP on its (20×), SRL on its (4×).
  assert.equal(it.sfsEmp, round2(DR_PAYROLL.sfsSalaryCap * DR_PAYROLL.sfsEmp / 100));
  assert.equal(it.sfsPat, round2(DR_PAYROLL.sfsSalaryCap * DR_PAYROLL.sfsPat / 100));
  assert.equal(it.afpEmp, round2(DR_PAYROLL.afpSalaryCap * DR_PAYROLL.afpEmp / 100));
  assert.equal(it.afpPat, round2(DR_PAYROLL.afpSalaryCap * DR_PAYROLL.afpPat / 100));
  assert.equal(it.srlPat, round2(DR_PAYROLL.srlSalaryCap * DR_PAYROLL.srlPat / 100));
  // INFOTEP has no tope — full salary.
  assert.equal(it.infotepPat, round2(s * DR_PAYROLL.infotepPat / 100));
  // ISR taxes the salary net of the CAPPED TSS deductions.
  const tssEmp = round2(it.sfsEmp + it.afpEmp);
  assert.equal(it.net, round2(s - tssEmp - it.isr));
});

test('payrollTotals folds SRL into employerSs (and tolerates pre-SRL items)', () => {
  const it = computePayrollItem(50000);
  const legacy = { ...computePayrollItem(30000) };
  delete legacy.srlPat; // an item persisted before the SRL field existed
  const t = payrollTotals([
    { employeeId: 'e1', name: 'A', ...it },
    { employeeId: 'e2', name: 'B', ...legacy },
  ]);
  assert.equal(t.employerSs, round2(it.sfsPat + it.afpPat + it.srlPat + legacy.sfsPat + legacy.afpPat));
});

test('payroll asiento balances for a multi-employee run', () => {
  const items = [
    { employeeId: 'e1', name: 'A', ...computePayrollItem(50000) },
    { employeeId: 'e2', name: 'B', ...computePayrollItem(30000) },
  ];
  const t = payrollTotals(items);
  const { lines } = buildPayrollEntry({ newId: ids(), config, items });
  assert.equal(debitTotal(lines), creditTotal(lines));
  // Debit = gross + employer SS + employer INFOTEP
  assert.equal(debitTotal(lines), round2(t.gross + t.employerSs + t.employerInfotep));
  assert.equal(lines.find((l) => l.accountCode === M.salaries).debit, t.gross);
  assert.equal(lines.find((l) => l.accountCode === M.payrollPayable).credit, t.net);
  assert.equal(lines.find((l) => l.accountCode === M.isrWithheld).credit, t.isr);
});

test('buildPayrollEntry rejects an empty run', () => {
  assert.throws(() => buildPayrollEntry({ newId: ids(), config, items: [] }), /no tiene montos/);
});

test('ratesForPeriod picks the TSS topes in force by SMC step', () => {
  // Feb-2026 onward: SMC 23,223 → caps 10×/20×/4×.
  const r26 = ratesForPeriod(2026, 2);
  assert.equal(r26.smc, 23223.00);
  assert.equal(r26.sfsSalaryCap, round2(23223 * 10));
  assert.equal(r26.afpSalaryCap, round2(23223 * 20));
  assert.equal(r26.srlSalaryCap, round2(23223 * 4));
  // The current DR_PAYROLL defaults equal the Feb-2026 topes.
  assert.equal(r26.afpSalaryCap, DR_PAYROLL.afpSalaryCap);
  // Apr-2025..Jan-2026: SMC 21,674.80.
  assert.equal(ratesForPeriod(2025, 4).smc, 21674.80);
  assert.equal(ratesForPeriod(2025, 4).sfsSalaryCap, round2(21674.80 * 10));
  // A Jan-2025 run still uses the 2024 SMC (the Apr-2025 step hasn't hit yet).
  assert.equal(ratesForPeriod(2025, 1).smc, 19351.50);
  assert.equal(ratesForPeriod(2024, 6).smc, 19351.50);
});

test('overtimePay applies the Código surcharge multipliers', () => {
  const s = 50000;
  const hourly = s / MONTHLY_HOURS;
  assert.equal(overtimePay(s, { ot35: 10 }), round2(10 * hourly * PREMIUM_FACTOR.ot35));
  assert.equal(overtimePay(s, { ot100: 4 }), round2(4 * hourly * PREMIUM_FACTOR.ot100));
  assert.equal(overtimePay(s, { night: 20 }), round2(20 * hourly * PREMIUM_FACTOR.night));
  // ot35 is 1.35× (the whole extra hour at +35%), night is a 0.15× surcharge.
  assert.equal(PREMIUM_FACTOR.ot35, 1.35);
  assert.equal(PREMIUM_FACTOR.night, 0.15);
});

test('computePayrollItem folds taxable+cotizable overtime into gross/TSS/ISR', () => {
  const ot = overtimePay(50000, { ot35: 10 });
  const it = computePayrollItem(50000, { earnings: [{ amount: ot, taxable: true, cotizable: true }] });
  assert.equal(it.earnings, round2(ot));
  assert.equal(it.gross, round2(50000 + ot));
  // Deductions are taken on the (uncapped here) cotizable base = salary + ot.
  const sfsEmp = round2((50000 + ot) * DR_PAYROLL.sfsEmp / 100);
  const afpEmp = round2((50000 + ot) * DR_PAYROLL.afpEmp / 100);
  assert.equal(it.sfsEmp, sfsEmp);
  assert.equal(it.net, round2(it.gross - sfsEmp - afpEmp - it.isr));
  // More taxable pay than the plain line → strictly more ISR.
  assert.ok(it.isr > computePayrollItem(50000).isr);
});

test('computePayrollItem: a bono is taxable but NOT cotizable (out of TSS base)', () => {
  const it = computePayrollItem(50000, { earnings: [{ amount: 10000, taxable: true, cotizable: false }] });
  // TSS deductions stay on the 50k salary (bono excluded from salario cotizable)…
  assert.equal(it.sfsEmp, round2(50000 * DR_PAYROLL.sfsEmp / 100));
  // …but the bono lifts gross and the ISR base.
  assert.equal(it.gross, 60000);
  assert.ok(it.isr > computePayrollItem(50000).isr);
});

test('computePayrollItem: unpaid absence reduces earned salary', () => {
  const it = computePayrollItem(50000, { absenceDays: 2 });
  const earned = round2(50000 - round2((50000 / DAILY_DIVISOR) * 2));
  assert.equal(it.gross, earned);
  assert.ok(it.gross < 50000);
  assert.equal(it.net, round2(it.gross - it.sfsEmp - it.afpEmp - it.isr));
});

test('other deductions reduce net and the asiento still balances', () => {
  const it = computePayrollItem(50000, { deductions: [{ label: 'Préstamo', amount: 3000 }] });
  assert.equal(it.otherDeductions, 3000);
  assert.equal(it.net, round2(50000 - it.sfsEmp - it.afpEmp - it.isr - 3000));
  const items = [{ employeeId: 'e1', name: 'A', ...it }];
  const t = payrollTotals(items);
  assert.equal(t.otherDeductions, 3000);
  const { lines } = buildPayrollEntry({ newId: ids(), config, items });
  assert.equal(debitTotal(lines), creditTotal(lines));
  // The withholding books to the payroll-deductions account.
  assert.equal(lines.find((l) => l.accountCode === M.payrollDeductions).credit, 3000);
});

test('buildRegaliaEntry balances (exempt: no TSS, ISR only on excess)', () => {
  const { lines } = buildRegaliaEntry({ newId: ids(), config, gross: 30000 });
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === M.salaries).debit, 30000);
  assert.equal(lines.find((l) => l.accountCode === M.payrollPayable).credit, 30000);
  // With a voluntary excess taxed, the ISR is withheld from the net.
  const big = buildRegaliaEntry({ newId: ids(), config, gross: 30000, isr: 2000 });
  assert.equal(debitTotal(big.lines), creditTotal(big.lines));
  assert.equal(big.lines.find((l) => l.accountCode === M.payrollPayable).credit, 28000);
  assert.throws(() => buildRegaliaEntry({ newId: ids(), config, gross: 0 }), /no tiene montos/);
});

test('buildLiquidacionEntry splits indemnities vs salaries and balances', () => {
  const { lines } = buildLiquidacionEntry({ newId: ids(), config, indemnities: 50000, salaryItems: 10000 });
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === M.laborIndemnities).debit, 50000);
  assert.equal(lines.find((l) => l.accountCode === M.salaries).debit, 10000);
  assert.equal(lines.find((l) => l.accountCode === M.payrollPayable).credit, 60000);
});

test('buildBonificacionEntry withholds ISR + 0.5% INFOTEP and balances', () => {
  const { lines } = buildBonificacionEntry({ newId: ids(), config, gross: 20000, isr: 1000, infotep: 100 });
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === M.salaries).debit, 20000);
  assert.equal(lines.find((l) => l.accountCode === M.payrollPayable).credit, 18900);
  assert.equal(lines.find((l) => l.accountCode === M.infotepPayable).credit, 100);
});

// local helper mirroring round2 for expected values
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
