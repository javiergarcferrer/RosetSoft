/**
 * Tests for the DR labor-entitlements Model (src/lib/accounting/prestaciones.ts)
 * — the regalía pascual, vacaciones, the preaviso/cesantía/asistencia day
 * schedules, and the full liquidación roll-up with its ISR-exempt vs taxable
 * split. These pin the Código de Trabajo constants the calculators depend on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dailyWage, vacationDays, vacationProportionalDays, vacationPay, regaliaPascual,
  monthsOfService, preavisoDays, cesantiaDays, asistenciaEconomicaDays, liquidacion,
} from '../src/lib/accounting/prestaciones.js';
import { DAILY_DIVISOR } from '../src/lib/accounting/payroll.js';

test('dailyWage divides the monthly salary by 23.83', () => {
  assert.equal(DAILY_DIVISOR, 23.83);
  assert.equal(dailyWage(30000), round2(30000 / 23.83));
});

test('vacationDays: 14 at 1–5 yrs, 18 at 5+, none before a year (Art. 177)', () => {
  assert.equal(vacationDays(0), 0);
  assert.equal(vacationDays(1), 14);
  assert.equal(vacationDays(4), 14);
  assert.equal(vacationDays(5), 18);
  assert.equal(vacationDays(12), 18);
});

test('vacationProportionalDays: the Art. 180 first-year table', () => {
  assert.equal(vacationProportionalDays(4), 0);
  assert.equal(vacationProportionalDays(5), 6);
  assert.equal(vacationProportionalDays(6), 7);
  assert.equal(vacationProportionalDays(11), 12);
  assert.equal(vacationProportionalDays(12), 14);
});

test('vacationPay = daily wage × days', () => {
  assert.equal(vacationPay(30000, 14), round2(dailyWage(30000) * 14));
});

test('regaliaPascual: 1/12 of YTD ordinary, exempt up to that, excess taxable', () => {
  const r = regaliaPascual(120000);
  assert.equal(r.legal, 10000);
  assert.equal(r.amount, 10000);
  assert.equal(r.isrExempt, 10000);
  assert.equal(r.isrTaxable, 0);
  // A voluntary "doble sueldo" above 1/12 → the excess is taxable.
  const big = regaliaPascual(120000, 15000);
  assert.equal(big.isrExempt, 10000);
  assert.equal(big.isrTaxable, 5000);
});

test('monthsOfService counts completed months', () => {
  assert.equal(monthsOfService(new Date(2024, 0, 15).getTime(), new Date(2025, 0, 15).getTime()), 12);
  assert.equal(monthsOfService(new Date(2024, 0, 15).getTime(), new Date(2025, 0, 14).getTime()), 11);
  assert.equal(monthsOfService(new Date(2024, 0, 1).getTime(), new Date(2024, 6, 1).getTime()), 6);
});

test('preavisoDays: flat schedule (Art. 76)', () => {
  assert.equal(preavisoDays(2), 0);
  assert.equal(preavisoDays(3), 7);
  assert.equal(preavisoDays(6), 14);
  assert.equal(preavisoDays(12), 28);
  assert.equal(preavisoDays(60), 28);
});

test('cesantiaDays: 6/13 first year, then 21/yr (≤5) or 23/yr (>5) (Art. 80)', () => {
  assert.equal(cesantiaDays(2), 0);
  assert.equal(cesantiaDays(3), 6);
  assert.equal(cesantiaDays(6), 13);
  assert.equal(cesantiaDays(11), 13);
  assert.equal(cesantiaDays(12), 21);          // 1 year → 21
  assert.equal(cesantiaDays(60), round2(21 * 5)); // 5 years → 105
  assert.equal(cesantiaDays(72), round2(23 * 6)); // 6 years (>5) → 138
});

test('asistenciaEconomicaDays: the no-fault scale (Art. 82)', () => {
  assert.equal(asistenciaEconomicaDays(2), 0);
  assert.equal(asistenciaEconomicaDays(3), 5);
  assert.equal(asistenciaEconomicaDays(6), 10);
  assert.equal(asistenciaEconomicaDays(12), 15);
  assert.equal(asistenciaEconomicaDays(24), 30);
});

test('liquidacion: employer desahucio owes preaviso + cesantía + derechos', () => {
  const l = liquidacion({
    monthlySalary: 30000,
    startMs: new Date(2023, 0, 1).getTime(),
    endMs: new Date(2025, 0, 1).getTime(), // 24 months
    terminationType: 'desahucio',
    initiatedBy: 'employer',
    ordinaryEarnedYTD: 360000, // full prior year → regalía 30,000 (exempt)
    pendingVacationDays: 14,
  });
  const daily = dailyWage(30000);
  assert.equal(l.months, 24);
  assert.equal(l.preavisoDays, 28);
  assert.equal(l.cesantiaDays, round2(21 * 2)); // 2 yrs → 42
  assert.equal(l.preaviso, round2(daily * 28));
  assert.equal(l.cesantia, round2(daily * 42));
  assert.equal(l.vacaciones, round2(daily * 14));
  assert.equal(l.regalia, 30000);
  // preaviso + cesantía + exempt regalía are ISR/TSS-exempt; vacaciones taxable.
  assert.equal(l.exempt, round2(l.preaviso + l.cesantia + 30000));
  assert.equal(l.taxable, l.vacaciones);
  assert.equal(l.total, round2(l.preaviso + l.cesantia + l.vacaciones + 30000));
});

test('liquidacion: worker desahucio owes NO cesantía, only derechos adquiridos', () => {
  const l = liquidacion({
    monthlySalary: 30000,
    startMs: new Date(2023, 0, 1).getTime(),
    endMs: new Date(2025, 0, 1).getTime(),
    terminationType: 'desahucio',
    initiatedBy: 'worker',
    ordinaryEarnedYTD: 360000,
    pendingVacationDays: 14,
  });
  assert.equal(l.preaviso, 0);
  assert.equal(l.cesantia, 0);
  assert.ok(l.vacaciones > 0);
  assert.equal(l.regalia, 30000);
});

test('liquidacion: just-cause dismissal pays only derechos adquiridos', () => {
  const l = liquidacion({
    monthlySalary: 30000,
    startMs: new Date(2023, 0, 1).getTime(),
    endMs: new Date(2025, 0, 1).getTime(),
    terminationType: 'despido_justificado',
    ordinaryEarnedYTD: 360000,
    pendingVacationDays: 14,
  });
  assert.equal(l.preaviso, 0);
  assert.equal(l.cesantia, 0);
  assert.equal(l.asistencia, 0);
  assert.ok(l.vacaciones > 0 && l.regalia > 0);
});

test('liquidacion: no-fault termination pays asistencia económica, not cesantía', () => {
  const l = liquidacion({
    monthlySalary: 30000,
    startMs: new Date(2023, 0, 1).getTime(),
    endMs: new Date(2025, 0, 1).getTime(),
    terminationType: 'no_fault',
    ordinaryEarnedYTD: 360000,
  });
  assert.equal(l.cesantia, 0);
  assert.equal(l.asistenciaDays, 30); // 24 months → 15 × 2
  assert.equal(l.asistencia, round2(dailyWage(30000) * 30));
});

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
