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
        depositApplied: round2(p.depositApplied || 0),
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
 * crédito fiscal en el período. Saldo positivo ⇒ a pagar; negativo ⇒ a favor
 * (arrastra). The credit splits the way the IT-1 form wants it:
 *   • `creditoLocal` — ITBIS on NCF-backed local docs: gastos + compras + the
 *     expediente cost sheets (agenciamiento, transporte, puerto…). These rows
 *     must also appear in the 606 (DGII cross-checks the two).
 *   • `creditoImportacion` — ITBIS paid at customs (DUA-backed, no NCF): the
 *     legacy single liquidations + every expediente's import ITBIS.
 */
export function resolveItbisLiquidation({ salesPostings, expenses, purchases, imports, expedientes, start, end } = {}) {
  const debitoFiscal = round2((salesPostings || [])
    .filter((p) => inWindow(p.postedAt, start, end))
    .reduce((s, p) => s + (Number(p.itbis) || 0), 0));
  const expCredit = (expenses || [])
    .filter((e) => inWindow(e.expenseAt, start, end) && e.itbisCreditable !== false)
    .reduce((s, e) => s + (Number(e.itbis) || 0), 0);
  const purCredit = (purchases || [])
    .filter((p) => inWindow(p.purchaseAt, start, end) && p.itbisCreditable !== false)
    .reduce((s, p) => s + (Number(p.itbis) || 0), 0);
  const impCredit = (imports || [])
    .filter((l) => inWindow(l.liquidatedAt, start, end))
    .reduce((s, l) => s + (Number(l.importItbis) || 0), 0);
  const expedienteWindow = (expedientes || []).filter((e) => inWindow(e.liquidatedAt, start, end));
  const expedienteImportItbis = expedienteWindow
    .reduce((s, e) => s + (Number(e.importItbis) || 0), 0);
  // Cost-sheet ITBIS: each cost's recoverable portion, clamped to its amount
  // (mirrors expedienteCostTotals — duplicated sum here to stay row-shaped).
  const expedienteCostItbis = expedienteWindow.reduce((s, e) => s
    + (e.costs || []).reduce((cs, c) => {
      const a = Math.max(0, Number(c?.amount) || 0);
      return cs + Math.min(Math.max(0, Number(c?.itbis) || 0), a);
    }, 0), 0);
  const creditoLocal = round2(expCredit + purCredit + expedienteCostItbis);
  const creditoImportacion = round2(impCredit + expedienteImportItbis);
  const creditoFiscal = round2(creditoLocal + creditoImportacion);
  const saldo = round2(debitoFiscal - creditoFiscal);
  return {
    debitoFiscal,
    creditoLocal,
    creditoImportacion,
    creditoFiscal,
    saldo,
    aPagar: saldo > 0 ? saldo : 0,
    aFavor: saldo < 0 ? round2(-saldo) : 0,
  };
}
