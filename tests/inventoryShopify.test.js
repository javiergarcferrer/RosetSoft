/**
 * Tests for src/lib/inventoryShopify.js — deciding how an in-stock inventory
 * item maps onto its Shopify catalog listing (upsert) or leaves the catalog
 * (remove) when it sells out or has no permanent price yet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { pieceHandle, resolvePieceSync } from '../src/lib/inventoryShopify.js';

const item = (over = {}) => ({
  id: 'inv_abc123',
  profileId: 'team',
  sku: '15420000-ALCANTARA-SAGE',
  name: 'Togo Fireside Chair — Alcantara Sage',
  unit: 'unidad',
  qtyOnHand: 1,
  avgCost: 1800,
  sellingPrice: 3420,
  imageId: 'img_1',
  ...over,
});

test('handle is stable and id-based (non-alphanumerics → hyphens)', () => {
  assert.equal(pieceHandle({ id: 'inv_abc123' }), 'inv-inv-abc123');
  assert.equal(pieceHandle({ id: 'A/B 9' }), 'inv-a-b-9');
});

test('an in-stock, priced item upserts with the PO price and on-hand qty', () => {
  const r = resolvePieceSync(item({ qtyOnHand: 2 }), 'https://x/img.jpg');
  assert.equal(r.action, 'upsert');
  assert.equal(r.piece.handle, 'inv-inv-abc123');
  assert.equal(r.piece.title, 'Togo Fireside Chair — Alcantara Sage');
  assert.equal(r.piece.sku, '15420000-ALCANTARA-SAGE');
  assert.equal(r.piece.price, '3420.00'); // permanent price, as a money string
  assert.equal(r.piece.quantity, 2);
  assert.equal(r.piece.imageUrl, 'https://x/img.jpg');
});

test('sold out (qty 0) leaves the catalog', () => {
  const r = resolvePieceSync(item({ qtyOnHand: 0 }), 'https://x/img.jpg');
  assert.deepEqual(r, { action: 'remove', reason: 'out_of_stock' });
});

test('no permanent price yet → kept off the store', () => {
  const r = resolvePieceSync(item({ sellingPrice: null }));
  assert.deepEqual(r, { action: 'remove', reason: 'no_price' });
});

test('title falls back to SKU; missing image is null; qty floored', () => {
  const r = resolvePieceSync(item({ name: '', qtyOnHand: 3.9, imageId: null }));
  assert.equal(r.action, 'upsert');
  assert.equal(r.piece.title, '15420000-ALCANTARA-SAGE');
  assert.equal(r.piece.quantity, 3);
  assert.equal(r.piece.imageUrl, null);
});
