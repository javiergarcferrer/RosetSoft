// Receivables / payables ViewModels — open balances, FIFO aging, and per-party
// statements (estado de cuenta). Pure: no React, no db.
import { round2 } from '../../lib/accounting/ledger.js';
import { paymentNet } from '../../lib/accounting/payment.js';

function ageBucket(days) {
  if (days <= 30) return 'd0_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90';
}

/**
 * Per-party balance + FIFO aging. `charges` and `payments` are
 * `[{ partyId, date, amount }]`; payments are applied to the oldest charges
 * first so the open remainder ages correctly.
 */
function ageParties(charges, payments, asOf) {
  const now = asOf || Date.now();
  const byParty = new Map();
  const ensure = (id) => {
    if (!byParty.has(id)) byParty.set(id, { charges: [], paid: 0 });
    return byParty.get(id);
  };
  for (const c of charges) { if (c.partyId) ensure(c.partyId).charges.push({ date: c.date, amount: round2(c.amount) }); }
  for (const p of payments) { if (p.partyId) ensure(p.partyId).paid += round2(p.amount); }

  const out = new Map();
  for (const [partyId, { charges: chs, paid }] of byParty) {
    const sorted = chs.slice().sort((a, b) => (a.date || 0) - (b.date || 0));
    let remaining = round2(paid);
    const buckets = { d0_30: 0, d31_60: 0, d61_90: 0, d90: 0 };
    let invoiced = 0;
    for (const ch of sorted) {
      invoiced = round2(invoiced + ch.amount);
      let open = ch.amount;
      if (remaining > 0) {
        const applied = Math.min(open, remaining);
        open = round2(open - applied);
        remaining = round2(remaining - applied);
      }
      if (open > 0.001) {
        const days = Math.floor((now - (ch.date || 0)) / 86_400_000);
        const k = ageBucket(days);
        buckets[k] = round2(buckets[k] + open);
      }
    }
    out.set(partyId, { invoiced, paid: round2(paid), balance: round2(invoiced - paid), buckets });
  }
  return out;
}

function rollup(rows) {
  const t = rows.reduce((a, r) => ({
    invoiced: a.invoiced + r.invoiced, paid: a.paid + r.paid, balance: a.balance + r.balance,
    d0_30: a.d0_30 + r.buckets.d0_30, d31_60: a.d31_60 + r.buckets.d31_60,
    d61_90: a.d61_90 + r.buckets.d61_90, d90: a.d90 + r.buckets.d90,
  }), { invoiced: 0, paid: 0, balance: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90: 0 });
  for (const k of Object.keys(t)) t[k] = round2(t[k]);
  return t;
}

/** Cuentas por cobrar — open balance + aging per customer. */
export function resolveReceivables({ salesPostings, payments, customersById, asOf } = {}) {
  const charges = (salesPostings || [])
    .map((s) => ({ partyId: s.customerId, date: s.postedAt, amount: round2((s.total || 0) - (s.depositApplied || 0)) }))
    .filter((c) => c.amount > 0.001);
  const pays = (payments || [])
    .filter((p) => p.direction === 'in' && p.partyType === 'customer')
    .map((p) => ({ partyId: p.partyId, date: p.paidAt, amount: p.amount }));
  const aged = ageParties(charges, pays, asOf);
  const rows = [...aged.entries()]
    .map(([id, v]) => ({ partyId: id, party: (customersById && customersById.get(id)) || null, ...v }))
    .filter((r) => Math.abs(r.balance) > 0.001)
    .sort((a, b) => b.balance - a.balance);
  return { rows, totals: rollup(rows), count: rows.length };
}

/** Cuentas por pagar — open balance + aging per supplier (credit docs only). */
export function resolvePayables({ purchases, expenses, payments, suppliersById, asOf } = {}) {
  const credit = (arr, dateField) => (arr || [])
    .filter((d) => d.paymentMethod === 'credit')
    .map((d) => ({
      partyId: d.supplierId, date: d[dateField],
      amount: round2((d.base || 0) + (d.itbis || 0) - (d.retentionIsr || 0) - (d.retentionItbis || 0)),
    }));
  const charges = [...credit(purchases, 'purchaseAt'), ...credit(expenses, 'expenseAt')].filter((c) => c.amount > 0.001);
  const pays = (payments || [])
    .filter((p) => p.direction === 'out' && p.partyType === 'supplier')
    .map((p) => ({ partyId: p.partyId, date: p.paidAt, amount: p.amount }));
  const aged = ageParties(charges, pays, asOf);
  const rows = [...aged.entries()]
    .map(([id, v]) => ({ partyId: id, party: (suppliersById && suppliersById.get(id)) || null, ...v }))
    .filter((r) => Math.abs(r.balance) > 0.001)
    .sort((a, b) => b.balance - a.balance);
  return { rows, totals: rollup(rows), count: rows.length };
}

/**
 * Estado de cuenta — chronological charges (+) and payments (−) for one party,
 * with a running balance.
 */
export function resolvePartyStatement({ charges, payments } = {}) {
  const rows = [
    ...(charges || []).map((c) => ({ date: c.date, label: c.label || 'Cargo', ref: c.ref || '', charge: round2(c.amount), payment: 0 })),
    ...(payments || []).map((p) => ({ date: p.date, label: p.label || 'Pago', ref: p.ref || '', charge: 0, payment: round2(p.amount) })),
  ].sort((a, b) => (a.date || 0) - (b.date || 0));
  let bal = 0;
  for (const r of rows) { bal = round2(bal + r.charge - r.payment); r.balance = bal; }
  return { rows, balance: bal };
}

// Re-export so the page can show the deposited-net on a card cobro.
export { paymentNet };
