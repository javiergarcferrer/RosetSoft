/**
 * Tests for the import-liquidation (DGA) Model — landed cost + customs taxes
 * (src/lib/accounting/importLiquidation.ts), the asiento it posts, and the
 * import ITBIS folding into the IT-1 credit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccountingConfig } from '../src/lib/accounting/config.js';
import {
  landedCost, computeImportTaxes, landedUnitCost, buildImportEntry,
} from '../src/lib/accounting/importLiquidation.js';
import { debitTotal, creditTotal } from '../src/lib/accounting/ledger.js';
import { resolveItbisLiquidation } from '../src/core/accounting/sales607.js';

const config = resolveAccountingConfig(null); // duty 20, ITBIS 18
const M = config.postingMap;
function ids() { let n = 0; return () => `id${++n}`; }

test('computeImportTaxes: 20% duty on CIF, ITBIS on (CIF + duty)', () => {
  const t = computeImportTaxes({ cif: 100000, config });
  assert.equal(t.duty, 20000);          // 20% of 100k
  assert.equal(t.importItbis, 21600);   // 18% of 120k
});

test('landedCost sums CIF + duty + clearance + other (ex-ITBIS)', () => {
  assert.equal(landedCost({ cif: 100000, duty: 20000, clearanceFees: 5000, otherCosts: 1000 }), 126000);
});

test('landedUnitCost divides landed cost by qty', () => {
  assert.equal(landedUnitCost({ cif: 100000, duty: 20000, clearanceFees: 5000, otherCosts: 1000 }, 10), 12600);
});

test('buildImportEntry capitalizes landed cost + credits ITBIS, balanced', () => {
  const { entry, lines } = buildImportEntry({
    newId: ids(), config,
    liq: { id: 'l1', supplierId: 's1', cif: 100000, duty: 20000, importItbis: 21600, clearanceFees: 5000, otherCosts: 0, paymentMethod: 'bank' },
  });
  assert.equal(entry.source, 'import');
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === M.inventory).debit, 125000); // 100k+20k+5k
  assert.equal(lines.find((l) => l.accountCode === M.itbisCredit).debit, 21600);
  assert.equal(lines.find((l) => l.accountCode === M.bank).credit, 146600);
});

test('resolveItbisLiquidation folds import ITBIS into the credit', () => {
  const r = resolveItbisLiquidation({
    salesPostings: [{ postedAt: 1000, itbis: 30000 }],
    expenses: [{ expenseAt: 1000, itbis: 2000, itbisCreditable: true }],
    imports: [{ liquidatedAt: 1000, importItbis: 21600 }],
  });
  assert.equal(r.debitoFiscal, 30000);
  assert.equal(r.creditoFiscal, 23600); // 2000 + 21600
  assert.equal(r.saldo, 6400);
  assert.equal(r.aPagar, 6400);
});

test('resolveItbisLiquidation credits the expedientes: import ITBIS + cost-sheet ITBIS', () => {
  const r = resolveItbisLiquidation({
    salesPostings: [{ postedAt: 1000, itbis: 50000 }],
    expedientes: [
      {
        liquidatedAt: 1000,
        importItbis: 21600,
        costs: [
          { amount: 11800, itbis: 1800 },          // agenciamiento with NCF ITBIS
          { amount: 5000, itbis: 0 },              // cost without creditable ITBIS
          { amount: 100, itbis: 500 },             // bad input: ITBIS clamps to amount
        ],
      },
      { liquidatedAt: 99999, importItbis: 9999, costs: [] }, // outside window
    ],
    end: 2000,
  });
  // débito 50000 − (21600 import + 1800 + 100 local) = 26500
  assert.equal(r.creditoImportacion, 21600);
  assert.equal(r.creditoLocal, 1900);
  assert.equal(r.creditoFiscal, 23500);
  assert.equal(r.aPagar, 26500);
});
