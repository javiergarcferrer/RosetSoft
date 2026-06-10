/**
 * Tests for the Ligne Roset order-registration ViewModel
 * (src/core/quote/views/registration.js).
 *
 * The invariant that matters: the registration lists EXACTLY what was sold —
 * the same isPricedLine / isPricedComponent gates as the money. An excluded
 * optional or a non-selected alternative must never be ordered with the
 * supplier, and a compound expands to its priced components (the orderable
 * SKUs), not the composition parent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveOrderRegistration } from '../src/core/quote/views/registration.js';

const ORDER = { id: 'o1', number: 102, name: 'Mayo 2026' };

function resolve(overrides = {}) {
  return resolveOrderRegistration({
    order: ORDER,
    quotes: [{
      id: 'q1', number: 1010, customerId: 'c1', professionalId: 'p1', createdByUserId: 'u1',
    }],
    customers: [{ id: 'c1', name: 'Eduardo García', company: 'García Interiores' }],
    professionals: [{ id: 'p1', name: 'María Pérez' }],
    profiles: [{ id: 'u1', name: 'Javier Alcover' }],
    lines: [],
    ...overrides,
  });
}

test('simple lines project to reference · name · qty; sections and excluded lines drop', () => {
  const d = resolve({
    lines: [
      { id: 'l0', quoteId: 'q1', kind: 'section', name: 'Sala', sortOrder: 0 },
      { id: 'l1', quoteId: 'q1', kind: 'item', reference: '12340100', name: 'TOGO', subtype: 'C · ALCANTARA', qty: 2, sortOrder: 1 },
      { id: 'l2', quoteId: 'q1', kind: 'item', reference: '99990000', name: 'OTTOMAN', qty: 1, isOptional: true, sortOrder: 2 },          // excluded optional
      { id: 'l3', quoteId: 'q1', kind: 'item', reference: '11110000', name: 'PLOUM A', qty: 1, alternativeGroup: 'g', isSelectedAlternative: true, sortOrder: 3 },
      { id: 'l4', quoteId: 'q1', kind: 'item', reference: '22220000', name: 'PLOUM B', qty: 1, alternativeGroup: 'g', sortOrder: 4 },     // non-selected alternative
    ],
  });
  const [g] = d.groups;
  assert.deepEqual(g.rows.map((r) => r.reference), ['12340100', '11110000']);
  assert.equal(g.rows[0].qty, 2);
  assert.equal(g.rows[0].detail, 'C · ALCANTARA');
  assert.equal(g.pieces, 3);
  assert.equal(d.totalPieces, 3);
  assert.equal(d.orderNumber, 102);
});

test('a compound expands to its PRICED components — the orderable SKUs', () => {
  const d = resolve({
    lines: [{
      id: 'l1', quoteId: 'q1', kind: 'item', name: 'COMPOSICIÓN MAH JONG', qty: 1, sortOrder: 1,
      components: [
        { id: 'c1', reference: 'MJ-1', name: 'Base', qty: 3 },
        { id: 'c2', reference: 'MJ-2', name: 'Respaldo', qty: 2, isOptional: true },                       // excluded add-on
        { id: 'c3', reference: 'MJ-3', name: 'Funda A', qty: 1, alternativeGroup: 'a', isSelectedAlternative: true },
        { id: 'c4', reference: 'MJ-4', name: 'Funda B', qty: 1, alternativeGroup: 'a' },                   // non-selected
        { id: 'c5', reference: 'MJ-5', name: 'Módulo opc.', qty: 1, moduleGroup: 'm1', moduleOptional: true }, // optional MODULE
      ],
    }],
  });
  const [g] = d.groups;
  assert.deepEqual(g.rows.map((r) => r.reference), ['MJ-1', 'MJ-3']);
  // The parent composition rides along as context on the component row.
  assert.equal(g.rows[0].name, 'Base');
  assert.equal(g.rows[0].detail, 'COMPOSICIÓN MAH JONG');
  assert.equal(g.pieces, 4); // 3 bases + 1 funda
});

test('group context carries customer (company first), decorator and seller names', () => {
  const d = resolve({
    lines: [{ id: 'l1', quoteId: 'q1', kind: 'item', reference: 'R1', name: 'TOGO', qty: 1 }],
  });
  const [g] = d.groups;
  assert.equal(g.quoteNumber, 1010);
  assert.equal(g.customerName, 'García Interiores');
  assert.equal(g.professionalName, 'María Pérez');
  assert.equal(g.sellerName, 'Javier Alcover');
});

test('quotes with nothing to register are dropped; quotes sort by number', () => {
  const d = resolve({
    quotes: [
      { id: 'q2', number: 1020 },
      { id: 'q1', number: 1010 },
      { id: 'q3', number: 1030 }, // only an excluded optional → dropped
    ],
    lines: [
      { id: 'l1', quoteId: 'q1', kind: 'item', reference: 'A', name: 'A', qty: 1 },
      { id: 'l2', quoteId: 'q2', kind: 'item', reference: 'B', name: 'B', qty: 1 },
      { id: 'l3', quoteId: 'q3', kind: 'item', reference: 'C', name: 'C', qty: 1, isOptional: true },
    ],
  });
  assert.deepEqual(d.groups.map((g) => g.quoteNumber), [1010, 1020]);
  assert.equal(d.rowCount, 2);
});
