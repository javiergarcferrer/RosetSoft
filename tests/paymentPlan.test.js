/**
 * Pins the payment-plan amortization Model (src/lib/paymentPlan.ts).
 *
 * The dealer takes a 50% down payment and finances the rest as N equal monthly
 * cuotas ("cuota fija") at a monthly interest rate. These tests pin the money
 * invariants so a future refactor can't quietly change what a client owes:
 *   • the annuity (cuota fija) formula for the fixed monthly payment,
 *   • per-month interest accrues on the OUTSTANDING balance,
 *   • Σ capital === financed and the schedule closes to a zero balance (all
 *     rounding drift lands on the LAST cuota),
 *   • the 0%-rate edge degrades to a flat principal split,
 *   • monthly due dates step one calendar month from the first.
 * A red here means fix the builder, never relax the test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { amortize, addMonths } from '../src/lib/paymentPlan.js';

const FIRST_DUE = Date.parse('2026-07-01T00:00:00-04:00');

test('50% down + financed remainder', () => {
  const s = amortize({ totalUsd: 10000, monthlyRatePct: 2, installmentCount: 6, firstDueAt: FIRST_DUE });
  assert.equal(s.downPaymentPct, 50);
  assert.equal(s.downPaymentUsd, 5000);
  assert.equal(s.financedUsd, 5000);
  assert.equal(s.installmentCount, 6);
  assert.equal(s.installments.length, 6);
});

test('cuota fija matches the annuity formula', () => {
  // P=5000, i=0.02, n=6 → P*i/(1-(1+i)^-n) = 892.63 (to cents)
  const s = amortize({ totalUsd: 10000, monthlyRatePct: 2, installmentCount: 6, firstDueAt: FIRST_DUE });
  assert.equal(s.monthlyUsd, 892.63);
  // Every cuota except (possibly) the last equals the fixed monthly amount.
  for (const r of s.installments.slice(0, -1)) assert.equal(r.amount, 892.63);
});

test('first month interest is balance × rate, rest amortizes principal', () => {
  const s = amortize({ totalUsd: 10000, monthlyRatePct: 2, installmentCount: 6, firstDueAt: FIRST_DUE });
  const first = s.installments[0];
  assert.equal(first.interest, 100); // 5000 * 0.02
  assert.equal(first.capital, 792.63); // 892.63 - 100
  assert.equal(first.balanceAfter, 4207.37);
});

test('Σ capital === financed and the schedule closes to zero', () => {
  const s = amortize({ totalUsd: 7777.77, monthlyRatePct: 1.75, installmentCount: 9, firstDueAt: FIRST_DUE });
  const sumCapital = s.installments.reduce((a, r) => a + r.capital, 0);
  assert.ok(Math.abs(sumCapital - s.financedUsd) < 0.005, `Σcapital ${sumCapital} ≠ financed ${s.financedUsd}`);
  assert.equal(s.installments.at(-1).balanceAfter, 0);
});

test('Σ amount === financed + total interest', () => {
  const s = amortize({ totalUsd: 12345, monthlyRatePct: 3, installmentCount: 12, firstDueAt: FIRST_DUE });
  const sumAmount = s.installments.reduce((a, r) => a + r.amount, 0);
  assert.ok(Math.abs(sumAmount - s.totalFinancedToPayUsd) < 0.005);
  assert.ok(Math.abs(s.totalFinancedToPayUsd - (s.financedUsd + s.totalInterestUsd)) < 0.005);
  assert.ok(Math.abs(s.grandTotalToPayUsd - (s.downPaymentUsd + s.totalFinancedToPayUsd)) < 0.005);
});

test('0% rate degrades to a flat principal split', () => {
  const s = amortize({ totalUsd: 6000, monthlyRatePct: 0, installmentCount: 5, firstDueAt: FIRST_DUE });
  assert.equal(s.financedUsd, 3000);
  assert.equal(s.monthlyUsd, 600);
  assert.equal(s.totalInterestUsd, 0);
  for (const r of s.installments) {
    assert.equal(r.interest, 0);
    assert.equal(r.amount, 600);
  }
  assert.equal(s.installments.at(-1).balanceAfter, 0);
});

test('rounding drift lands on the last cuota only', () => {
  // 100/3 doesn't divide evenly → last row absorbs the cent.
  const s = amortize({ totalUsd: 200, monthlyRatePct: 0, installmentCount: 3, firstDueAt: FIRST_DUE });
  assert.equal(s.financedUsd, 100);
  assert.equal(s.installments[0].amount, 33.33);
  assert.equal(s.installments[1].amount, 33.33);
  assert.equal(s.installments[2].amount, 33.34); // drift here
  assert.equal(s.installments.at(-1).balanceAfter, 0);
});

test('due dates step one calendar month from the first', () => {
  const s = amortize({ totalUsd: 1000, monthlyRatePct: 1, installmentCount: 3, firstDueAt: FIRST_DUE });
  assert.equal(s.installments[0].dueAt, FIRST_DUE);
  assert.equal(s.installments[1].dueAt, addMonths(FIRST_DUE, 1));
  assert.equal(s.installments[2].dueAt, addMonths(FIRST_DUE, 2));
});

test('addMonths clamps the day to the target month length', () => {
  const jan31 = Date.parse('2026-01-31T00:00:00-04:00');
  const feb = new Date(addMonths(jan31, 1));
  assert.equal(feb.getMonth(), 1); // February, not spilled into March
});
