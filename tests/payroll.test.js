/**
 * Tests for the payroll Model (src/lib/accounting/payroll.ts) — the DR ISR
 * scale, per-employee deductions, and the balanced nómina asiento.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccountingConfig } from '../src/lib/accounting/config.js';
import {
  annualIsr, monthlyIsr, computePayrollItem, payrollTotals, buildPayrollEntry, DR_PAYROLL,
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
  // net = gross − (sfsEmp+afpEmp) − isr
  assert.equal(it.net, round2(50000 - it.sfsEmp - it.afpEmp - it.isr));
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

// local helper mirroring round2 for expected values
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
