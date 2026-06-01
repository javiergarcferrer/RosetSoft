/**
 * Tests for the RNC/cédula parsing helpers (src/lib/rncLookup.js). The network
 * lookup itself goes through the rnc-lookup Edge Function and isn't unit-tested
 * here; this covers the input cleaning + validation (data-integrity).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanRnc, isValidRncOrCedula, rncKind } from '../src/lib/rncLookup.js';

test('cleanRnc keeps digits only', () => {
  assert.equal(cleanRnc('131-99603-5'), '131996035');
  assert.equal(cleanRnc('001-1234567-8'), '00112345678');
  assert.equal(cleanRnc('  131 996 035 '), '131996035');
  assert.equal(cleanRnc(null), '');
});

test('isValidRncOrCedula accepts 9 (RNC) or 11 (cédula) digits', () => {
  assert.equal(isValidRncOrCedula('131996035'), true);   // RNC
  assert.equal(isValidRncOrCedula('001-1234567-8'), true); // cédula
  assert.equal(isValidRncOrCedula('123'), false);
  assert.equal(isValidRncOrCedula('1234567890'), false);   // 10 digits
});

test('rncKind: 11 digits → física, 9 → jurídica', () => {
  assert.equal(rncKind('131996035'), 'juridica');
  assert.equal(rncKind('00112345678'), 'fisica');
});
