/**
 * Tests for src/lib/statusPill.js — the centralized status → pill + label map.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { quoteStagePill, orderStatusPill } from '../src/lib/statusPill.js';

test('quoteStagePill maps each stage to its pill + Spanish label', () => {
  assert.deepEqual(quoteStagePill('draft'), { cls: 'status-pill-draft', label: 'Borrador' });
  assert.deepEqual(quoteStagePill('sent'), { cls: 'status-pill-sent', label: 'Enviada' });
  assert.deepEqual(quoteStagePill('accepted'), { cls: 'status-pill-accepted', label: 'Aceptada' });
  assert.deepEqual(quoteStagePill('deposito_recibido'), { cls: 'status-pill-deposito', label: 'Depósito recibido' });
  assert.deepEqual(quoteStagePill('declined'), { cls: 'status-pill-declined', label: 'Rechazada' });
  assert.deepEqual(quoteStagePill('archived'), { cls: 'status-pill-archived', label: 'Archivada' });
});

test('quoteStagePill falls back to Borrador for unknown / null', () => {
  assert.deepEqual(quoteStagePill(null), { cls: 'status-pill-draft', label: 'Borrador' });
  assert.deepEqual(quoteStagePill('weird'), { cls: 'status-pill-draft', label: 'Borrador' });
});

test('orderStatusPill maps each order status to its pill', () => {
  assert.equal(orderStatusPill('placed').cls, 'status-pill-sent');
  assert.equal(orderStatusPill('confirmed').cls, 'status-pill-accepted');
  assert.equal(orderStatusPill('in_customs').cls, 'status-pill-pending');
  assert.equal(orderStatusPill('received').cls, 'status-pill-active');
  assert.equal(orderStatusPill('cancelled').cls, 'status-pill-declined');
  // labels come from the order-stage definitions (non-empty)
  assert.ok(orderStatusPill('placed').label.length > 0);
});

test('orderStatusPill falls back for unknown / null', () => {
  assert.equal(orderStatusPill(null).cls, 'status-pill-draft');
  assert.equal(orderStatusPill('nope').cls, 'status-pill-draft');
});
