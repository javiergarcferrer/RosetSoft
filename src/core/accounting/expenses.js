// Expense ViewModels — the Gastos list and the DGII 606 (compras de bienes y
// servicios) projection. Pure: no React, no db.
import { round2 } from '../../lib/accounting/ledger.js';

function inWindow(t, start, end) {
  if (start != null && t < start) return false;
  if (end != null && t > end) return false;
  return true;
}

/**
 * The Gastos list joined with supplier + account names, newest-first, plus
 * window totals.
 */
export function resolveExpensesList({ expenses, suppliers, accounts, start, end } = {}) {
  const supById = new Map((suppliers || []).map((s) => [s.id, s]));
  const nameByCode = new Map((accounts || []).map((a) => [a.code, a.name]));
  const rows = (expenses || [])
    .filter((e) => inWindow(e.expenseAt, start, end))
    .map((e) => ({
      expense: e,
      supplier: e.supplierId ? supById.get(e.supplierId) || null : null,
      accountName: nameByCode.get(e.accountCode) || '',
      total: round2((e.base || 0) + (e.itbis || 0)),
      net: round2((e.base || 0) + (e.itbis || 0) - (e.retentionIsr || 0) - (e.retentionItbis || 0)),
    }))
    .sort((a, b) => (b.expense.expenseAt || 0) - (a.expense.expenseAt || 0));

  const totals = rows.reduce((acc, r) => ({
    base: acc.base + (r.expense.base || 0),
    itbis: acc.itbis + (r.expense.itbis || 0),
    retIsr: acc.retIsr + (r.expense.retentionIsr || 0),
    retItbis: acc.retItbis + (r.expense.retentionItbis || 0),
    total: acc.total + r.total,
  }), { base: 0, itbis: 0, retIsr: 0, retItbis: 0, total: 0 });
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);

  return { rows, totals, count: rows.length };
}

function row606(doc, dateField, suppliersById) {
  const s = doc.supplierId ? suppliersById.get(doc.supplierId) : null;
  return {
    id: doc.id,
    rnc: s?.rnc || '',
    name: s?.name || '',
    kind: s?.kind || '',
    ncf: doc.ncf || '',
    ncfType: doc.ncfType || '',
    date: doc[dateField],
    base: round2(doc.base || 0),
    itbis: round2(doc.itbis || 0),
    retIsr: round2(doc.retentionIsr || 0),
    retItbis: round2(doc.retentionItbis || 0),
    total: round2((doc.base || 0) + (doc.itbis || 0)),
  };
}

/**
 * Formato 606 — compras de bienes y servicios. One row per expense AND purchase
 * with an NCF in the window. The RNC + NCF + tax columns match the DGII layout.
 */
export function resolve606({ expenses, purchases, suppliers, start, end } = {}) {
  const supById = new Map((suppliers || []).map((s) => [s.id, s]));
  const rows = [
    ...(expenses || []).filter((e) => inWindow(e.expenseAt, start, end)).map((e) => row606(e, 'expenseAt', supById)),
    ...(purchases || []).filter((p) => inWindow(p.purchaseAt, start, end)).map((p) => row606(p, 'purchaseAt', supById)),
  ].sort((a, b) => (a.date || 0) - (b.date || 0));

  const totals = rows.reduce((acc, r) => ({
    base: acc.base + r.base,
    itbis: acc.itbis + r.itbis,
    retIsr: acc.retIsr + r.retIsr,
    retItbis: acc.retItbis + r.retItbis,
    total: acc.total + r.total,
  }), { base: 0, itbis: 0, retIsr: 0, retItbis: 0, total: 0 });
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);

  return { rows, totals, count: rows.length };
}
