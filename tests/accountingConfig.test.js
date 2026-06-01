/**
 * Tests for src/lib/accounting/config.ts — the tax-parameter + posting-account
 * map resolution. Data-integrity territory: a wrong default account or rate
 * mis-books every downstream asiento.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POSTING_ROLES, TAX_DEFAULTS, resolveAccountingConfig, accountFor, itbisOn,
} from '../src/lib/accounting/config.js';

test('every posting role has a unique key and a chart-shaped default code', () => {
  const keys = new Set();
  for (const r of POSTING_ROLES) {
    assert.ok(!keys.has(r.key), `duplicate role key ${r.key}`);
    keys.add(r.key);
    assert.match(r.defaultCode, /^\d-\d\d-\d\d\d-\d\d-\d\d-\d\d$/, `bad code for ${r.key}`);
  }
});

test('resolveAccountingConfig fills every role and rate from defaults', () => {
  const cfg = resolveAccountingConfig(null);
  assert.equal(cfg.itbisRate, 18);
  assert.equal(cfg.dutyRate, 20);
  assert.equal(cfg.retentionIsrServicesRate, TAX_DEFAULTS.retentionIsrServicesRate);
  for (const r of POSTING_ROLES) {
    assert.equal(cfg.postingMap[r.key], r.defaultCode);
  }
});

test('resolveAccountingConfig applies saved overrides over defaults', () => {
  const cfg = resolveAccountingConfig({
    itbisRate: 16,
    postingMap: { salesLocal: '4-01-001-02-00-00' },
  });
  assert.equal(cfg.itbisRate, 16);
  assert.equal(cfg.dutyRate, 20); // untouched → default
  assert.equal(cfg.postingMap.salesLocal, '4-01-001-02-00-00'); // overridden
  assert.equal(cfg.postingMap.itbisPayable, '2-01-003-01-00-00'); // still default
});

test('accountFor returns the override, then the default', () => {
  assert.equal(accountFor(null, 'itbisPayable'), '2-01-003-01-00-00');
  assert.equal(
    accountFor({ postingMap: { itbisPayable: '2-01-003-09-00-00' } }, 'itbisPayable'),
    '2-01-003-09-00-00',
  );
  assert.equal(accountFor(null, 'nope'), null);
});

test('itbisOn applies the configured rate, rounded to cents', () => {
  const cfg = resolveAccountingConfig(null);
  assert.equal(itbisOn(10000, cfg), 1800);
  assert.equal(itbisOn(1234.5, cfg), 222.21);
});
