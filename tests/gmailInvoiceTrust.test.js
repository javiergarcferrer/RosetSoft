/**
 * Tests for resolveInvoiceTrust (src/core/crm/views/gmailInbox.js) — the BEC /
 * fake-invoice sender-trust gate. Pins the fail-safe rule: auto-trust ONLY on
 * dmarc=pass + a known supplier domain; failed auth → suspect; everything else
 * (incl. missing auth data) → human review. The From display name is never
 * trusted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveInvoiceTrust } from '../src/core/crm/views/gmailInbox.js';

const ALLOW = ['ligne-roset.com', 'proveedor.do'];

test('dmarc=pass + known supplier domain → trusted', () => {
  const t = resolveInvoiceTrust(
    { fromEmail: 'billing@ligne-roset.com', authResults: 'spf=pass dkim=pass dmarc=pass' },
    { supplierAllowlist: ALLOW },
  );
  assert.equal(t.level, 'trusted');
  assert.equal(t.domain, 'ligne-roset.com');
});

test('subdomain of a known supplier is still trusted', () => {
  const t = resolveInvoiceTrust(
    { fromEmail: 'no-reply@mail.proveedor.do', authResults: 'dmarc=pass spf=pass' },
    { supplierAllowlist: ALLOW },
  );
  assert.equal(t.level, 'trusted');
});

test('dmarc=fail → suspect (likely spoofed), regardless of allow-list', () => {
  const t = resolveInvoiceTrust(
    { fromEmail: 'billing@ligne-roset.com', authResults: 'spf=fail dkim=fail dmarc=fail' },
    { supplierAllowlist: ALLOW },
  );
  assert.equal(t.level, 'suspect');
});

test('authenticated but UNKNOWN domain → review, never trusted', () => {
  const t = resolveInvoiceTrust(
    { fromEmail: 'invoices@random-vendor.com', authResults: 'dmarc=pass spf=pass dkim=pass' },
    { supplierAllowlist: ALLOW },
  );
  assert.equal(t.level, 'review');
});

test('known domain but NO dmarc pass → review (fail safe)', () => {
  const t = resolveInvoiceTrust(
    { fromEmail: 'billing@ligne-roset.com', authResults: 'spf=pass dkim=none dmarc=none' },
    { supplierAllowlist: ALLOW },
  );
  assert.equal(t.level, 'review');
});

test('missing Authentication-Results (older rows) → review, not trusted', () => {
  const t = resolveInvoiceTrust(
    { fromEmail: 'billing@ligne-roset.com' },
    { supplierAllowlist: ALLOW },
  );
  assert.equal(t.level, 'review');
  assert.ok(t.reasons.length > 0);
});

test('no allow-list configured → authenticated mail still needs review', () => {
  const t = resolveInvoiceTrust({ fromEmail: 'x@ligne-roset.com', authResults: 'dmarc=pass' }, {});
  assert.equal(t.level, 'review');
});

test('undefined message does not throw', () => {
  assert.doesNotThrow(() => resolveInvoiceTrust(undefined, {}));
  assert.equal(resolveInvoiceTrust(undefined, {}).level, 'review');
});
