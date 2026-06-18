// ViewModel for the per-quote payment plan + contract.
//
// Pure projection (no React/db): turns a stored PaymentPlan row into exactly
// what the dealer's PaymentPlanCard, the public contract link, and the contract
// PDF render — the amortized rows decorated with paid/overdue state and DOP
// figures (at the rate the caller passes), plus a roll-up summary and the
// contract's signed state. The schedule math itself lives in lib/paymentPlan
// (`amortize`, pinned by tests/paymentPlan.test.js); this only decorates it.

import { amortize } from '../../../lib/paymentPlan.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Build a fresh schedule from plan parameters — used by the create/edit form to
 * preview before saving. Thin pass-through to the Model so the form, the saved
 * row, and the PDF all agree.
 */
export function buildPlanSchedule({ totalUsd, downPaymentPct = 50, monthlyRatePct, installmentCount, firstDueAt }) {
  return amortize({ totalUsd, downPaymentPct, monthlyRatePct, installmentCount, firstDueAt });
}

/** Per-row state for the schedule table. */
function installmentState(row, now) {
  if (row.paidAt) return 'paid';
  if (row.dueAt && row.dueAt < now) return 'overdue';
  if (row.dueAt && row.dueAt < now + 7 * DAY) return 'due-soon';
  return 'pending';
}

/**
 * Project a PaymentPlan into the render-ready shape.
 *
 * @param {object} plan   the stored PaymentPlan row (schedule already built).
 * @param {object} opts   { rate: DOP-per-USD, now: ms }.
 * @returns null when there's no plan, else the decorated view.
 */
export function resolvePaymentPlanView(plan, { rate = 0, now = Date.now() } = {}) {
  if (!plan) return null;
  const toDop = (usd) => (rate ? Number(usd || 0) * rate : 0);
  const schedule = Array.isArray(plan.schedule) ? plan.schedule : [];

  const installments = schedule.map((row) => {
    const state = installmentState(row, now);
    return {
      ...row,
      state,
      isPaid: state === 'paid',
      isOverdue: state === 'overdue',
      amountDop: toDop(row.amount),
      capitalDop: toDop(row.capital),
      interestDop: toDop(row.interest),
    };
  });

  const paidUsd = installments.filter((r) => r.isPaid).reduce((s, r) => s + Number(r.amount || 0), 0);
  const financedToPayUsd = installments.reduce((s, r) => s + Number(r.amount || 0), 0);
  const outstandingUsd = round2(financedToPayUsd - paidUsd);
  const overdueCount = installments.filter((r) => r.isOverdue).length;
  const next = installments.find((r) => !r.isPaid) || null;

  return {
    id: plan.id,
    quoteId: plan.quoteId ?? null,
    status: plan.status,
    rate,
    // Headline figures (USD + DOP).
    totalUsd: plan.totalUsd,
    totalDop: toDop(plan.totalUsd),
    downPaymentPct: plan.downPaymentPct,
    downPaymentUsd: plan.downPaymentUsd,
    downPaymentDop: toDop(plan.downPaymentUsd),
    financedUsd: plan.financedUsd,
    financedDop: toDop(plan.financedUsd),
    monthlyRatePct: plan.monthlyRatePct,
    installmentCount: plan.installmentCount,
    monthlyUsd: installments[0]?.amount ?? 0,
    monthlyDop: toDop(installments[0]?.amount ?? 0),
    totalInterestUsd: round2(installments.reduce((s, r) => s + Number(r.interest || 0), 0)),
    financedToPayUsd: round2(financedToPayUsd),
    grandTotalToPayUsd: round2(Number(plan.downPaymentUsd || 0) + financedToPayUsd),
    // Progress.
    installments,
    paidUsd: round2(paidUsd),
    paidDop: toDop(paidUsd),
    outstandingUsd,
    outstandingDop: toDop(outstandingUsd),
    paidCount: installments.filter((r) => r.isPaid).length,
    overdueCount,
    nextDue: next ? { n: next.n, dueAt: next.dueAt, amount: next.amount, amountDop: next.amountDop } : null,
    // Contract / signing.
    contractBody: plan.contractBody ?? '',
    shareToken: plan.shareToken ?? null,
    shareEnabled: !!plan.shareEnabled,
    isSigned: !!plan.signedAt,
    signedAt: plan.signedAt ?? null,
    signerName: plan.signerName ?? null,
    signerDoc: plan.signerDoc ?? null,
    signatureImageId: plan.signatureImageId ?? null,
    signedPdfPath: plan.signedPdfPath ?? null,
  };
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}
