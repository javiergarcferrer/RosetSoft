/**
 * Tests for src/lib/containerTracking.ts — the ISO 6346 container-number
 * validation, the carrier hint, and the DCSA Track & Trace event shaping
 * that backs the "Rastrear" panel in OrderDetail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeContainerNo,
  iso6346CheckDigit,
  validateContainerNo,
  isValidContainerNo,
  detectCarrier,
  normalizeEvent,
  summarizeTracking,
} from '../src/lib/containerTracking.js';

/* ----------------------------- ISO 6346 ----------------------------- */

test('iso6346CheckDigit matches known examples', () => {
  // CSQU3054383 is the canonical worked example in the ISO 6346 docs.
  assert.equal(iso6346CheckDigit('CSQU305438'), 3);
  // HLBU1234564 — computed by hand from the spec weights.
  assert.equal(iso6346CheckDigit('HLBU123456'), 4);
});

test('iso6346CheckDigit rejects a malformed prefix', () => {
  assert.equal(iso6346CheckDigit('CSQU30543'), null);   // too short
  assert.equal(iso6346CheckDigit('CSQ12345678'), null); // wrong letter/digit split
});

test('normalizeContainerNo uppercases and strips separators', () => {
  assert.equal(normalizeContainerNo('  hlbu-123456 4 '), 'HLBU1234564');
  assert.equal(normalizeContainerNo(null), '');
});

/* --------------------------- validation ----------------------------- */

test('validateContainerNo accepts a correct number', () => {
  assert.deepEqual(validateContainerNo('CSQU3054383'), { status: 'valid', value: 'CSQU3054383' });
  // Lowercase + spaces still validate (normalized first).
  assert.equal(validateContainerNo('hlbu 1234564').status, 'valid');
  assert.equal(isValidContainerNo('HLBU1234564'), true);
});

test('validateContainerNo flags a bad check digit with the expected one', () => {
  const v = validateContainerNo('CSQU3054384'); // correct check digit is 3
  assert.equal(v.status, 'invalid');
  assert.equal(v.reason, 'checkDigit');
  assert.equal(v.expectedCheckDigit, 3);
});

test('validateContainerNo flags a malformed number and empty input', () => {
  assert.equal(validateContainerNo('MSCU12345').reason, 'format'); // too short
  assert.equal(validateContainerNo('HELLOWORLD1').reason, 'format');
  assert.equal(validateContainerNo('').status, 'empty');
});

/* --------------------------- carrier hint --------------------------- */

test('detectCarrier maps owner prefixes (and ignores the rest)', () => {
  assert.equal(detectCarrier('HLBU1234564'), 'Hapag-Lloyd');
  assert.equal(detectCarrier('mscu1234565'), 'MSC');     // case-insensitive
  assert.equal(detectCarrier('ZZZU0000000'), null);      // unknown prefix
  assert.equal(detectCarrier('AB'), null);               // too short
});

/* ----------------------- event normalization ------------------------ */

test('normalizeEvent flattens a transport event', () => {
  const m = normalizeEvent({
    eventType: 'TRANSPORT',
    eventClassifierCode: 'ACT',
    eventDateTime: '2026-05-01T10:00:00Z',
    transportEventTypeCode: 'DEPA',
    transportCall: {
      modeOfTransport: 'VESSEL',
      UNLocationCode: 'FRLEH',
      vessel: { vesselName: 'King of the Seas' },
      exportVoyageNumber: '2103S',
    },
  });
  assert.equal(m.code, 'DEPA');
  assert.equal(m.label, 'Salida');
  assert.equal(m.mode, 'VESSEL');
  assert.equal(m.location, 'FRLEH');
  assert.equal(m.vessel, 'King of the Seas');
  assert.equal(m.voyage, '2103S');
  assert.equal(m.at, Date.parse('2026-05-01T10:00:00Z'));
});

/* -------------------------- summarizeTracking ----------------------- */

test('summarizeTracking sorts, and derives last (actual) + eta (estimate)', () => {
  const events = [
    {
      eventType: 'TRANSPORT', eventClassifierCode: 'ACT', eventDateTime: '2026-05-01T10:00:00Z',
      transportEventTypeCode: 'DEPA',
      transportCall: { modeOfTransport: 'VESSEL', UNLocationCode: 'FRLEH', vessel: { vesselName: 'King of the Seas' } },
    },
    {
      eventType: 'EQUIPMENT', eventClassifierCode: 'ACT', eventDateTime: '2026-04-28T08:00:00Z',
      equipmentEventTypeCode: 'LOAD', equipmentReference: 'HLBU1234564',
      eventLocation: { locationName: 'Le Havre' }, emptyIndicatorCode: 'LADEN',
    },
    {
      eventType: 'TRANSPORT', eventClassifierCode: 'EST', eventDateTime: '2026-05-20T12:00:00Z',
      transportEventTypeCode: 'ARRI',
      transportCall: { modeOfTransport: 'VESSEL', location: { locationName: 'Caucedo' } },
    },
  ];
  const s = summarizeTracking(events);

  assert.equal(s.count, 3);
  // Sorted ascending by time: LOAD (04-28) → DEPA (05-01) → ARRI (05-20).
  assert.deepEqual(s.milestones.map((m) => m.code), ['LOAD', 'DEPA', 'ARRI']);
  // Last known = most recent ACTUAL event (the ARRI is only estimated).
  assert.equal(s.last.code, 'DEPA');
  assert.equal(s.last.classifier, 'ACT');
  // ETA = the estimated arrival.
  assert.equal(s.eta.code, 'ARRI');
  assert.equal(s.eta.location, 'Caucedo');
});

test('summarizeTracking handles an empty / missing list', () => {
  for (const input of [[], null, undefined]) {
    const s = summarizeTracking(input);
    assert.equal(s.count, 0);
    assert.equal(s.last, null);
    assert.equal(s.eta, null);
  }
});
