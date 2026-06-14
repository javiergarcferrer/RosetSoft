// Pins the PURE Shopify orders Model (src/lib/shopifyOrders.ts) — fulfillment
// state collapse, the canFulfill predicate, and item-count totals. These drive
// the orders control center's status pills + "Marcar como preparado" gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fulfillmentState,
  canFulfill,
  orderTotals,
  customerName,
  openFulfillmentOrder,
} from '../src/lib/shopifyOrders.ts';

const order = (over = {}) => ({
  id: 'gid://shopify/Order/1',
  name: '#1001',
  displayFulfillmentStatus: 'UNFULFILLED',
  lineItems: { nodes: [{ title: 'Togo', quantity: 2, sku: 'TGO' }, { title: 'Ottoman', quantity: 1, sku: 'OTT' }] },
  fulfillmentOrders: { nodes: [{ id: 'gid://shopify/FulfillmentOrder/9', status: 'OPEN', lineItems: { nodes: [{ id: 'foli-1', remainingQuantity: 3 }] } }] },
  ...over,
});

test('fulfillmentState: collapses Shopify status to three states', () => {
  assert.equal(fulfillmentState(order({ displayFulfillmentStatus: 'FULFILLED' })), 'fulfilled');
  assert.equal(fulfillmentState(order({ displayFulfillmentStatus: 'PARTIALLY_FULFILLED' })), 'partial');
  assert.equal(fulfillmentState(order({ displayFulfillmentStatus: 'UNFULFILLED' })), 'unfulfilled');
  // Unknown / restocked / scheduled fall back to unfulfilled.
  assert.equal(fulfillmentState(order({ displayFulfillmentStatus: 'ON_HOLD' })), 'unfulfilled');
  assert.equal(fulfillmentState(null), 'unfulfilled');
  assert.equal(fulfillmentState({}), 'unfulfilled');
});

test('openFulfillmentOrder: first open FO with remaining quantity', () => {
  assert.equal(openFulfillmentOrder(order())?.id, 'gid://shopify/FulfillmentOrder/9');
  // Closed / cancelled / zero-remaining are skipped.
  assert.equal(openFulfillmentOrder(order({
    fulfillmentOrders: { nodes: [
      { id: 'a', status: 'CLOSED', lineItems: { nodes: [{ id: 'x', remainingQuantity: 5 }] } },
      { id: 'b', status: 'OPEN', lineItems: { nodes: [{ id: 'y', remainingQuantity: 0 }] } },
      { id: 'c', status: 'OPEN', lineItems: { nodes: [{ id: 'z', remainingQuantity: 1 }] } },
    ] },
  }))?.id, 'c');
  assert.equal(openFulfillmentOrder(order({ fulfillmentOrders: { nodes: [] } })), null);
});

test('canFulfill: needs an open FO with remaining and not already fulfilled', () => {
  assert.equal(canFulfill(order()), true);
  // Already fully fulfilled → never fulfillable, even if an FO lingers.
  assert.equal(canFulfill(order({ displayFulfillmentStatus: 'FULFILLED' })), false);
  // No open FO with remaining → not fulfillable.
  assert.equal(canFulfill(order({ fulfillmentOrders: { nodes: [{ id: 'a', status: 'CLOSED', lineItems: { nodes: [{ id: 'x', remainingQuantity: 2 }] } }] } })), false);
  assert.equal(canFulfill(null), false);
});

test('orderTotals: distinct lines and total units', () => {
  assert.deepEqual(orderTotals(order()), { lines: 2, units: 3 });
  assert.deepEqual(orderTotals(order({ lineItems: { nodes: [] } })), { lines: 0, units: 0 });
  assert.deepEqual(orderTotals(null), { lines: 0, units: 0 });
});

test('customerName: joins first + last, tolerates missing parts', () => {
  assert.equal(customerName(order({ customer: { firstName: 'Ana', lastName: 'Pérez' } })), 'Ana Pérez');
  assert.equal(customerName(order({ customer: { firstName: 'Ana', lastName: null } })), 'Ana');
  assert.equal(customerName(order({ customer: null })), '');
  assert.equal(customerName(null), '');
});
