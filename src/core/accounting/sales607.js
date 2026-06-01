// Sales ViewModels — the DGII 607 (ventas) projection and the monthly ITBIS
// liquidation (IT-1 = débito fiscal de ventas − crédito fiscal de compras).
// Pure: no React, no db.
import { round2 } from '../../lib/accounting/ledger.js';

function inWindow(t, start, end) {
  if (start != null && t < start) return false;
  if (end != null && t > end) return false;
  return true;
}

/**
 * Formato 607 — ventas de bienes y servicios. One row per posted sale in the
 * window, with the customer's RNC/cédula (snapshot or current) + NCF + ITBIS.
 */
export function resolveSales607({ salesPostings, customersById, start, end } = {}) {
  const custById = customersById || new Map();
  const rows = (salesPostings || [])
    .filter((p) => inWindow(p.postedAt, start, end))
    .map((p) => {
      const c = p.customerId ? custById.get(p.customerId) : null;
      return {
        id: p.id,
        rnc: p.rnc || c?.rnc || '',
        name: c?.name || '',
        ncf: p.ncf || '',
        ncfType: p.ncfType || '',
        date: p.postedAt,
        base: round2(p.base || 0),
        itbis: round2(p.itbis || 0),
        total: round2(p.total || 0),
      };
    })
    .sort((a, b) => (a.date || 0) - (b.date || 0));

  const totals = rows.reduce((acc, r) => ({
    base: acc.base + r.base,
    itbis: acc.itbis + r.itbis,
    total: acc.total + r.total,
  }), { base: 0, itbis: 0, total: 0 });
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);

  return { rows, totals, count: rows.length };
}

/**
 * IT-1 — liquidación mensual de ITBIS. Débito fiscal (ITBIS de ventas) menos
 * crédito fiscal (ITBIS adelantado en gastos/compras) en el período. Saldo
 * positivo ⇒ a pagar; negativo ⇒ a favor (arrastra). Las compras se suman desde
 * los gastos (y, cuando exista, el módulo de compras).
 */
export function resolveItbisLiquidation({ salesPostings, expenses, start, end } = {}) {
  const debitoFiscal = round2((salesPostings || [])
    .filter((p) => inWindow(p.postedAt, start, end))
    .reduce((s, p) => s + (Number(p.itbis) || 0), 0));
  const creditoFiscal = round2((expenses || [])
    .filter((e) => inWindow(e.expenseAt, start, end) && e.itbisCreditable !== false)
    .reduce((s, e) => s + (Number(e.itbis) || 0), 0));
  const saldo = round2(debitoFiscal - creditoFiscal);
  return {
    debitoFiscal,
    creditoFiscal,
    saldo,
    aPagar: saldo > 0 ? saldo : 0,
    aFavor: saldo < 0 ? round2(-saldo) : 0,
  };
}
