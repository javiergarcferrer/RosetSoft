/**
 * Tests for src/core/catalog/lsgBook.js — the LifestyleGarden catalog book
 * the client PDF prints. Pins the data-integrity rules of a client-facing
 * artifact: ONLY in-stock pieces appear (stockQty > 0 — never null/0/negative
 * once stock data exists), the pre-stock state is flagged instead of rendered
 * as "all sold out", and the per-model quantity/price figures come only from
 * the in-stock members.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { lsgModelTitle, groupLsgModels, resolveLsgCatalogBook } from '../src/core/catalog/lsgBook.js';

let seq = 0;
function row(over = {}) {
  seq += 1;
  return {
    id: `lsg-${seq}`,
    profileId: 'team',
    brand: 'lifestylegarden',
    reference: `REF-${seq}`,
    name: 'Garnet Lounge Chair',
    subtype: '',
    family: 'Garnet',
    familyCode: 'garnet-lounge-chair',
    category: 'Garnet',
    priceUsd: 988.2,
    stockQty: 3,
    imageId: null,
    imageSrc: '',
    active: true,
    ...over,
  };
}

/* ------------------------------ model grouping ------------------------------ */

test('lsgModelTitle strips the " · variant" suffix the import appends', () => {
  assert.equal(lsgModelTitle({ name: 'Nassau Sofa · Teak', subtype: 'Teak' }), 'Nassau Sofa');
  assert.equal(lsgModelTitle({ name: 'Nassau Sofa', subtype: '' }), 'Nassau Sofa');
  assert.equal(lsgModelTitle({ name: '', reference: 'A-1' }), 'A-1');
});

test('groupLsgModels folds variants into one model, cheap→dear, models alphabetized', () => {
  const models = groupLsgModels([
    row({ name: 'Nassau Sofa · Teak', subtype: 'Teak', familyCode: 'nassau-sofa', priceUsd: 1200 }),
    row({ name: 'Aria Chair', familyCode: 'aria-chair', priceUsd: 300 }),
    row({ name: 'Nassau Sofa · White', subtype: 'White', familyCode: 'nassau-sofa', priceUsd: 900 }),
  ]);
  assert.deepEqual(models.map((m) => m.name), ['Aria Chair', 'Nassau Sofa']);
  assert.deepEqual(models[1].members.map((p) => p.priceUsd), [900, 1200]);
});

/* ----------------------------- the in-stock gate ----------------------------- */

test('only stockQty > 0 enters the book — 0, negative and null members drop', () => {
  const book = resolveLsgCatalogBook([
    row({ familyCode: 'a', stockQty: 2 }),
    row({ familyCode: 'b', stockQty: 0 }),
    row({ familyCode: 'c', stockQty: -1 }),
    row({ familyCode: 'd', stockQty: null }),
  ]);
  assert.equal(book.hasStockData, true);
  assert.equal(book.skus, 1);
  assert.equal(book.models, 1);
  assert.equal(book.sections[0].models[0].members[0].stockQty, 2);
});

test('an out-of-stock VARIANT drops from its model; the model keeps the rest', () => {
  const book = resolveLsgCatalogBook([
    row({ name: 'Nassau Sofa · Teak', subtype: 'Teak', familyCode: 'nassau-sofa', priceUsd: 1200, stockQty: 2 }),
    row({ name: 'Nassau Sofa · White', subtype: 'White', familyCode: 'nassau-sofa', priceUsd: 900, stockQty: 0 }),
  ]);
  const model = book.sections[0].models[0];
  assert.equal(model.members.length, 1);
  assert.equal(model.members[0].subtype, 'Teak');
  // Quantity and price range read from the in-stock members only.
  assert.equal(model.stockQty, 2);
  assert.equal(model.priceMin, 1200);
  assert.equal(model.priceMax, 1200);
});

test('pre-stock rows (every stockQty null) flag hasStockData instead of an empty lie', () => {
  const book = resolveLsgCatalogBook([row({ stockQty: null }), row({ stockQty: null })]);
  assert.equal(book.hasStockData, false);
  assert.deepEqual(book.sections, []);
  assert.equal(book.skus, 0);
});

test('inactive rows never enter the book', () => {
  const book = resolveLsgCatalogBook([row({ active: false, stockQty: 5 }), row({ stockQty: 1 })]);
  assert.equal(book.skus, 1);
});

/* ------------------------------- model figures ------------------------------- */

test('model stockQty sums variants; price range spans them', () => {
  const book = resolveLsgCatalogBook([
    row({ subtype: 'Teak', name: 'Nassau Sofa · Teak', familyCode: 'nassau-sofa', priceUsd: 1200, stockQty: 2 }),
    row({ subtype: 'White', name: 'Nassau Sofa · White', familyCode: 'nassau-sofa', priceUsd: 900, stockQty: 3 }),
  ]);
  const model = book.sections[0].models[0];
  assert.equal(model.stockQty, 5);
  assert.equal(model.priceMin, 900);
  assert.equal(model.priceMax, 1200);
});

test('the card link and photo come from the lead (cheapest in-stock) member', () => {
  const book = resolveLsgCatalogBook([
    row({ subtype: 'Teak', name: 'Nassau Sofa · Teak', familyCode: 'nassau-sofa', priceUsd: 1200, stockQty: 1, imageId: 'img-dear' }),
    row({ subtype: 'White', name: 'Nassau Sofa · White', familyCode: 'nassau-sofa', priceUsd: 900, stockQty: 1, imageId: 'img-cheap', imageSrc: 'https://cdn.shopify.com/x.jpg' }),
  ]);
  const model = book.sections[0].models[0];
  assert.equal(model.storeUrl, 'https://www.lifestylegarden.do/products/nassau-sofa');
  assert.equal(model.imageId, 'img-cheap');
  assert.equal(model.imageSrc, 'https://cdn.shopify.com/x.jpg');
});

/* --------------------------------- sections --------------------------------- */

test('sections sort alphabetically with the no-collection bucket last', () => {
  const book = resolveLsgCatalogBook([
    row({ familyCode: 'a', category: '' }),
    row({ familyCode: 'b', category: 'Nassau' }),
    row({ familyCode: 'c', category: 'Aria' }),
  ]);
  assert.deepEqual(book.sections.map((s) => s.category), ['Aria', 'Nassau', '']);
});
