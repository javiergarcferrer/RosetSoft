// Caja chica (petty cash) ViewModels — the funds overview + one fund's movement
// ledger. Pure: no React, no db. The posting Model lives in lib/accounting/pettyCash.
import { round2 } from '../../lib/accounting/ledger.js';
import { pettyCashBalance, voucherCashDelta, VOUCHER_TYPE_LABEL } from '../../lib/accounting/pettyCash.js';

/** Fraction of the fondo fijo below which a fund is flagged "low on cash". */
const LOW_CASH_FRACTION = 0.2;

/**
 * Funds overview — one row per caja with its book balance, fondo fijo, the
 * amount needed to top it back up (`toReplenish`), what's been spent, and a
 * low-cash flag. Open funds first, then by name.
 */
export function resolveCajaChica({ funds, vouchers, asOf } = {}) {
  const byFund = new Map();
  for (const v of vouchers || []) {
    if (!byFund.has(v.fundId)) byFund.set(v.fundId, []);
    byFund.get(v.fundId).push(v);
  }
  const rows = (funds || []).map((f) => {
    const vs = byFund.get(f.id) || [];
    const balance = pettyCashBalance(vs);
    const fixedAmount = round2(f.fixedAmount || 0);
    const spent = round2(vs.filter((v) => v.type === 'expense').reduce((s, v) => s + (v.total || 0), 0));
    const lastCount = vs.filter((v) => v.type === 'adjustment').sort((a, b) => (b.voucherAt || 0) - (a.voucherAt || 0))[0] || null;
    return {
      fund: f,
      status: f.status || 'open',
      balance,
      fixedAmount,
      toReplenish: round2(Math.max(0, fixedAmount - balance)),
      spent,
      voucherCount: vs.length,
      lowOnCash: fixedAmount > 0 && balance < round2(fixedAmount * LOW_CASH_FRACTION),
      lastCountAt: lastCount ? lastCount.voucherAt || null : null,
    };
  }).sort((a, b) => (a.status === b.status
    ? (a.fund.name || '').localeCompare(b.fund.name || '')
    : (a.status === 'open' ? -1 : 1)));

  const totals = {
    balance: round2(rows.reduce((s, r) => s + r.balance, 0)),
    fixedAmount: round2(rows.reduce((s, r) => s + r.fixedAmount, 0)),
    toReplenish: round2(rows.reduce((s, r) => s + r.toReplenish, 0)),
    spent: round2(rows.reduce((s, r) => s + r.spent, 0)),
  };
  return { rows, totals, count: rows.length, asOf: asOf || null };
}

/**
 * One fund's movements with a running cash balance — a mini-kardex of the caja,
 * newest first. `delta` is the signed cash effect of each vale.
 */
export function resolveFundLedger({ fund, vouchers } = {}) {
  if (!fund) return null;
  const vs = (vouchers || [])
    .filter((v) => v.fundId === fund.id)
    .slice()
    .sort((a, b) => (a.voucherAt || 0) - (b.voucherAt || 0) || (a.createdAt || 0) - (b.createdAt || 0));
  let bal = 0;
  const rows = vs.map((v) => {
    const delta = voucherCashDelta(v);
    bal = round2(bal + delta);
    return { voucher: v, type: v.type, label: VOUCHER_TYPE_LABEL[v.type] || v.type, delta, balance: bal, ncf: v.ncf || null };
  });
  return { fund, rows: rows.reverse(), balance: bal, count: rows.length };
}
