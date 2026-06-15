// Tests for src/core/crm/views/health.js — the WhatsApp reception-health VM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWaHealth } from '../src/core/crm/views/health.js';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const HOUR = 3_600_000;

test('ok when no verified delivery failed to store', () => {
  const h = resolveWaHealth({ failedEvents: [], lastInboundAt: NOW - 2 * HOUR, now: NOW });
  assert.equal(h.status, 'ok');
  assert.equal(h.failedCount, 0);
  assert.equal(h.errorSample, null);
  assert.equal(h.oldestFailedAt, null);
  assert.equal(h.hoursSinceInbound, 2);
  assert.equal(h.lastInboundAt, NOW - 2 * HOUR);
});

test('down when one or more deliveries failed to persist', () => {
  const h = resolveWaHealth({
    failedEvents: [
      { receivedAt: NOW - 5 * 60_000, processError: 'inbound wamid.X: timeout' },
      { receivedAt: NOW - 30 * 60_000, processError: 'inbound wamid.Y: 503' },
    ],
    lastInboundAt: null,
    now: NOW,
  });
  assert.equal(h.status, 'down');
  assert.equal(h.failedCount, 2);
  // First row's error is the sample; oldest receivedAt across the set.
  assert.equal(h.errorSample, 'inbound wamid.X: timeout');
  assert.equal(h.oldestFailedAt, NOW - 30 * 60_000);
  // No inbound ever → null, never a bogus "hours since".
  assert.equal(h.lastInboundAt, null);
  assert.equal(h.hoursSinceInbound, null);
});

test('an unprocessed row without an error string still counts as down', () => {
  // processed=false but processError null (e.g. the final mark-update was lost)
  // is still a delivery we cannot prove was stored — treat it as a concern.
  const h = resolveWaHealth({ failedEvents: [{ receivedAt: 1000, processError: null }], now: NOW });
  assert.equal(h.status, 'down');
  assert.equal(h.failedCount, 1);
  assert.equal(h.errorSample, null);
  assert.equal(h.oldestFailedAt, 1000);
});

test('inbound within the last hour reports 0 hours, not null', () => {
  const h = resolveWaHealth({ lastInboundAt: NOW - 10 * 60_000, now: NOW });
  assert.equal(h.hoursSinceInbound, 0);
});

test('tolerates no arguments / nullish input', () => {
  const h = resolveWaHealth();
  assert.equal(h.status, 'ok');
  assert.equal(h.failedCount, 0);
  assert.equal(h.lastInboundAt, null);
  assert.equal(h.hoursSinceInbound, null);
  const h2 = resolveWaHealth({ failedEvents: null, lastInboundAt: undefined });
  assert.equal(h2.status, 'ok');
  assert.equal(h2.failedCount, 0);
});
