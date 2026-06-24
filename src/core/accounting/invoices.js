// Invoice pipeline ViewModel — the AR funnel at a glance: every posted sale
// bucketed by payment status (por cobrar / vencida / cobrada) plus the e-CF
// backlog (assigned but not transmitted, or rejected). Pure: no React, no db.
// `receivables` is a resolveReceivables result — its per-doc `open` drives the
// paid/open split (allocations + FIFO already applied there).
import { round2 } from '../../lib/accounting/ledger.js';
import { isCreditNote } from '../../lib/accounting/ecf.js';

const DAY = 86400000;
// Default credit term — when a factura a crédito turns vencida (the estado pill
// + the drawer's fecha límite). 30 días is the house term; the e-CF carries its
// own fecha límite, but for the register the fixed term is the simple, right call.
const TERM_DAYS = 30;

export function resolveInvoicePipeline({ salesPostings, receivables, customersById, now, overdueDays = 30 } = {}) {
  const at = now || 0;
  const openByDoc = new Map();
  for (const row of receivables?.rows || []) {
    for (const d of row.docs || []) openByDoc.set(d.docId, d.open);
  }

  const invoices = (salesPostings || []).filter((s) => !s.voidedAt).map((s) => {
    const open = round2(openByDoc.get(s.id) ?? 0);
    const ecf = s.ecfStatus || '';
    const age = Math.floor((at - (s.postedAt || 0)) / DAY);
    const status = open <= 0.01 ? 'paid' : age > overdueDays ? 'overdue' : 'open';
    return {
      id: s.id,
      number: s.number ?? null,
      ncf: s.ncf || '',
      ecfStatus: ecf,
      customer: (customersById && customersById.get(s.customerId)) || null,
      postedAt: s.postedAt || 0,
      total: round2(s.total || 0),
      open,
      age,
      status,
      needsEcf: ecf === 'pending' || ecf === 'rejected',
    };
  });

  const sum = (arr, f) => round2(arr.reduce((acc, i) => acc + f(i), 0));
  const buckets = [
    { key: 'open', label: 'Por cobrar' },
    { key: 'overdue', label: 'Vencida' },
    { key: 'paid', label: 'Cobrada' },
  ].map((b) => {
    const inv = invoices.filter((i) => i.status === b.key).sort((a, c) => (c.postedAt || 0) - (a.postedAt || 0));
    return { ...b, count: inv.length, amount: sum(inv, (i) => (b.key === 'paid' ? i.total : i.open)), invoices: inv };
  });

  const ecfPending = invoices.filter((i) => i.needsEcf).sort((a, c) => (c.postedAt || 0) - (a.postedAt || 0));

  return {
    buckets,
    pendingEcf: { count: ecfPending.length, amount: sum(ecfPending, (i) => i.total), invoices: ecfPending },
    totalInvoiced: sum(invoices, (i) => i.total),
    totalOpen: sum(invoices.filter((i) => i.status !== 'paid'), (i) => i.open),
    count: invoices.length,
  };
}

/**
 * Invoice REGISTER — the single Facturación pane's data: every factura (not
 * window-scoped — overdue prior-month docs belong here too) as one flat row
 * carrying the payment status the estado pill renders, the open balance, the
 * fecha límite, and the e-CF state. `receivables` supplies the per-doc `open`
 * (allocations + FIFO already applied). Pure: no React, no db.
 *
 * status: 'paid' | 'open' | 'partial' | 'overdue' | 'note'
 */
export function resolveInvoiceRegister({ salesPostings, receivables, customersById, now } = {}) {
  const at = now || 0;
  const openByDoc = new Map();
  for (const row of receivables?.rows || []) {
    for (const d of row.docs || []) openByDoc.set(d.docId, d.open);
  }

  const rows = (salesPostings || []).map((p) => {
    const c = (customersById && customersById.get(p.customerId)) || null;
    const total = round2(p.total || 0);
    const base = round2(p.base || 0);
    const itbis = round2(p.itbis || 0);
    const isNote = isCreditNote(p.ncf);
    const voided = !!p.voidedAt;
    const deposit = round2(p.depositApplied || 0);
    const open = (isNote || voided) ? 0 : round2(openByDoc.get(p.id) ?? 0);
    const cobrado = round2(Math.max(0, total - deposit - open));
    const dueAt = (p.postedAt || 0) + TERM_DAYS * DAY;
    const overdue = open > 0.01 && at > dueAt;
    const ecf = p.ecfStatus || '';
    const needsEcf = !voided && (ecf === 'pending' || ecf === 'rejected');
    let status;
    if (voided) status = 'voided';
    else if (isNote) status = 'note';
    else if (open <= 0.01) status = 'paid';
    else if (overdue) status = 'overdue';
    else if (cobrado > 0 || deposit > 0) status = 'partial';
    else status = 'open';
    return {
      id: p.id, ncf: p.ncf || '', rnc: p.rnc || c?.rnc || '', name: c?.name || '',
      date: p.postedAt, base, itbis, total, depositApplied: deposit,
      open, cobrado, dueAt, overdue, status,
      creditNote: isNote, modifiesNcf: p.modifiesNcf || '',
      ecfStatus: ecf, ecfType: p.ecfType || '', needsEcf,
    };
  }).sort((a, b) => (b.date || 0) - (a.date || 0));

  const isUnpaid = (r) => r.status === 'open' || r.status === 'partial' || r.status === 'overdue';
  const counts = {
    todas: rows.filter((r) => r.status !== 'voided').length,
    cobrar: rows.filter(isUnpaid).length,
    pagadas: rows.filter((r) => r.status === 'paid').length,
    ecf: rows.filter((r) => r.needsEcf).length,
    anuladas: rows.filter((r) => r.status === 'voided').length,
  };
  return { rows, counts };
}

/** Net totals over a register-row subset (notas de crédito subtract). */
export function invoiceRowTotals(rows) {
  const t = (rows || []).reduce((acc, r) => {
    if (r.status === 'voided') return acc;
    const s = r.creditNote ? -1 : 1;
    return {
      base: acc.base + s * r.base, itbis: acc.itbis + s * r.itbis,
      total: acc.total + s * r.total, open: acc.open + (r.open || 0),
    };
  }, { base: 0, itbis: 0, total: 0, open: 0 });
  for (const k of Object.keys(t)) t[k] = round2(t[k]);
  return t;
}
