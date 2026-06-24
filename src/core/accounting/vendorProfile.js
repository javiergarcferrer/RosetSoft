// Vendor 360 ViewModel — one supplier's open balance, YTD spend + retentions,
// and recent documents (606-style). Pure: no React, no db.
import { round2 } from '../../lib/accounting/ledger.js';

export function resolveVendorProfile({ supplier, expenses, purchases, payments, year } = {}) {
  if (!supplier) return null;
  const sid = supplier.id;
  const inYear = (t) => year == null || new Date(t || 0).getUTCFullYear() === year;

  const docs = [
    ...(purchases || []).filter((p) => p.supplierId === sid).map((p) => ({
      id: p.id, kind: 'Compra', date: p.purchaseAt, ncf: p.ncf || '',
      base: round2(p.base || 0), itbis: round2(p.itbis || 0),
      retIsr: round2(p.retentionIsr || 0), retItbis: round2(p.retentionItbis || 0),
      method: p.paymentMethod, total: round2((p.base || 0) + (p.itbis || 0)),
    })),
    ...(expenses || []).filter((e) => e.supplierId === sid).map((e) => ({
      id: e.id, kind: 'Gasto', date: e.expenseAt, ncf: e.ncf || '',
      base: round2(e.base || 0), itbis: round2(e.itbis || 0),
      retIsr: round2(e.retentionIsr || 0), retItbis: round2(e.retentionItbis || 0),
      method: e.paymentMethod, total: round2((e.base || 0) + (e.itbis || 0)),
    })),
  ].sort((a, b) => (b.date || 0) - (a.date || 0));

  const sum = (arr, f) => round2(arr.reduce((s, d) => s + f(d), 0));
  const creditCharges = sum(docs.filter((d) => d.method === 'credit'), (d) => round2(d.total - d.retIsr - d.retItbis));
  const paid = sum((payments || []).filter((p) => p.direction === 'out' && p.partyId === sid), (p) => p.amount);
  const ytd = docs.filter((d) => inYear(d.date));

  return {
    supplier,
    year: year ?? null,
    balance: round2(creditCharges - paid),
    ytd: {
      spend: sum(ytd, (d) => d.base),
      itbis: sum(ytd, (d) => d.itbis),
      retIsr: sum(ytd, (d) => d.retIsr),
      retItbis: sum(ytd, (d) => d.retItbis),
      count: ytd.length,
    },
    docCount: docs.length,
    ncf606Count: docs.filter((d) => d.ncf).length,
    lastAt: docs[0]?.date || null,
    recentDocs: docs.slice(0, 20),
  };
}
