/**
 * Tests for src/lib/shopifyCatalog.js — projecting a RosetSoft catalog MODEL
 * into the Shopify product the sync script upserts. Covers grade→variant
 * expansion, the stable idempotent handle, money-as-string, tag building, and
 * the drop-when-unpriced rule.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  modelHandle,
  toShopifyProduct,
  catalogToShopifyProducts,
} from '../src/lib/shopifyCatalog.js';
import { groupFamilies } from '../src/lib/catalog.js';

// Minimal Product factory — only the fields the mapper reads.
const P = (reference, priceUsd, extra = {}) => ({
  id: reference,
  profileId: 'team',
  reference,
  name: extra.name ?? 'Togo Fireside Chair',
  family: extra.family ?? 'TOGO',
  category: extra.category ?? 'Sofás',
  dimensions: extra.dimensions ?? 'H(70) W(87)',
  priceUsd,
  cost: extra.cost ?? 0,
  ...extra,
});

/* --------------------------------- handle --------------------------------- */

test('modelHandle is stable, lower-cased, and root-only', () => {
  assert.equal(modelHandle('15420000'), 'lr-15420000');
  assert.equal(modelHandle('ABC 12/34'), 'lr-abc-12-34');
});

/* ------------------------------ graded model ------------------------------ */

test('a fabric-graded model becomes one product with a variant per grade', () => {
  // Two grade variants sharing the 8-digit root → a graded model.
  const products = [P('15420000A', 1000), P('15420000G', 1500)];
  const [prod] = catalogToShopifyProducts(products);

  assert.equal(prod.handle, 'lr-15420000');
  assert.equal(prod.title, 'Togo Fireside Chair');
  assert.equal(prod.vendor, 'Ligne Roset');
  assert.equal(prod.productType, 'Sofás');
  assert.equal(prod.status, 'DRAFT');
  assert.equal(prod.optionName, 'Grado');
  assert.deepEqual(prod.variants, [
    { sku: '15420000A', price: '1000.00', grade: 'A' },
    { sku: '15420000G', price: '1500.00', grade: 'G' },
  ]);
  assert.equal(prod.priceMin, 1000);
  assert.equal(prod.priceMax, 1500);
  // Tags carry category + family + vendor + a provenance tag, deduped.
  assert.ok(prod.tags.includes('Sofás'));
  assert.ok(prod.tags.includes('TOGO'));
  assert.ok(prod.tags.includes('Ligne Roset'));
  assert.ok(prod.tags.includes('rosetsoft'));
});

/* ----------------------------- ungraded model ----------------------------- */

test('an ungraded SKU becomes a single-variant product (no option)', () => {
  const products = [P('TABLE001', 800, { name: 'Eros Table', family: 'EROS', category: 'Mesas' })];
  const [prod] = catalogToShopifyProducts(products);

  assert.equal(prod.optionName, null);
  assert.deepEqual(prod.variants, [{ sku: 'TABLE001', price: '800.00', grade: null }]);
  assert.equal(prod.priceMin, 800);
  assert.equal(prod.priceMax, 800);
});

test('a lone 8-digit+letter SKU is ungraded (a finish code, not a grade)', () => {
  const fam = groupFamilies([P('10000552H', 6410, { name: 'Moel Armchair' })])[0];
  const prod = toShopifyProduct(fam);
  assert.equal(prod.optionName, null);
  assert.equal(prod.variants.length, 1);
  assert.equal(prod.variants[0].grade, null);
});

/* ------------------------------ pricing rules ----------------------------- */

test('unpriced grades are dropped; a model with nothing priced maps to null', () => {
  // One priced grade, one zero-price grade → only the priced one survives.
  const partial = groupFamilies([P('22220000A', 0), P('22220000G', 1200)])[0];
  const prod = toShopifyProduct(partial);
  assert.equal(prod.variants.length, 1);
  assert.equal(prod.variants[0].sku, '22220000G');

  // Every variant unpriced → nothing sellable → null.
  const dead = groupFamilies([P('33330000A', 0), P('33330000G', 0)])[0];
  assert.equal(toShopifyProduct(dead), null);
});

/* -------------------------------- options --------------------------------- */

test('status and extra tags are honored', () => {
  const fam = groupFamilies([P('44440000A', 500), P('44440000G', 700)])[0];
  const prod = toShopifyProduct(fam, { status: 'ACTIVE', extraTags: ['lookbook'] });
  assert.equal(prod.status, 'ACTIVE');
  assert.ok(prod.tags.includes('lookbook'));
});
