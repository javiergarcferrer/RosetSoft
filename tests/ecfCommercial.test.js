/**
 * Tests for the Aprobación/Rechazo Comercial Model (ACECF) —
 * src/lib/accounting/ecfCommercial.ts. Data-integrity: a malformed commercial
 * approval is a rejected document, so the builder must fail at build time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCommercialApproval, formatEcfDateTime, ACECF_ESTADO } from '../src/lib/accounting/ecfCommercial.js';

test('buildCommercialApproval (aprobado) builds DetalleAprobacionComercial without a motivo', () => {
  const p = buildCommercialApproval({
    rncEmisor: '131880681', eNcf: 'E310000000005', fechaEmision: Date.UTC(2026, 5, 1, 12),
    montoTotal: 11800, rncComprador: '101010101', fechaHoraAprobacion: '01-06-2026 10:00:00',
  }).ACECF.DetalleAprobacionComercial;
  assert.equal(p.Version, '1.0');
  assert.equal(p.RNCEmisor, '131880681');
  assert.equal(p.eNCF, 'E310000000005');
  assert.equal(p.FechaEmision, '01-06-2026');
  assert.equal(p.MontoTotal, 11800);
  assert.equal(p.RNCComprador, '101010101');
  assert.equal(p.Estado, 1);
  assert.equal(p.DetalleMotivoRechazo, undefined);
  assert.equal(p.FechaHoraAprobacionComercial, '01-06-2026 10:00:00');
});

test('buildCommercialApproval (rechazado) carries the motivo', () => {
  const p = buildCommercialApproval({
    rncEmisor: '131880681', eNcf: 'E310000000006', fechaEmision: Date.UTC(2026, 5, 1, 12),
    montoTotal: 5000, rncComprador: '101010101', estado: ACECF_ESTADO.RECHAZADO,
    motivoRechazo: 'Mercancía no recibida', fechaHoraAprobacion: '01-06-2026 10:00:00',
  }).ACECF.DetalleAprobacionComercial;
  assert.equal(p.Estado, 2);
  assert.equal(p.DetalleMotivoRechazo, 'Mercancía no recibida');
});

test('buildCommercialApproval THROWS on estado=2 without a motivo — fail at build, not at the DGII', () => {
  assert.throws(() => buildCommercialApproval({
    rncEmisor: '131880681', eNcf: 'E310000000007', fechaEmision: Date.UTC(2026, 5, 1, 12),
    montoTotal: 5000, rncComprador: '101010101', estado: 2,
  }), /motivo/);
});

test('buildCommercialApproval THROWS without both RNCs or the e-NCF', () => {
  assert.throws(() => buildCommercialApproval({
    rncEmisor: '', eNcf: 'E310000000001', fechaEmision: 0, montoTotal: 1, rncComprador: '101010101',
  }), /RNC/);
  assert.throws(() => buildCommercialApproval({
    rncEmisor: '131880681', eNcf: '', fechaEmision: 0, montoTotal: 1, rncComprador: '101010101',
  }), /e-NCF/);
});

test('buildCommercialApproval strips fiscal-id formatting', () => {
  const p = buildCommercialApproval({
    rncEmisor: '1-31-88068-1', eNcf: 'E320000000001', fechaEmision: Date.UTC(2026, 5, 1, 12),
    montoTotal: 100, rncComprador: '001-1234567-8', fechaHoraAprobacion: '01-06-2026 10:00:00',
  }).ACECF.DetalleAprobacionComercial;
  assert.equal(p.RNCEmisor, '131880681');
  assert.equal(p.RNCComprador, '00112345678');
});

test('formatEcfDateTime is dd-mm-yyyy HH:mm:ss', () => {
  assert.match(formatEcfDateTime(Date.now()), /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/);
  assert.equal(formatEcfDateTime(null), '');
});
