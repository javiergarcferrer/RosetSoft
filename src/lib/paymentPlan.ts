// Payment-plan amortization — the pure Model behind per-quote financing.
//
// The dealer always takes a 50% down payment and finances the rest as N equal
// monthly cuotas ("cuota fija" / French amortization) at a monthly interest
// rate. This module turns the quote's grand total + the plan parameters into a
// fully-built schedule; it is pure (no React/db/dates-as-side-effects) so it can
// be pinned by tests/paymentPlan.test.js and reused by the ViewModel, the PDF,
// and the public contract link alike.
//
// Money invariant (pinned): the financed principal is split into a fixed monthly
// payment via the annuity formula; per-month interest accrues on the OUTSTANDING
// balance and the rest amortizes principal. Rounding to cents accumulates onto
// the LAST cuota so the schedule closes to a zero balance exactly (Σ capital =
// financed, Σ amount = financed + Σ interest). Never relax the test to match a
// drifting builder — fix the builder.

export interface PaymentPlanParams {
  /** Quote grand total being financed, in USD (base + the dealer's terms). */
  totalUsd: number;
  /** Down-payment share, 0–100. Defaults to 50 (the dealer's standing policy). */
  downPaymentPct?: number;
  /** Monthly interest rate as a percent (e.g. 2.5 ⇒ 2.5%/month). 0 ⇒ no interest. */
  monthlyRatePct: number;
  /** Number of monthly installments financing the balance (≥ 1). */
  installmentCount: number;
  /** Due date of the FIRST installment, as a JS-ms timestamp. */
  firstDueAt: number;
}

export interface PaymentPlanInstallment {
  /** 1-based installment index. */
  n: number;
  /** Due date as a JS-ms timestamp (monthly increments from firstDueAt). */
  dueAt: number;
  /** Interest portion of this cuota, USD. */
  interest: number;
  /** Principal portion of this cuota, USD. */
  capital: number;
  /** Total cuota (capital + interest), USD. */
  amount: number;
  /** Outstanding financed balance AFTER this cuota, USD (last row ⇒ 0). */
  balanceAfter: number;
}

export interface PaymentPlanSchedule {
  totalUsd: number;
  downPaymentPct: number;
  downPaymentUsd: number;
  financedUsd: number;
  monthlyRatePct: number;
  installmentCount: number;
  /** The fixed monthly cuota (the last row may differ by the rounding drift). */
  monthlyUsd: number;
  installments: PaymentPlanInstallment[];
  totalInterestUsd: number;
  /** financed + interest = what the client pays across the installments. */
  totalFinancedToPayUsd: number;
  /** down payment + financed-to-pay = the grand total the client pays. */
  grandTotalToPayUsd: number;
}

/** Round to cents (2 decimals), avoiding binary-float drift on the boundary. */
function cents(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Add `months` calendar months to a JS-ms timestamp, clamping the day so e.g.
 * Jan 31 + 1 month = Feb 28/29 (never spilling into March). Mirrors how a human
 * reads "same day next month".
 */
export function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getDate();
  const target = new Date(d.getTime());
  target.setDate(1);
  target.setMonth(target.getMonth() + months);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target.getTime();
}

/**
 * Build the full amortization schedule for a financed quote. Pure: same input ⇒
 * same output. The down payment is taken up front (not an installment); the
 * remaining balance amortizes over `installmentCount` equal monthly cuotas at
 * `monthlyRatePct`. With a 0% rate this degrades to equal principal splits.
 */
export function amortize(params: PaymentPlanParams): PaymentPlanSchedule {
  const totalUsd = Math.max(0, Number(params.totalUsd) || 0);
  const downPaymentPct = clampPct(params.downPaymentPct ?? 50);
  const count = Math.max(1, Math.floor(Number(params.installmentCount) || 1));
  const monthlyRatePct = Math.max(0, Number(params.monthlyRatePct) || 0);
  const i = monthlyRatePct / 100;

  const downPaymentUsd = cents((totalUsd * downPaymentPct) / 100);
  const financedUsd = cents(totalUsd - downPaymentUsd);

  // Fixed monthly cuota via the annuity formula; flat split when there's no
  // interest. Rounded to cents — the per-row build below reconciles the drift.
  const rawCuota = i === 0
    ? financedUsd / count
    : (financedUsd * i) / (1 - Math.pow(1 + i, -count));
  const monthlyUsd = cents(rawCuota);

  const installments: PaymentPlanInstallment[] = [];
  let balance = financedUsd;
  for (let n = 1; n <= count; n += 1) {
    const interest = cents(balance * i);
    const isLast = n === count;
    // The final cuota clears whatever balance remains (absorbing all rounding
    // drift) so the schedule closes to exactly zero.
    const capital = isLast ? cents(balance) : cents(monthlyUsd - interest);
    const amount = cents(capital + interest);
    balance = cents(balance - capital);
    installments.push({
      n,
      dueAt: addMonths(params.firstDueAt, n - 1),
      interest,
      capital,
      amount,
      balanceAfter: balance < 0 ? 0 : balance,
    });
  }

  const totalInterestUsd = cents(installments.reduce((s, r) => s + r.interest, 0));
  const totalFinancedToPayUsd = cents(financedUsd + totalInterestUsd);
  const grandTotalToPayUsd = cents(downPaymentUsd + totalFinancedToPayUsd);

  return {
    totalUsd,
    downPaymentPct,
    downPaymentUsd,
    financedUsd,
    monthlyRatePct,
    installmentCount: count,
    monthlyUsd,
    installments,
    totalInterestUsd,
    totalFinancedToPayUsd,
    grandTotalToPayUsd,
  };
}

function clampPct(n: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 50;
  return Math.min(100, Math.max(0, v));
}
