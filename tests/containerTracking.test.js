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
  buildTrackingRoute,
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

/* ----------------------- coordinate extraction ---------------------- */

test('normalizeEvent carries UN/LOCODE and explicit coordinates', () => {
  // transportCall-level UN/LOCODE, no nested location object, no lat/lon.
  const a = normalizeEvent({
    eventType: 'TRANSPORT', eventClassifierCode: 'ACT',
    transportEventTypeCode: 'DEPA', transportCall: { UNLocationCode: 'FRLEH' },
  });
  assert.equal(a.unloc, 'FRLEH');
  assert.equal(a.lat, null);
  assert.equal(a.lon, null);

  // Nested location with name + UN/LOCODE + carrier-supplied lat/lon.
  const b = normalizeEvent({
    eventType: 'TRANSPORT', eventClassifierCode: 'EST',
    transportEventTypeCode: 'ARRI',
    transportCall: { location: { locationName: 'Caucedo', UNLocationCode: 'DOCAU', latitude: '18.42', longitude: '-69.63' } },
  });
  assert.equal(b.location, 'Caucedo');
  assert.equal(b.unloc, 'DOCAU');
  assert.equal(b.lat, 18.42);
  assert.equal(b.lon, -69.63);

  // Equipment event reads its UN/LOCODE off eventLocation.
  const c = normalizeEvent({
    eventType: 'EQUIPMENT', eventClassifierCode: 'ACT',
    equipmentEventTypeCode: 'LOAD', eventLocation: { locationName: 'Le Havre', UNLocationCode: 'FRLEH' },
  });
  assert.equal(c.unloc, 'FRLEH');
});

/* -------------------------- buildTrackingRoute ---------------------- */

test('buildTrackingRoute geocodes, merges consecutive ports, flags last/eta', () => {
  const events = [
    // Two ACTual events at the load port (FRLEH) → collapse into one stop.
    { eventType: 'EQUIPMENT', eventClassifierCode: 'ACT', eventDateTime: '2026-05-01T08:00:00Z',
      equipmentEventTypeCode: 'LOAD', eventLocation: { UNLocationCode: 'FRLEH', locationName: 'Le Havre' } },
    { eventType: 'TRANSPORT', eventClassifierCode: 'ACT', eventDateTime: '2026-05-01T18:00:00Z',
      transportEventTypeCode: 'DEPA', transportCall: { UNLocationCode: 'FRLEH', modeOfTransport: 'VESSEL' } },
    // Estimated arrival at Caucedo (the ETA).
    { eventType: 'TRANSPORT', eventClassifierCode: 'EST', eventDateTime: '2026-05-20T12:00:00Z',
      transportEventTypeCode: 'ARRI', transportCall: { location: { UNLocationCode: 'DOCAU', locationName: 'Caucedo' } } },
  ];
  const route = buildTrackingRoute(summarizeTracking(events));

  assert.equal(route.stops.length, 2);            // FRLEH (merged) + DOCAU
  assert.equal(route.stops[0].unloc, 'FRLEH');
  assert.equal(route.stops[0].events.length, 2);  // LOAD + DEPA in one stop
  assert.equal(route.stops[1].unloc, 'DOCAU');
  // Last ACTual position = DEPA at FRLEH (stop 0); ETA = ARRI at DOCAU (stop 1).
  assert.equal(route.lastIndex, 0);
  assert.equal(route.stops[0].isLast, true);
  assert.equal(route.etaIndex, 1);
  assert.equal(route.stops[1].isEta, true);
  // Coordinates resolved from the bundled UN/LOCODE table.
  assert.ok(Math.abs(route.stops[1].lat - 18.425) < 0.5);
});

test('buildTrackingRoute skips unmappable events and handles empties', () => {
  // Unknown UN/LOCODE → no stop (the event still lives in the timeline).
  const r1 = buildTrackingRoute(summarizeTracking([
    { eventType: 'TRANSPORT', eventClassifierCode: 'ACT', eventDateTime: '2026-05-01T00:00:00Z',
      transportEventTypeCode: 'DEPA', transportCall: { UNLocationCode: 'ZZZZZ' } },
  ]));
  assert.equal(r1.stops.length, 0);
  assert.equal(r1.lastIndex, -1);
  assert.equal(r1.etaIndex, -1);

  for (const input of [null, undefined, summarizeTracking([])]) {
    assert.equal(buildTrackingRoute(input).stops.length, 0);
  }
});
