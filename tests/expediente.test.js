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
  expedienteTaxCheck, buildExpedienteEntry,
  prorateCif, computeLineTaxes, resolveExpediente,
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

// The same shipment in the multi-embarque shape the asiento builder consumes:
// one embarque (no flete/seguro), one Roset factura, two lines → identical totals
// (CIF 10000, gravamen 2000, import ITBIS 2160) so the asiento asserts hold.
function emb() {
  return {
    id: 'exp1', profileId: 'team', bl: 'HLCULE1251124881', liquidatedAt: 0, paymentMethod: 'bank',
    cif: 0, duty: 0, importItbis: 0, lines: [],
    embarques: [
      { id: 'e1', bl: 'HLCULE1251124881', flete: 0, seguro: 0, facturas: [
        { id: 'f1', supplierId: 'roset', lines: [
          { id: 'a', itemId: 'iA', name: 'Sofá', qty: 2, fob: 6000 },
          { id: 'b', itemId: 'iB', name: 'Mesa', qty: 1, fob: 4000 },
        ] },
      ] },
    ],
    costs: expediente().costs,
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

test('asiento balances and books the right debits', () => {
  let i = 0;
  const { lines } = buildExpedienteEntry({ newId: () => `id${i++}`, config, expediente: emb(), postedAt: 0 });
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

test('resolveExpediente: multi-embarque → per-line landed + rolled-up totals', () => {
  const exp = {
    id: 'e', profileId: 'team', liquidatedAt: 0, paymentMethod: 'bank',
    cif: 0, duty: 0, importItbis: 0, lines: [],
    costs: [{ id: 'k', concept: 'agenciamiento', amount: 354, itbis: 54 }], // net 300
    embarques: [
      { id: 'em1', bl: 'BL1', flete: 100, seguro: 0, facturas: [
        { id: 'fA', supplierId: 'S1', lines: [
          { id: 'a1', itemId: 'iA', name: 'Sofá', qty: 2, fob: 600 },
          { id: 'a2', itemId: 'iB', name: 'Mesa', qty: 1, fob: 400 },
        ] },
      ] },
      { id: 'em2', bl: 'BL2', flete: 0, seguro: 0, facturas: [
        { id: 'fB', supplierId: 'S2', lines: [
          { id: 'b1', itemId: 'iC', name: 'Espejo', qty: 1, fob: 500, selectivo: 50 },
        ] },
      ] },
    ],
  };
  const r = resolveExpediente(exp, config);
  assert.equal(r.lines.length, 3);
  // CIF: flete 100 prorated over FOB 1000 → a1 660, a2 440; em2 has no flete → b1 500.
  assert.equal(r.totals.cif, 1600);
  assert.equal(r.totals.gravamen, 320);        // 20% of 1600
  assert.equal(r.totals.selectivo, 50);         // only the espejo
  assert.equal(r.totals.importItbis, 354.6);    // 18% cascade per line, summed
  assert.equal(r.totals.landed, 2270);          // 1600 + 320 + 50 + costNet 300
  assert.equal(r.totals.creditableItbis, 408.6); // import 354.6 + service 54
  // Per-line landed reconciles to the total.
  assert.equal(r.lines.reduce((s, l) => s + l.landedTotal, 0), 2270);
  // The espejo line carries its selectivo into landed.
  const espejo = r.lines.find((l) => l.id === 'b1');
  assert.equal(espejo.gravamen, 100);
  assert.equal(espejo.selectivo, 50);
  assert.equal(espejo.itbis, 117);              // 18% of (500+100+50)
});

test('empty cost sheet: landed = CIF + duty, asiento still balances', () => {
  assert.equal(expedienteLanded({ cif: 10000, duty: 2000, costs: [] }), 12000);
  let i = 0;
  const { lines } = buildExpedienteEntry({ newId: () => `x${i++}`, config, expediente: { ...emb(), costs: [] }, postedAt: 0 });
  assert.ok(isBalanced(lines));
});

test('hostile inputs clamp: negative FOB/qty/costs never unbalance the asiento', () => {
  const hostile = {
    ...emb(),
    embarques: [
      { id: 'e1', bl: 'BL1', flete: -100, seguro: 0, facturas: [
        { id: 'f1', supplierId: 'roset', lines: [
          { id: 'a', itemId: 'iA', name: 'Sofá', qty: 2, fob: 6000 },
          { id: 'b', itemId: 'iB', name: 'Mesa', qty: -1, fob: -4000 }, // DevTools-tampered
        ] },
      ] },
    ],
    costs: [
      { id: 'c1', concept: 'puerto', amount: -500, itbis: 0, paymentMethod: 'bank' },
      { id: 'c2', concept: 'transporte', amount: 590, itbis: 900, paymentMethod: 'cash' }, // itbis > amount
    ],
  };
  const r = resolveExpediente(hostile, config);
  for (const l of r.lines) {
    assert.ok(l.cif >= 0 && l.landedTotal >= 0 && l.landedUnitCost >= 0);
  }
  const t = expedienteCostTotals(hostile.costs);
  assert.equal(t.gross, 590);          // negative cost dropped
  assert.equal(t.itbis, 590);          // itbis capped at the amount
  assert.equal(t.net, 0);              // never negative
  let i = 0;
  const { lines } = buildExpedienteEntry({ newId: () => `x${i++}`, config, expediente: hostile, postedAt: 0 });
  assert.ok(isBalanced(lines));
});
