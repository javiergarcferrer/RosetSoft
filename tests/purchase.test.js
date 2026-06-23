/**
 * Tests for the Compras module (src/lib/accounting/purchase.ts): the multi-line
 * goods resolver (base = Σ line cost, kardex unit cost = cost / qty) and the
 * asiento it posts — the balance invariant + the inventory/account routing.
 * Money + data integrity.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccountingConfig } from '../src/lib/accounting/config.js';
import {
  buildPurchaseEntry, buildCogsEntry, planSalida, resolvePurchaseLines,
} from '../src/lib/accounting/purchase.js';
import { debitTotal, creditTotal } from '../src/lib/accounting/ledger.js';

const config = resolveAccountingConfig(null); // ITBIS 18, retISR 10, retITBIS 30
function ids() { let n = 0; return () => `id${++n}`; }

/* ------------------------- resolvePurchaseLines -------------------------- */

test('resolvePurchaseLines: base = Σ cost, qty = Σ qty, unit cost = cost / qty', () => {
  const r = resolvePurchaseLines([
    { id: 'l1', itemId: 'i1', name: 'Sofá Togo', reference: '14100100', qty: 2, cost: 30000 },
    { id: 'l2', itemId: null, name: 'Puff Togo', reference: '', qty: 3, cost: 15000 },
  ]);
  assert.equal(r.base, 45000);
  assert.equal(r.qty, 5);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].unitCost, 15000);     // 30000 / 2
  assert.equal(r.lines[1].unitCost, 5000);       // 15000 / 3
  assert.equal(r.lines[1].itemId, null);         // free-text line → created on save
});

test('resolvePurchaseLines: keeps a 4-dp unit cost and drops blank rows', () => {
  const r = resolvePurchaseLines([
    { itemId: 'i1', name: 'Silla', qty: 3, cost: 100 },   // 33.3333…
    { itemId: '', name: '', qty: '', cost: '' },           // blank → dropped
    { itemId: '', name: '   ', qty: 0, cost: 0 },          // blank → dropped
  ]);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].unitCost, 33.3333);
  assert.equal(r.base, 100);
});

test('resolvePurchaseLines: clamps negatives and tolerates string inputs', () => {
  const r = resolvePurchaseLines([
    { itemId: 'i1', name: 'A', qty: '-2', cost: '-500' }, // clamped → 0/0, but name keeps it
    { itemId: 'i2', name: 'B', qty: '4', cost: '1200.5' },
  ]);
  assert.equal(r.lines[0].qty, 0);
  assert.equal(r.lines[0].cost, 0);
  assert.equal(r.lines[0].unitCost, 0);
  assert.equal(r.lines[1].cost, 1200.5);
  assert.equal(r.lines[1].unitCost, 300.125);
  assert.equal(r.base, 1200.5);
});

/* --------------------------- buildPurchaseEntry -------------------------- */

test('buildPurchaseEntry: goods debit inventory + ITBIS, credit suplidores; balances', () => {
  const { entry, lines } = buildPurchaseEntry({
    newId: ids(), config,
    purchase: {
      id: 'p1', supplierId: 's1', kind: 'goods',
      base: 45000, itbis: 8100, retentionIsr: 0, retentionItbis: 0,
      paymentMethod: 'credit', ncf: 'B0100000001',
    },
  });
  assert.equal(entry.source, 'purchase');
  assert.equal(entry.refTable, 'purchases');
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(debitTotal(lines), 53100);
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.inventory).debit, 45000);
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.itbisCredit).debit, 8100);
  const payable = lines.find((l) => l.accountCode === config.postingMap.accountsPayable);
  assert.equal(payable.credit, 53100);
  assert.equal(payable.ncf, 'B0100000001');
  assert.equal(payable.thirdPartyId, 's1');
});

test('buildPurchaseEntry: asset hits the chosen account, paid from bank', () => {
  const { lines } = buildPurchaseEntry({
    newId: ids(), config,
    purchase: {
      id: 'p2', supplierId: null, kind: 'asset', accountCode: '1-02-001-00-00-00',
      base: 10000, itbis: 1800, retentionIsr: 0, retentionItbis: 0, paymentMethod: 'bank',
    },
  });
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === '1-02-001-00-00-00').debit, 10000);
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.bank).credit, 11800);
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.inventory), undefined);
});

test('buildPurchaseEntry: retentions split the credit and still balance', () => {
  const { lines } = buildPurchaseEntry({
    newId: ids(), config,
    purchase: {
      id: 'p3', supplierId: 's3', kind: 'service', accountCode: '6-02-001-00-00-00',
      base: 1000, itbis: 180, retentionIsr: 100, retentionItbis: 54, paymentMethod: 'credit',
    },
  });
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.accountsPayable).credit, 1026);
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.isrWithheld).credit, 100);
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.itbisWithheld).credit, 54);
});

test('buildPurchaseEntry: asset/service without an account throws', () => {
  assert.throws(() => buildPurchaseEntry({
    newId: ids(), config,
    purchase: { id: 'p4', kind: 'asset', accountCode: null, base: 100, itbis: 0, paymentMethod: 'bank' },
  }), /cuenta de destino/);
});

/* ------------------------- planSalida / buildCogsEntry ------------------- */

test('planSalida: COGS at the running average, refusing over-issue', () => {
  assert.deepEqual(
    planSalida({ qty: 2, onHand: 5, avgCost: 1500 }),
    { ok: true, qty: 2, unitCost: 1500, cost: 3000, newQty: 3 },
  );
  assert.equal(planSalida({ qty: 9, onHand: 5, avgCost: 1500 }).ok, false);
  assert.equal(planSalida({ qty: 0, onHand: 5, avgCost: 1500 }).ok, false);
});

test('buildCogsEntry: debit costo de venta / credit inventario; balances', () => {
  const { entry, lines } = buildCogsEntry({ newId: ids(), config, cost: 3000, refId: 'm1' });
  assert.equal(entry.source, 'adjustment');
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.costOfSales).debit, 3000);
  assert.equal(lines.find((l) => l.accountCode === config.postingMap.inventory).credit, 3000);
});
