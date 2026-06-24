// Receivables / payables ViewModels — open balances, FIFO aging, and per-party
// statements (estado de cuenta). Pure: no React, no db.
import { round2 } from '../../lib/accounting/ledger.js';
import { paymentNet } from '../../lib/accounting/payment.js';
import { isCreditNote } from '../../lib/accounting/ecf.js';

function ageBucket(days) {
  if (days <= 30) return 'd0_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90';
}

/**
 * Per-party balance + aging. Explicit invoice allocations are applied first
 * (a payment that names a doc settles that doc); the unallocated remainder of
 * each payment — plus any notas de crédito (passed as NEGATIVE charges) — is
 * then applied FIFO to the oldest open docs. With no allocations this is pure
 * FIFO. `charges` = `[{ partyId, docId, date, label, amount }]` (a NEGATIVE
 * amount = a nota de crédito that reduces the balance, never an open invoice
 * that ages); `payments` = `[{ partyId, amount, allocations:[{docId,amount}] }]`.
 * Returns per-party `{ invoiced, credited, paid, balance, buckets, docs:[{...,open}] }`.
 */
function ageParties(charges, payments, asOf) {
  const now = asOf || Date.now();
  const byParty = new Map();
  const ensure = (id) => {
    if (!byParty.has(id)) byParty.set(id, { charges: [], payments: [] });
    return byParty.get(id);
  };
  for (const c of charges) { if (c.partyId) ensure(c.partyId).charges.push({ docId: c.docId, date: c.date, label: c.label, amount: round2(c.amount) }); }
  for (const p of payments) { if (p.partyId) ensure(p.partyId).payments.push({ amount: round2(p.amount), allocations: p.allocations || [] }); }

  const out = new Map();
  for (const [partyId, { charges: chs, payments: pays }] of byParty) {
    // Positive charges are the open invoices that age; a negative charge is a
    // nota de crédito — it reduces the balance FIFO like a payment, so the
    // receivable is never inflated by a credit (the bug this guards against).
    const docs = chs.filter((c) => c.amount > 0).sort((a, b) => (a.date || 0) - (b.date || 0)).map((c) => ({ ...c, open: c.amount }));
    const credited = round2(chs.filter((c) => c.amount < 0).reduce((s, c) => s - c.amount, 0));
    const byDoc = new Map(docs.map((d) => [d.docId, d]));

    // 1) explicit allocations to specific docs; track each payment's leftover.
    //    An allocation naming a doc this party doesn't own settles nothing, so
    //    it must NOT consume the payment — skip it and let the amount fall to
    //    the FIFO remainder instead of silently vanishing.
    let unallocated = 0;
    let paid = 0;
    for (const p of pays) {
      paid = round2(paid + p.amount);
      let allocSum = 0;
      for (const a of (p.allocations || [])) {
        const d = byDoc.get(a.docId);
        if (!d) continue;
        const amt = round2(a.amount);
        allocSum = round2(allocSum + amt);
        d.open = round2(Math.max(0, d.open - amt));
      }
      unallocated = round2(unallocated + Math.max(0, round2(p.amount - allocSum)));
    }

    // 2) unallocated payments + notas de crédito → FIFO over the oldest open docs.
    let remaining = round2(unallocated + credited);
    for (const d of docs) {
      if (remaining <= 0) break;
      const applied = Math.min(d.open, remaining);
      d.open = round2(d.open - applied);
      remaining = round2(remaining - applied);
    }

    const buckets = { d0_30: 0, d31_60: 0, d61_90: 0, d90: 0 };
    let invoiced = 0;
    for (const d of docs) {
      invoiced = round2(invoiced + d.amount);
      if (d.open > 0.001) {
        const days = Math.floor((now - (d.date || 0)) / 86_400_000);
        const k = ageBucket(days);
        buckets[k] = round2(buckets[k] + d.open);
      }
    }
    out.set(partyId, { invoiced, credited, paid, balance: round2(invoiced - credited - paid), buckets, docs });
  }
  return out;
}

function rollup(rows) {
  const t = rows.reduce((a, r) => ({
    invoiced: a.invoiced + r.invoiced, credited: a.credited + (r.credited || 0), paid: a.paid + r.paid, balance: a.balance + r.balance,
    d0_30: a.d0_30 + r.buckets.d0_30, d31_60: a.d31_60 + r.buckets.d31_60,
    d61_90: a.d61_90 + r.buckets.d61_90, d90: a.d90 + r.buckets.d90,
  }), { invoiced: 0, credited: 0, paid: 0, balance: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90: 0 });
  for (const k of Object.keys(t)) t[k] = round2(t[k]);
  return t;
}

/** Cuentas por cobrar — open balance + aging per customer. */
export function resolveReceivables({ salesPostings, payments, customersById, asOf } = {}) {
  const charges = (salesPostings || [])
    .map((s) => {
      // A nota de crédito (E34) reduces the receivable — carry it as a NEGATIVE
      // charge so it nets the balance instead of inflating it.
      const net = round2((s.total || 0) - (s.depositApplied || 0));
      return { partyId: s.customerId, docId: s.id, date: s.postedAt, label: s.ncf || 'Factura', amount: isCreditNote(s.ncf) ? -net : net };
    })
    .filter((c) => Math.abs(c.amount) > 0.001);
  const pays = (payments || [])
    .filter((p) => p.direction === 'in' && p.partyType === 'customer')
    .map((p) => ({ partyId: p.partyId, date: p.paidAt, amount: p.amount, allocations: p.allocations || [] }));
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
      partyId: d.supplierId, docId: d.id, date: d[dateField], label: d.ncf || (dateField === 'purchaseAt' ? 'Compra' : 'Gasto'),
      amount: round2((d.base || 0) + (d.itbis || 0) - (d.retentionIsr || 0) - (d.retentionItbis || 0)),
    }));
  const charges = [...credit(purchases, 'purchaseAt'), ...credit(expenses, 'expenseAt')].filter((c) => c.amount > 0.001);
  const pays = (payments || [])
    .filter((p) => p.direction === 'out' && p.partyType === 'supplier')
    .map((p) => ({ partyId: p.partyId, date: p.paidAt, amount: p.amount, allocations: p.allocations || [] }));
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

/**
 * One party's estado de cuenta assembled from the raw rows — the SAME money
 * rules as the aging views above (customer charge = total − deposit applied;
 * supplier charge = credit docs at base + ITBIS − retenciones), so the panel
 * and the printed statement can never disagree with the aging table that
 * opened them. `selected` = { type: 'customer'|'supplier', id }.
 *
 * @returns {{ name, rows, balance } | null}
 */
export function resolveStatementFor({
  selected, salesPostings, payments, purchases, expenses, customersById, suppliersById,
} = {}) {
  if (!selected) return null;
  if (selected.type === 'customer') {
    const sales = (salesPostings || []).filter((s) => s.customerId === selected.id);
    const charges = sales.filter((s) => !isCreditNote(s.ncf))
      .map((s) => ({ date: s.postedAt, amount: round2((s.total || 0) - (s.depositApplied || 0)), label: 'Factura', ref: s.ncf || '' }))
      .filter((c) => c.amount > 0.001);
    // A nota de crédito shows as an abono (it reduces the running balance), not
    // a second charge — otherwise the printed/shared statement over-bills.
    const notes = sales.filter((s) => isCreditNote(s.ncf))
      .map((s) => ({ date: s.postedAt, amount: round2((s.total || 0) - (s.depositApplied || 0)), label: 'Nota de crédito', ref: s.ncf || '' }))
      .filter((c) => c.amount > 0.001);
    const pays = (payments || []).filter((p) => p.direction === 'in' && p.partyId === selected.id)
      .map((p) => ({ date: p.paidAt, amount: p.amount, label: 'Cobro', ref: p.reference || '' }));
    return {
      name: (customersById && customersById.get(selected.id)?.name) || 'Cliente',
      ...resolvePartyStatement({ charges, payments: [...notes, ...pays] }),
    };
  }
  const credit = (arr, dateField, label) => (arr || [])
    .filter((d) => d.paymentMethod === 'credit' && d.supplierId === selected.id)
    .map((d) => ({
      date: d[dateField],
      amount: round2((d.base || 0) + (d.itbis || 0) - (d.retentionIsr || 0) - (d.retentionItbis || 0)),
      label, ref: d.ncf || '',
    }));
  const charges = [...credit(purchases, 'purchaseAt', 'Compra'), ...credit(expenses, 'expenseAt', 'Gasto')];
  const pays = (payments || []).filter((p) => p.direction === 'out' && p.partyId === selected.id)
    .map((p) => ({ date: p.paidAt, amount: p.amount, label: 'Pago', ref: p.reference || '' }));
  return {
    name: (suppliersById && suppliersById.get(selected.id)?.name) || 'Proveedor',
    ...resolvePartyStatement({ charges, payments: pays }),
  };
}

// Re-export so the page can show the deposited-net on a card cobro.
export { paymentNet };
