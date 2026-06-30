/**
 * Pins the payment-plan ViewModel's CONTRACT-BODY congruency
 * (src/core/quote/views/paymentPlan.js).
 *
 * The contract's prose description must never drift from the schedule. It used to
 * be frozen as text on first save, so editing the stages (50/20/20/10 → 50/25/25)
 * changed the numbers but left the paragraph claiming the old split. The fix
 * DERIVES the description from the plan unless the dealer typed an override
 * (`contractBodyCustom`) or the contract is already signed (the agreed text).
 *
 * A red here means fix the deriver / resolver, not the test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultContractBody, resolvePaymentPlanView } from '../src/core/quote/views/paymentPlan.js';

const customPlan = (stages, extra = {}) => ({
  id: 'pp1', number: 1011, scheduleMode: 'custom',
  totalUsd: 31657.04,
  schedule: stages.map((pct, i) => ({ n: i + 1, pct, amount: 0, capital: 0, interest: 0, balanceAfter: 0, dueAt: 0 })),
  installmentCount: stages.length,
  ...extra,
});

test('custom description enumerates the ACTUAL stages, not a frozen snapshot', () => {
  const body = defaultContractBody(customPlan([50, 25, 25]));
  assert.match(body, /en 3 pagos por etapas \(50% \/ 25% \/ 25%\)/);
  assert.match(body, /cotización Nº 1011/);
});

test('the reported bug: a 4-split frozen body is ignored for a 3-split plan', () => {
  // The drifted row as it lives in the DB: legacy text from when it was
  // 50/20/20/10, but the schedule is now 50/25/25 and the override flag is off.
  const drifted = customPlan([50, 25, 25], {
    contractBody: 'El cliente acuerda adquirir los bienes detallados en la cotización Nº 1011 '
      + 'y pagar su valor total en 4 pagos por etapas (50% / 20% / 20% / 10%), conforme al calendario.',
    contractBodyCustom: false,
  });
  const view = resolvePaymentPlanView(drifted, { rate: 60 });
  // Resolves to the derived, congruent text — the stale 4-split prose is dropped.
  assert.match(view.contractBody, /en 3 pagos por etapas \(50% \/ 25% \/ 25%\)/);
  assert.doesNotMatch(view.contractBody, /4 pagos/);
  assert.doesNotMatch(view.contractBody, /20%/);
});

test('a dealer override is honored verbatim', () => {
  const overridden = customPlan([50, 25, 25], {
    contractBody: 'Condiciones especiales acordadas con el cliente.',
    contractBodyCustom: true,
  });
  const view = resolvePaymentPlanView(overridden, { rate: 60 });
  assert.equal(view.contractBody, 'Condiciones especiales acordadas con el cliente.');
  assert.equal(view.contractBodyCustom, true);
});

test('a signed contract keeps its agreed text even without the custom flag', () => {
  const signed = customPlan([50, 25, 25], {
    contractBody: 'Texto exacto firmado por el cliente.',
    contractBodyCustom: false,
    signedAt: Date.parse('2026-01-15T12:00:00Z'),
  });
  const view = resolvePaymentPlanView(signed, { rate: 60 });
  assert.equal(view.contractBody, 'Texto exacto firmado por el cliente.');
});

test('amortized description derives down payment, cuotas and rate from the plan', () => {
  const body = defaultContractBody({
    number: 7, scheduleMode: 'amortized',
    downPaymentPct: 50, installmentCount: 6, monthlyRatePct: 2,
  });
  assert.match(body, /pago inicial del 50% y 6 cuotas mensuales con una tasa de interés del 2% mensual/);
});

test('singular phrasing for a one-stage / one-cuota plan', () => {
  assert.match(defaultContractBody(customPlan([100])), /en 1 pago por etapas \(100%\)/);
  assert.match(
    defaultContractBody({ number: 9, scheduleMode: 'amortized', downPaymentPct: 50, installmentCount: 1, monthlyRatePct: 0 }),
    /y 1 cuota mensual con/,
  );
});
