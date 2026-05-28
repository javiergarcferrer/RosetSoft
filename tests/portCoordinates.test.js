/**
 * Tests for src/lib/portCoordinates.ts — the bundled UN/LOCODE → coordinate
 * table that lets the Track & Trace timeline render as a map.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { lookupPort, KNOWN_PORT_COUNT } from '../src/lib/portCoordinates.js';

test('lookupPort resolves known codes, case/separator-insensitively', () => {
  const leh = lookupPort('FRLEH');
  assert.equal(leh.name, 'Le Havre');
  assert.ok(Math.abs(leh.lat - 49.4861) < 0.001);
  assert.ok(Math.abs(leh.lon - 0.1056) < 0.001);
  // Tolerant of lowercase and embedded separators.
  assert.equal(lookupPort('fr leh').name, 'Le Havre');
  assert.equal(lookupPort('do-cau').name, 'Caucedo');
});

test('lookupPort returns null for unknown / empty input', () => {
  assert.equal(lookupPort('ZZZZZ'), null);
  assert.equal(lookupPort(''), null);
  assert.equal(lookupPort(null), null);
  assert.equal(lookupPort(undefined), null);
});

test('the bundled table carries the core France→Caribbean ports', () => {
  for (const code of ['FRLEH', 'FRFOS', 'ESALG', 'MAPTM', 'DOCAU', 'DOHAI', 'PRSJU', 'JMKIN']) {
    assert.ok(lookupPort(code), `expected ${code} in table`);
  }
  assert.ok(KNOWN_PORT_COUNT >= 40, `expected a broad table, got ${KNOWN_PORT_COUNT}`);
});
