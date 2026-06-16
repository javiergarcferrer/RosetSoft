/**
 * Tests for the warehouse-order ViewModel
 * (src/core/quote/views/warehouseOrder.js).
 *
 * The invariant that matters mirrors the supplier registration: the picking
 * list carries EXACTLY what was sold — the same isPricedLine / isPricedComponent
 * gates as the money. An excluded optional or a non-selected alternative must
 * never reach the warehouse (it would prepare furniture nobody bought), and a
 * compound expands to its priced components (the pullable SKUs), every row
 * pinned to the OWNING LINE's id so the renderer draws the line's cover photo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveWarehouseOrder } from '../src/core/quote/views/warehouseOrder.js';

const QUOTE = { id: 'q1', number: 1010, customerId: 'c1', professionalId: 'p1', createdByUserId: 'u1', currencyCode: 'USD' };

function resolve(lines = []) {
  return resolveWarehouseOrder({
    quote: QUOTE,
    lines,
    customer: { id: 'c1', name: 'Eduardo García', company: 'García Interiores' },
    professional: { id: 'p1', name: 'María Pérez' },
    seller: { id: 'u1', name: 'Javier Alcover' },
  });
}

test('simple lines project to foto · reference · name · qty; sections and excluded lines drop', () => {
  const d = resolve([
    { id: 'l0', kind: 'section', name: 'Sala', sortOrder: 0 },
    { id: 'l1', kind: 'item', reference: '12340100', name: 'TOGO', subtype: 'C · ALCANTARA', qty: 2, sortOrder: 1 },
    { id: 'l2', kind: 'item', reference: '99990000', name: 'OTTOMAN', qty: 1, isOptional: true, sortOrder: 2 },          // excluded optional
    { id: 'l3', kind: 'item', reference: '11110000', name: 'PLOUM A', qty: 1, alternativeGroup: 'g', isSelectedAlternative: true, sortOrder: 3 },
    { id: 'l4', kind: 'item', reference: '22220000', name: 'PLOUM B', qty: 1, alternativeGroup: 'g', sortOrder: 4 },     // non-selected alternative
  ]);
  assert.deepEqual(d.rows.map((r) => r.reference), ['12340100', '11110000']);
  assert.equal(d.rows[0].qty, 2);
  assert.equal(d.rows[0].detail, 'C · ALCANTARA');
  // The photo is referenced by the owning LINE id — the renderer maps it to coverKey().
  assert.equal(d.rows[0].lineId, 'l1');
  assert.equal(d.totalPieces, 3);
  assert.equal(d.rowCount, 2);
});

test('a compound expands to its PRICED components, every row pinned to the parent line photo', () => {
  const d = resolve([{
    id: 'l1', kind: 'item', name: 'COMPOSICIÓN MAH JONG', qty: 1, sortOrder: 1,
    components: [
      { id: 'c1', reference: 'MJ-1', name: 'Base', qty: 3 },
      { id: 'c2', reference: 'MJ-2', name: 'Respaldo', qty: 2, isOptional: true },                       // excluded add-on
      { id: 'c3', reference: 'MJ-3', name: 'Funda A', qty: 1, alternativeGroup: 'a', isSelectedAlternative: true },
      { id: 'c4', reference: 'MJ-4', name: 'Funda B', qty: 1, alternativeGroup: 'a' },                   // non-selected
      { id: 'c5', reference: 'MJ-5', name: 'Módulo opc.', qty: 1, moduleGroup: 'm1', moduleOptional: true }, // optional MODULE
    ],
  }]);
  assert.deepEqual(d.rows.map((r) => r.reference), ['MJ-1', 'MJ-3']);
  assert.equal(d.rows[0].name, 'Base');
  assert.equal(d.rows[0].detail, 'COMPOSICIÓN MAH JONG');
  // Components have no cover of their own — they ride the parent LINE's photo.
  assert.equal(d.rows[0].lineId, 'l1');
  assert.equal(d.rows[1].lineId, 'l1');
  assert.equal(d.totalPieces, 4); // 3 bases + 1 funda
});

test('context carries customer (company first), decorator, seller and the quote number', () => {
  const d = resolve([{ id: 'l1', kind: 'item', reference: 'R1', name: 'TOGO', qty: 1 }]);
  assert.equal(d.quoteNumber, 1010);
  assert.equal(d.customerName, 'García Interiores');
  assert.equal(d.professionalName, 'María Pérez');
  assert.equal(d.sellerName, 'Javier Alcover');
});

test('rows follow line sortOrder; a quote with nothing to prepare yields no rows', () => {
  assert.equal(resolve([
    { id: 'l1', kind: 'item', reference: 'A', name: 'A', qty: 1, isOptional: true }, // excluded → nothing
  ]).rowCount, 0);

  const d = resolve([
    { id: 'l2', kind: 'item', reference: 'B', name: 'B', qty: 1, sortOrder: 2 },
    { id: 'l1', kind: 'item', reference: 'A', name: 'A', qty: 1, sortOrder: 1 },
  ]);
  assert.deepEqual(d.rows.map((r) => r.reference), ['A', 'B']);
});
