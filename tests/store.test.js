/**
 * Tests for src/core/store/views/store.js — the Tienda (showroom) ViewModel.
 *
 * Covers the data-integrity surface the page can't eyeball: which lines become
 * merchandise (order-attached + priced only), how the same article dedupes
 * across orders, how the six order stages collapse into the three availability
 * buckets, the per-article price (point + range + compound), and the material
 * search reaching down to the color code. Presentational concerns (card markup,
 * DOP formatting) live in the view and are intentionally not tested here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveStore,
  STORE_VIEW_MERCHANDISE,
  STORE_VIEW_MATERIALS,
} from '../src/core/store/index.js';

/* ------------------------------- fixtures -------------------------------- */

// A valid ISO 6346 number (HLBU123456 + check digit 4) so the container is
// trackable; an obviously invalid one to prove the filter drops it.
const VALID_CONTAINER = 'HLBU1234564';

function fixture() {
  const orders = [
    { id: 'o1', status: 'in_transit', placedAt: 1000, inTransitAt: 2000 },
    { id: 'o2', status: 'received', receivedAt: 3000 },
    { id: 'o3', status: 'cancelled', cancelledAt: 1500 },
  ];
  const quotes = [
    { id: 'q1', orderId: 'o1', status: 'accepted' },
    { id: 'q2', orderId: 'o2', status: 'accepted' },
    { id: 'q3', orderId: 'o3', status: 'accepted' }, // cancelled order → excluded
    { id: 'q4', orderId: null, status: 'draft' }, // no order → excluded
    { id: 'q5', orderId: 'o1', status: 'declined' }, // declined → excluded
  ];
  const lines = [
    // SOFA-1 quoted on BOTH o1 (in_transit) and o2 (received) → one deduped card.
    { id: 'l1', quoteId: 'q1', kind: 'item', reference: 'SOFA-1', name: 'Prado', family: 'Prado', unitPrice: 1000, qty: 2, imageId: 'img1' },
    { id: 'l2', quoteId: 'q2', kind: 'item', reference: 'SOFA-1', name: 'Prado', family: 'Prado', unitPrice: 1000, qty: 3 },
    // Excluded: a section divider and a parked optional add-on.
    { id: 'l3', quoteId: 'q1', kind: 'section', name: 'Sala' },
    { id: 'l4', quoteId: 'q1', kind: 'item', name: 'Lámpara', family: 'Luz', isOptional: true, unitPrice: 50, qty: 1 },
    // A material-less range line on o2 (received).
    { id: 'l5', quoteId: 'q2', kind: 'item', reference: 'CHAIR-9', name: 'Silla', family: 'Sillas', unitPrice: 0, qty: 1, priceMin: 200, priceMax: 400 },
    // A compound on o1 (in_transit): 500*1 + 300*2 = 1100.
    { id: 'l8', quoteId: 'q1', kind: 'item', name: 'Modular', family: 'Modular', components: [{ id: 'c1', unitPrice: 500, qty: 1 }, { id: 'c2', unitPrice: 300, qty: 2 }] },
    // Excluded: belongs to a cancelled order, and to an order-less quote.
    { id: 'l6', quoteId: 'q3', kind: 'item', reference: 'GHOST', unitPrice: 999, qty: 1 },
    { id: 'l7', quoteId: 'q4', kind: 'item', reference: 'GHOST2', unitPrice: 999, qty: 1 },
  ];
  const containers = [
    { id: 'k1', orderId: 'o1', number: 1, code: VALID_CONTAINER },
    { id: 'k2', orderId: 'o2', number: 2, code: 'NOT-A-CODE' },
  ];
  const materials = [
    { id: 'm1', category: 'fabric', name: 'Alcantara', grade: 'A', wearRating: '3C', composition: 'Poliéster', price: 50, priceUnit: 'yard', colors: [{ name: 'Antracita', code: '4479' }] },
    { id: 'm2', category: 'leather', name: 'Nappa', grade: 'U', price: 80, priceUnit: 'sm', colors: [{ name: 'Negro', code: '1001', imageId: 'mi1' }] },
    { id: 'm3', category: 'fabric', name: 'Descontinuado', grade: 'B', colors: [], discontinuedAt: 123 }, // excluded
  ];
  return { orders, quotes, lines, containers, materials };
}

function merch(overrides = {}) {
  return resolveStore({
    ...fixture(),
    view: STORE_VIEW_MERCHANDISE,
    q: '', tab: 'all', filters: {}, sort: { key: 'availability', dir: 'asc' },
    ...overrides,
  });
}

function mats(overrides = {}) {
  return resolveStore({
    ...fixture(),
    view: STORE_VIEW_MATERIALS,
    q: '', tab: 'all', filters: {}, sort: { key: 'name', dir: 'asc' },
    ...overrides,
  });
}

const byKey = (items, key) => items.find((c) => c.key === key);

/* ----------------------------- merchandise ------------------------------- */

test('only priced, order-attached lines become merchandise (deduped per article)', () => {
  const { items, segments } = merch();
  // SOFA-1, CHAIR-9, Modular. Section + optional + cancelled + order-less dropped.
  assert.equal(items.length, 3);
  assert.equal(segments.find((s) => s.key === STORE_VIEW_MERCHANDISE).count, 3);
  assert.ok(!items.some((c) => c.name === 'Lámpara' || c.name === 'Sala'));
  assert.ok(!items.some((c) => c.reference === 'GHOST' || c.reference === 'GHOST2'));
});

test('the same article on two orders aggregates qty, order count and best availability', () => {
  const sofa = byKey(merch().items, 'ref:SOFA-1');
  assert.ok(sofa);
  assert.equal(sofa.qty, 5); // 2 + 3
  assert.equal(sofa.orderCount, 2);
  // o2 (received) outranks o1 (in_transit) → the card reads as in-stock.
  assert.equal(sofa.availability.bucket, 'available');
  assert.equal(sofa.availability.label, 'Recibido');
  // Representative line (o2) had no photo → falls back to o1's imageId.
  assert.equal(sofa.imageId, 'img1');
});

test('availability buckets map from the order stage; price is a point value', () => {
  const modular = byKey(merch().items, 'n:modular|modular|');
  assert.ok(modular);
  assert.equal(modular.availability.bucket, 'incoming');
  assert.equal(modular.availability.label, 'En ruta');
  assert.deepEqual(modular.price, { value: 1100 }); // compound subtotal
});

test('a material-less line surfaces as a min–max range price', () => {
  const chair = byKey(merch().items, 'ref:CHAIR-9');
  assert.ok(chair);
  assert.deepEqual(chair.price, { min: 200, max: 400 });
});

test('only valid ISO 6346 containers attach as trackable', () => {
  const sofa = byKey(merch().items, 'ref:SOFA-1'); // on o1 (valid) + o2 (invalid)
  assert.equal(sofa.trackable.length, 1);
  assert.equal(sofa.trackable[0].code, VALID_CONTAINER);
  const chair = byKey(merch().items, 'ref:CHAIR-9'); // on o2 only (invalid code)
  assert.equal(chair.trackable.length, 0);
});

test('the incoming tab filters to en-camino merchandise', () => {
  const { items } = merch({ tab: 'incoming' });
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Modular');
});

test('search matches name, family and reference', () => {
  assert.equal(merch({ q: 'prado' }).items.length, 1);
  assert.equal(merch({ q: 'chair-9' }).items.length, 1);
  assert.equal(merch({ q: 'zzz' }).items.length, 0);
});

test('price sort orders by the comparable value (range uses its min)', () => {
  const names = merch({ sort: { key: 'price', dir: 'asc' } }).items.map((c) => c.name);
  // CHAIR-9 (min 200) < Prado (1000) < Modular (1100).
  assert.deepEqual(names, ['Silla', 'Prado', 'Modular']);
});

test('family filter narrows the grid', () => {
  const { items } = merch({ filters: { family: 'Modular' } });
  assert.equal(items.length, 1);
  assert.equal(items[0].family, 'Modular');
});

/* ------------------------------ materials -------------------------------- */

test('materials exclude discontinued; segment count reflects that', () => {
  const { items, segments } = mats();
  assert.equal(items.length, 2);
  assert.equal(segments.find((s) => s.key === STORE_VIEW_MATERIALS).count, 2);
  assert.ok(!items.some((c) => c.name === 'Descontinuado'));
});

test('material search reaches the color name and the LR code', () => {
  assert.equal(mats({ q: '4479' }).items.length, 1); // code
  assert.equal(mats({ q: 'antracita' }).items[0].name, 'Alcantara'); // color name
  assert.equal(mats({ q: 'negro' }).items[0].name, 'Nappa');
});

test('material card carries category, price unit, hero color and color count', () => {
  const alcantara = mats().items.find((c) => c.id === 'm1');
  assert.equal(alcantara.categoryLabel, 'Telas');
  assert.deepEqual(alcantara.price, { value: 50, unit: 'yard' });
  assert.equal(alcantara.heroColorCode, '4479');
  assert.equal(alcantara.colorCount, 1);
  assert.equal(alcantara.imageId, null); // no uploaded swatch → view falls back to the LR URL
  const nappa = mats().items.find((c) => c.id === 'm2');
  assert.equal(nappa.imageId, 'mi1'); // first color with an uploaded photo wins
});

test('category tab filters materials', () => {
  const { items } = mats({ tab: 'leather' });
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Nappa');
});
