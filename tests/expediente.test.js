/**
 * Tests for src/lib/accounting/expediente.ts — the import-expediente engine:
 * itemized costs capitalize (net) into a per-line landed cost while their ITBIS
 * is recoverable credit, and the whole thing posts ONE balanced asiento.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isBalanced, debitTotal, creditTotal } from '../src/lib/accounting/ledger.js';
import { resolveAccountingConfig, accountFor } from '../src/lib/accounting/config.js';
import {
  expedienteCostTotals, expedienteLanded, expedienteCreditableItbis,
  expedienteTaxCheck, allocateExpediente, buildExpedienteEntry,
  prorateCif, computeLineTaxes,
} from '../src/lib/accounting/expediente.js';

const config = resolveAccountingConfig(null); // defaults: duty 20%, ITBIS 18%

// One shipment: CIF 10000 over two products, gravamen 2000, import ITBIS 2160,
// plus three service costs (FDA agenciamiento w/ ITBIS, puerto, transporte).
function expediente() {
  return {
    id: 'exp1', profileId: 'team', bl: 'HLCULE1251124881',
    supplierId: 'roset', liquidatedAt: 0, paymentMethod: 'bank',
    cif: 10000, duty: 2000, importItbis: 2160,
    lines: [
      { id: 'a', itemId: 'iA', name: 'Sofá', qty: 2, cifValue: 6000 },
      { id: 'b', itemId: 'iB', name: 'Mesa', qty: 1, cifValue: 4000 },
    ],
    costs: [
      { id: 'c1', concept: 'agenciamiento', supplierId: 'fda', ncf: 'B0100000001', amount: 1180, itbis: 180, paymentMethod: 'credit' },
      { id: 'c2', concept: 'puerto', amount: 500, itbis: 0, paymentMethod: 'bank' },
      { id: 'c3', concept: 'transporte', amount: 590, itbis: 90, paymentMethod: 'cash' },
    ],
  };
}

test('cost totals: net = gross − itbis, computed per cent', () => {
  const t = expedienteCostTotals(expediente().costs);
  assert.equal(t.gross, 2270);  // 1180 + 500 + 590
  assert.equal(t.itbis, 270);   // 180 + 0 + 90
  assert.equal(t.net, 2000);    // 1000 + 500 + 500
});

test('landed total capitalizes CIF + gravamen + cost NETs (not the ITBIS)', () => {
  assert.equal(expedienteLanded(expediente()), 14000); // 10000 + 2000 + 2000
});

test('creditable ITBIS = import ITBIS + every service ITBIS', () => {
  assert.equal(expedienteCreditableItbis(expediente()), 2430); // 2160 + 270
});

test('allocate: capitalizable extras prorate by CIF value, sum to landed', () => {
  const a = allocateExpediente(expediente());
  // extras = duty 2000 + cost nets 2000 = 4000, spread over CIF 10000.
  const byId = Object.fromEntries(a.pieces.map((p) => [p.line.id, p]));
  assert.equal(byId.a.landedTotal, 8400);   // 6000 + 4000*0.6
  assert.equal(byId.a.landedUnitCost, 4200); // /2
  assert.equal(byId.b.landedTotal, 5600);   // 4000 + 1600 (drift→last)
  assert.equal(byId.b.landedUnitCost, 5600); // /1
  const sum = a.pieces.reduce((s, p) => s + p.landedTotal, 0);
  assert.equal(sum, 14000); // == expedienteLanded
});

test('asiento balances and books the right debits', () => {
  let i = 0;
  const { lines } = buildExpedienteEntry({ newId: () => `id${i++}`, config, expediente: expediente(), postedAt: 0 });
  assert.ok(isBalanced(lines));
  assert.equal(debitTotal(lines), creditTotal(lines));
  assert.equal(debitTotal(lines), 16430); // 14000 inventory + 2430 ITBIS
  const inv = lines.find((l) => l.accountCode === accountFor(config, 'inventory'));
  assert.equal(inv.debit, 14000);
  const itbis = lines.find((l) => l.accountCode === accountFor(config, 'itbisCredit'));
  assert.equal(itbis.debit, 2430);
  // CIF clears from goods-in-transit; carries the foreign supplier.
  const git = lines.find((l) => l.accountCode === accountFor(config, 'goodsInTransit'));
  assert.equal(git.credit, 10000);
  assert.equal(git.thirdPartyId, 'roset');
  // The FDA agenciamiento → CxP, full amount, with its NCF (for the 606).
  const fda = lines.find((l) => l.ncf === 'B0100000001');
  assert.equal(fda.credit, 1180);
  assert.equal(fda.thirdPartyId, 'fda');
  assert.equal(fda.accountCode, accountFor(config, 'accountsPayable'));
});

test('tax check flags a gravamen/ITBIS mismatch vs the configured rates', () => {
  const ok = expedienteTaxCheck({ cif: 10000, duty: 2000, importItbis: 2160, config });
  assert.equal(ok.matches, true);
  assert.equal(ok.dutyDiff, 0);
  // A 14% arancel (not the 20% default) shows as a duty mismatch.
  const off = expedienteTaxCheck({ cif: 10000, duty: 1400, importItbis: 2160, config });
  assert.equal(off.matches, false);
  assert.equal(off.dutyDiff, -600);
});

test('prorateCif: FOB + flete/seguro by FOB weight, sums to total CIF', () => {
  const out = prorateCif([{ fob: 600 }, { fob: 400 }], 50, 50); // extras 100
  assert.equal(out[0].cif, 660); // 600 + 100*0.6
  assert.equal(out[1].cif, 440); // 400 + 40 (drift→last)
  assert.equal(out[0].cif + out[1].cif, 1100); // == FOB 1000 + 100
});

test('computeLineTaxes: 20% gravamen + selectivo, ITBIS on the cascade', () => {
  const t = computeLineTaxes({ cif: 1000, selectivo: 100, config });
  assert.equal(t.gravamen, 200);   // 20% of CIF
  assert.equal(t.selectivo, 100);
  assert.equal(t.itbis, 234);      // 18% of (1000 + 200 + 100)
  // No selectivo → ITBIS on (CIF + gravamen) only.
  assert.equal(computeLineTaxes({ cif: 1000, config }).itbis, 216); // 18% of 1200
});

test('cascade reconciles to Alcover\'s real DUA (CIF 15,557,907.59 → 6,659,865.41)', () => {
  const cif = 15557907.59;
  const selectivo = 159131.23; // the embarque's ISC (a few HS lines)
  const t = computeLineTaxes({ cif, selectivo, config });
  const impuestos = t.gravamen + t.selectivo + t.itbis;
  // Within a few pesos of the DUA's "Total Impuestos a Pagar" — the small drift
  // is aggregate-vs-per-item rounding (the DUA sums 52 per-line roundings).
  assert.ok(Math.abs(impuestos - 6659865.41) < 5, `got ${impuestos}`);
});

test('empty cost sheet: landed = CIF + duty, asiento still balances', () => {
  const e = { ...expediente(), costs: [] };
  assert.equal(expedienteLanded(e), 12000);
  let i = 0;
  const { lines } = buildExpedienteEntry({ newId: () => `x${i++}`, config, expediente: e, postedAt: 0 });
  assert.ok(isBalanced(lines));
});
