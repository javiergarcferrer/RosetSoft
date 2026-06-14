// Pins resolveTemplateHealth — the WhatsApp template-health ViewModel that
// merges the live Meta template list with the durable wa_template_rejections
// records and surfaces a dealer-readable Spanish rejection reason.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTemplateHealth } from '../src/core/crm/index.js';

test('approved templates carry no rejection reason', () => {
  const [row] = resolveTemplateHealth(
    [{ name: 'saludo', language: 'es', status: 'APPROVED', category: 'MARKETING' }],
    [],
  );
  assert.equal(row.status, 'APPROVED');
  assert.equal(row.rejected, false);
  assert.equal(row.reason, '');
  assert.equal(row.reasonCode, '');
});

test('a rejected template maps its live reason code to Spanish', () => {
  const [row] = resolveTemplateHealth(
    [{ name: 'promo', language: 'es', status: 'REJECTED', category: 'UTILITY', rejectedReason: 'TAG_CONTENT_MISMATCH' }],
    [],
  );
  assert.equal(row.rejected, true);
  assert.equal(row.reasonCode, 'TAG_CONTENT_MISMATCH');
  assert.match(row.reason, /categoría/i);
});

test('falls back to the persisted rejection record when the live reason is absent', () => {
  const [row] = resolveTemplateHealth(
    [{ name: 'promo', language: 'es', status: 'REJECTED', category: 'MARKETING' }],
    [{ templateName: 'promo', language: 'es', rejectedReason: 'SCAM' }],
  );
  assert.equal(row.reasonCode, 'SCAM');
  assert.match(row.reason, /estafa/i);
});

test('persisted record matches by name when language differs / is missing', () => {
  const [row] = resolveTemplateHealth(
    [{ name: 'promo', language: 'es', status: 'REJECTED' }],
    [{ templateName: 'promo', language: '', rejectedReason: 'INVALID_FORMAT' }],
  );
  assert.equal(row.reasonCode, 'INVALID_FORMAT');
  assert.match(row.reason, /formato/i);
});

test('unknown reason codes are humanized, not dropped', () => {
  const [row] = resolveTemplateHealth(
    [{ name: 'x', language: 'es', status: 'REJECTED', rejectedReason: 'SOME_NEW_CODE' }],
    [],
  );
  assert.equal(row.reasonCode, 'SOME_NEW_CODE');
  assert.equal(row.reason, 'Some new code');
});

test('NONE / empty reason on a rejected template yields no reason text', () => {
  const [row] = resolveTemplateHealth(
    [{ name: 'x', language: 'es', status: 'REJECTED', rejectedReason: 'NONE' }],
    [],
  );
  assert.equal(row.rejected, true);
  assert.equal(row.reason, '');
});

test('a non-rejected template ignores any stale persisted rejection', () => {
  const [row] = resolveTemplateHealth(
    [{ name: 'promo', language: 'es', status: 'APPROVED' }],
    [{ templateName: 'promo', language: 'es', rejectedReason: 'SCAM' }],
  );
  assert.equal(row.rejected, false);
  assert.equal(row.reasonCode, '');
  assert.equal(row.reason, '');
});

test('output preserves input order and shape', () => {
  const rows = resolveTemplateHealth(
    [
      { name: 'a', language: 'es', status: 'APPROVED' },
      { name: 'b', language: 'en_US', status: 'REJECTED', rejectedReason: 'ABUSIVE_CONTENT' },
      { name: 'c', language: 'es', status: 'PENDING' },
    ],
    [],
  );
  assert.deepEqual(rows.map((r) => r.name), ['a', 'b', 'c']);
  assert.equal(rows[1].language, 'en_US');
  assert.match(rows[1].reason, /abusiv/i);
});

test('handles null / undefined inputs without throwing', () => {
  assert.deepEqual(resolveTemplateHealth(null, null), []);
  assert.deepEqual(resolveTemplateHealth(undefined, undefined), []);
});
