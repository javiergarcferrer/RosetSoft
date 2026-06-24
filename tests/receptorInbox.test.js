/**
 * Tests for the receptor inbox ViewModel (src/core/accounting/receptorInbox.js):
 * the two DGII receptor streams projected for the Comprobantes-recibidos page —
 * inbound e-CFs and the commercial approvals customers returned on ours.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReceptorInbox } from '../src/core/accounting/receptorInbox.js';

test('received e-CFs: labelled, flagged, newest first', () => {
  const r = resolveReceptorInbox({
    received: [
      { id: 'a', eNcf: 'E310000000001', tipoEcf: '31', rncEmisor: '101', montoTotal: 1180, estado: '0', receivedAt: 1000 },
      { id: 'b', eNcf: 'E320000000009', tipoEcf: '32', rncEmisor: '202', montoTotal: 590, estado: '1', codigoNoRecibido: '3', receivedAt: 3000 },
    ],
  });
  assert.equal(r.counts.received, 2);
  assert.equal(r.received[0].id, 'b');              // newest first
  assert.equal(r.received[0].estadoLabel, 'No recibido');
  assert.equal(r.received[0].notReceived, true);
  assert.equal(r.received[0].codigoNoRecibido, '3');
  assert.equal(r.received[1].tipoLabel, 'Factura de Crédito Fiscal');
  assert.equal(r.received[1].estadoLabel, 'Recibido');
  assert.equal(r.received[1].notReceived, false);
});

test('commercial approvals: aprobado/rechazado labelled + rejected count', () => {
  const r = resolveReceptorInbox({
    approvals: [
      { id: 'x', eNcf: 'E310000000001', rncComprador: '101', estado: '1', receivedAt: 1000 },
      { id: 'y', eNcf: 'E310000000002', rncComprador: '102', estado: '2', motivoRechazo: 'Precio incorrecto', receivedAt: 2000 },
    ],
  });
  assert.equal(r.counts.approvals, 2);
  assert.equal(r.counts.rejected, 1);
  assert.equal(r.approvals[0].id, 'y');             // newest first
  assert.equal(r.approvals[0].estadoLabel, 'Rechazado');
  assert.equal(r.approvals[0].rejected, true);
  assert.equal(r.approvals[0].motivoRechazo, 'Precio incorrecto');
  assert.equal(r.approvals[1].estadoLabel, 'Aprobado');
});

test('query filters both streams (e-NCF / RNC)', () => {
  const data = {
    received: [
      { id: 'a', eNcf: 'E310000000001', tipoEcf: '31', rncEmisor: '101', receivedAt: 1 },
      { id: 'b', eNcf: 'E320000000009', tipoEcf: '32', rncEmisor: '202', receivedAt: 2 },
    ],
    approvals: [{ id: 'x', eNcf: 'E310000000001', rncComprador: '999', estado: '1', receivedAt: 1 }],
  };
  const r = resolveReceptorInbox({ ...data, query: '202' });
  assert.equal(r.received.length, 1);
  assert.equal(r.received[0].id, 'b');
  assert.equal(r.approvals.length, 0); // approval RNC 999 doesn't match
});

test('empty inbox → empty arrays + zero counts', () => {
  const r = resolveReceptorInbox({});
  assert.deepEqual(r.received, []);
  assert.deepEqual(r.approvals, []);
  assert.deepEqual(r.counts, { received: 0, approvals: 0, rejected: 0 });
});
