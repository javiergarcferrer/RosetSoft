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

/**
 * The auto-generated contract paragraph that DESCRIBES the plan in prose, derived
 * from the plan itself so the words can never drift from the schedule.
 *
 * This is the congruency fix: the description used to be frozen as text on first
 * save, so editing the stages (e.g. 50/20/20/10 → 50/25/25) updated the schedule
 * but left the paragraph claiming the old split. Deriving it here — and having
 * every surface render this unless the dealer typed a custom override
 * (`contractBodyCustom`) — keeps the prose and the numbers in lockstep.
 */
export function defaultContractBody(plan) {
  if (!plan) return '';
  const number = plan.number ?? '';
  const head = `El cliente acuerda adquirir los bienes detallados en la cotización Nº ${number} `;
  const tail = `conforme al calendario de pagos detallado en este contrato. La entrega de los bienes se `
    + `realizará según las condiciones acordadas. El atraso en el pago de cualquier cuota podrá generar `
    + `cargos por mora.`;
  if (plan.scheduleMode === 'custom') {
    const stages = (Array.isArray(plan.schedule) ? plan.schedule : []).filter((s) => Number(s?.pct) > 0);
    const count = stages.length || Number(plan.installmentCount) || 0;
    const pcts = stages.map((s) => `${Number(s.pct) || 0}%`).join(' / ');
    return `${head}y pagar su valor total en ${count} ${count === 1 ? 'pago' : 'pagos'} por etapas (${pcts}), ${tail}`;
  }
  const count = Number(plan.installmentCount) || 0;
  const down = plan.downPaymentPct ?? 50;
  const rate = plan.monthlyRatePct ?? 0;
  return `${head}y pagar su valor total mediante un pago inicial del ${down}% y ${count} `
    + `${count === 1 ? 'cuota mensual' : 'cuotas mensuales'} con una tasa de interés del ${rate}% mensual, ${tail}`;
}

/**
 * The contract body a plan renders: a dealer override (or an already-signed
 * contract's agreed text) verbatim, otherwise the description derived from the
 * plan so it stays congruent with the schedule.
 */
function contractBodyFor(plan) {
  const stored = plan.contractBody ?? '';
  if ((plan.contractBodyCustom || plan.signedAt) && stored) return stored;
  return defaultContractBody(plan);
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

  const scheduleMode = plan.scheduleMode === 'custom' ? 'custom' : 'amortized';

  return {
    id: plan.id,
    quoteId: plan.quoteId ?? null,
    status: plan.status,
    scheduleMode,
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
    // Contract / signing. Derive the description from the plan (unless the dealer
    // overrode it or it's signed) so the prose can't drift from the schedule.
    contractBody: contractBodyFor(plan),
    contractBodyCustom: !!plan.contractBodyCustom,
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

/**
 * Collections board projection: every active plan with an outstanding balance,
 * decorated for the Contabilidad follow-up surface. Pure — the page fetches the
 * plans + customers and passes them in.
 *
 * @param {object} opts { plans, customersById (Map), rate, now }
 * @returns { rows, totals } — rows sorted by the most urgent (overdue, then
 *   soonest due); each row carries the decorated plan view + customer + the
 *   next-due / overdue summary.
 */
export function resolvePaymentPlanFollowUp({ plans = [], customersById = null, rate = 0, now = Date.now() } = {}) {
  const rows = plans
    .map((plan) => {
      const view = resolvePaymentPlanView(plan, { rate, now });
      if (!view) return null;
      const customer = customersById ? customersById.get(plan.customerId) || null : null;
      return {
        planId: plan.id,
        quoteId: plan.quoteId ?? null,
        number: plan.number ?? null,
        customer,
        customerName: customer?.name || '—',
        view,
        outstandingUsd: view.outstandingUsd,
        outstandingDop: view.outstandingDop,
        paidUsd: view.paidUsd,
        overdueCount: view.overdueCount,
        nextDue: view.nextDue,
        isSigned: view.isSigned,
        status: view.status,
      };
    })
    .filter((r) => r && r.status !== 'cancelled' && r.outstandingUsd > 0.005)
    .sort((a, b) => {
      // Overdue first, then by soonest next due date.
      if ((b.overdueCount > 0) !== (a.overdueCount > 0)) return b.overdueCount - a.overdueCount;
      return (a.nextDue?.dueAt || Infinity) - (b.nextDue?.dueAt || Infinity);
    });

  const totals = {
    count: rows.length,
    outstandingUsd: round2(rows.reduce((s, r) => s + r.outstandingUsd, 0)),
    outstandingDop: round2(rows.reduce((s, r) => s + r.outstandingDop, 0)),
    overdueCount: rows.reduce((s, r) => s + r.overdueCount, 0),
  };
  return { rows, totals };
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}
