/**
 * Tests for src/core/store/views/store.js — the public storefront ViewModel.
 *
 * Covers the data-integrity surface the page can't eyeball: which lines become
 * products (priced lines of the given quotes only), how the same article dedupes
 * across quotes, how an order's stage drives the availability bucket (including
 * the order-less "Bajo pedido" case), the per-article price (point / range /
 * compound), and search / filter / sort. The page picks WHICH quotes to pass
 * (house-account quotes, server-filtered); the VM just projects what it's given.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveStore } from '../src/core/store/index.js';

/* ------------------------------- fixtures -------------------------------- */

function fixture() {
  const orders = [
    { id: 'o1', status: 'in_transit', placedAt: 1000, inTransitAt: 2000 },
    { id: 'o2', status: 'received', receivedAt: 3000 },
  ];
  // House-account quotes (the page pre-filters to these). q3 has no order.
  const quotes = [
    { id: 'q1', orderId: 'o1' },
    { id: 'q2', orderId: 'o2' },
    { id: 'q3', orderId: null },
  ];
  const lines = [
    // SOFA-1 quoted on BOTH o1 (in_transit) and o2 (received) → one deduped card.
    { id: 'l1', quoteId: 'q1', kind: 'item', reference: 'SOFA-1', name: 'Prado', family: 'Prado', unitPrice: 1000, qty: 2, imageId: 'img1', swatchImageId: 'sw1' },
    { id: 'l2', quoteId: 'q2', kind: 'item', reference: 'SOFA-1', name: 'Prado', family: 'Prado', unitPrice: 1000, qty: 3 },
    // Excluded: a section divider and a parked optional add-on.
    { id: 'l3', quoteId: 'q1', kind: 'section', name: 'Sala' },
    { id: 'l4', quoteId: 'q1', kind: 'item', name: 'Lámpara', family: 'Luz', isOptional: true, unitPrice: 50, qty: 1 },
    // A material-less range line on o2 (received).
    { id: 'l5', quoteId: 'q2', kind: 'item', reference: 'CHAIR-9', name: 'Silla', family: 'Sillas', unitPrice: 0, qty: 1, priceMin: 200, priceMax: 400 },
    // A compound on the order-LESS quote q3: 500*1 + 300*2 = 1100.
    { id: 'l8', quoteId: 'q3', kind: 'item', name: 'Modular', family: 'Modular', components: [{ id: 'c1', unitPrice: 500, qty: 1 }, { id: 'c2', unitPrice: 300, qty: 2 }] },
    // A line whose quote is NOT in the given set → must never appear.
    { id: 'l9', quoteId: 'qX', kind: 'item', reference: 'GHOST', unitPrice: 999, qty: 1 },
  ];
  return { orders, quotes, lines };
}

function store(overrides = {}) {
  return resolveStore({
    ...fixture(),
    q: '', tab: 'all', filters: {}, sort: { key: 'availability', dir: 'asc' },
    ...overrides,
  });
}

const byKey = (items, key) => items.find((c) => c.key === key);

/* --------------------------------- tests --------------------------------- */

test('only priced lines of the given quotes become products (deduped per article)', () => {
  const { items } = store();
  // SOFA-1, CHAIR-9, Modular. Section + optional dropped; the out-of-set GHOST dropped.
  assert.equal(items.length, 3);
  assert.ok(!items.some((c) => c.name === 'Lámpara' || c.name === 'Sala'));
  assert.ok(!items.some((c) => c.reference === 'GHOST'));
});

test('the same article on two quotes dedupes into one card with the best availability', () => {
  const sofa = byKey(store().items, 'ref:SOFA-1');
  assert.ok(sofa);
  // o2 (received) outranks o1 (in_transit) → reads as in-stock.
  assert.equal(sofa.availability.bucket, 'available');
  assert.equal(sofa.availability.label, 'Recibido');
  // Representative line (o2) had neither photo nor swatch → both fall back to
  // o1's, which carries them.
  assert.equal(sofa.imageId, 'img1');
  assert.equal(sofa.swatchImageId, 'sw1');
});

test('an in-transit order reads as "En camino"; price is a compound point value', () => {
  // The compound lives on the order-less quote, so check the in-transit case via
  // a fresh fixture where SOFA-1 is only on o1.
  const onlyTransit = resolveStore({
    orders: [{ id: 'o1', status: 'in_transit', inTransitAt: 2000 }],
    quotes: [{ id: 'q1', orderId: 'o1' }],
    lines: [{ id: 'l1', quoteId: 'q1', kind: 'item', reference: 'SOFA-1', name: 'Prado', unitPrice: 1000, qty: 1 }],
    q: '', tab: 'all', filters: {}, sort: { key: 'availability', dir: 'asc' },
  });
  assert.equal(onlyTransit.items[0].availability.bucket, 'incoming');
  assert.equal(onlyTransit.items[0].availability.label, 'En ruta');
});

test('an order-less product reads as "Bajo pedido" (on_order bucket)', () => {
  const modular = byKey(store().items, 'n:modular|modular|');
  assert.ok(modular);
  assert.equal(modular.availability.bucket, 'on_order');
  assert.equal(modular.availability.label, 'Bajo pedido');
  assert.deepEqual(modular.price, { value: 1100 }); // compound subtotal
});

test('a material-less line surfaces as a min–max range price', () => {
  const chair = byKey(store().items, 'ref:CHAIR-9');
  assert.deepEqual(chair.price, { min: 200, max: 400 });
});

test('the incoming tab filters to en-camino products', () => {
  const transitOnly = resolveStore({
    orders: [{ id: 'o1', status: 'in_transit', inTransitAt: 2000 }, { id: 'o2', status: 'received', receivedAt: 3000 }],
    quotes: [{ id: 'q1', orderId: 'o1' }, { id: 'q2', orderId: 'o2' }],
    lines: [
      { id: 'l1', quoteId: 'q1', kind: 'item', reference: 'A', name: 'En ruta', unitPrice: 10, qty: 1 },
      { id: 'l2', quoteId: 'q2', kind: 'item', reference: 'B', name: 'Recibido', unitPrice: 10, qty: 1 },
    ],
    tab: 'incoming', q: '', filters: {}, sort: { key: 'availability', dir: 'asc' },
  });
  assert.equal(transitOnly.items.length, 1);
  assert.equal(transitOnly.items[0].name, 'En ruta');
});

test('search matches name, family and reference', () => {
  assert.equal(store({ q: 'prado' }).items.length, 1);
  assert.equal(store({ q: 'chair-9' }).items.length, 1);
  assert.equal(store({ q: 'zzz' }).items.length, 0);
});

test('price sort orders by the comparable value (range uses its min)', () => {
  const names = store({ sort: { key: 'price', dir: 'asc' } }).items.map((c) => c.name);
  // CHAIR-9 (min 200) < Prado (1000) < Modular (1100).
  assert.deepEqual(names, ['Silla', 'Prado', 'Modular']);
});

test('family filter narrows the grid', () => {
  const { items } = store({ filters: { family: 'Modular' } });
  assert.equal(items.length, 1);
  assert.equal(items[0].family, 'Modular');
});

test('the availability tabs carry counts', () => {
  const { tabs } = store();
  const count = (k) => tabs.find((t) => t.key === k).count;
  assert.equal(count('all'), 3);
  assert.equal(count('available'), 2); // SOFA-1 + CHAIR-9 (both on received orders)
  assert.equal(count('incoming'), 0);
  assert.equal(count('on_order'), 1); // Modular (no order)
});
