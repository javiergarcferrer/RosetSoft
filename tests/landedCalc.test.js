/**
 * Tests for the landed-cost CALCULATOR Model (src/lib/accounting/landedCalc.ts):
 * the DGA tax stack (gravamen → ITBIS on CIF+gravamen+ISC → 0.4% servicio), the
 * EPA 0% vs MFN 20% duty lever, per-bucket cost allocation (volume vs value),
 * the Incoterm-driven CIF composition, and the two-way margin back-calc.
 *
 * These are the money invariants behind "land my costs fast" — keep them green;
 * if the DGA rules change, fix the engine, never relax the assertions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeLanded, allocate, priceForMargin, marginForPrice, DGA_DEFAULTS,
} from '../src/lib/accounting/landedCalc.js';

const base = {
  itbisRate: DGA_DEFAULTS.itbisRate,        // 18
  serviceFeeRate: DGA_DEFAULTS.serviceFeeRate, // 0.4
  targetMargin: 0,
};

test('MFN furniture: CIF 10k → duty 20%, ITBIS 18% on CIF+duty, servicio 0.4%', () => {
  const r = computeLanded({
    ...base, incoterm: 'CIF', dutyRate: 20,
    lines: [{ id: 'a', qty: 1, unitCost: 10000 }],
    costs: [],
  });
  const t = r.totals;
  assert.equal(t.cif, 10000);            // CIF incoterm → goods already = CIF
  assert.equal(t.duty, 2000);            // 20% of CIF
  assert.equal(t.itbis, 2160);           // 18% of (10000 + 2000)
  assert.equal(t.serviceFee, 40);        // 0.4% of CIF
  assert.equal(t.landed, 12040);         // CIF + duty + servicio (ITBIS excluded — recoverable)
  assert.equal(t.taxesAtCustoms, 4200);  // duty + ITBIS + servicio
  assert.equal(t.capitalizedTaxes, 2040);
  assert.equal(r.effectiveCustomsRate, 42); // 4200 / 10000
});

test('EPA origin: duty 0% collapses the gravamen and its ITBIS', () => {
  const r = computeLanded({
    ...base, incoterm: 'CIF', dutyRate: 0,
    lines: [{ id: 'a', qty: 1, unitCost: 10000 }],
    costs: [],
  });
  const t = r.totals;
  assert.equal(t.duty, 0);
  assert.equal(t.itbis, 1800);           // 18% of CIF only
  assert.equal(t.serviceFee, 40);
  assert.equal(t.landed, 10040);
  assert.equal(t.taxesAtCustoms, 1840);
  assert.equal(r.effectiveCustomsRate, 18.4); // the ~18.4% headline
});

test('ISC stacks on CIF+gravamen (CT Art. 367), then into the ITBIS base', () => {
  const r = computeLanded({
    ...base, incoterm: 'CIF', dutyRate: 20,
    lines: [{ id: 'a', qty: 1, unitCost: 1000, iscRate: 10 }],
    costs: [],
  });
  const t = r.totals;
  assert.equal(t.duty, 200);             // 20% of 1000
  assert.equal(t.isc, 120);              // 10% of (1000 + 200 gravamen)
  assert.equal(t.itbis, 237.6);          // 18% of (1000 + 200 + 120)
});

test('FOB adds freight + insurance into the CIF; CIF incoterm does not', () => {
  const lines = [{ id: 'a', qty: 1, unitCost: 10000, cbm: 1 }];
  const costs = [
    { id: 'f', bucket: 'freight', amount: 2000, allocation: 'volume' },
    { id: 'i', bucket: 'insurance', amount: 100, allocation: 'value' },
  ];
  const fob = computeLanded({ ...base, incoterm: 'FOB', dutyRate: 0, lines, costs });
  assert.equal(fob.totals.cif, 12100);   // 10000 + 2000 + 100
  assert.equal(fob.totals.freight, 2000);

  const cif = computeLanded({ ...base, incoterm: 'CIF', dutyRate: 0, lines, costs });
  assert.equal(cif.totals.cif, 10000);   // freight/insurance already in the price → ignored
  assert.equal(cif.totals.freight, 0);
});

test('DDP zeroes the DR customs taxes entirely (seller pre-cleared)', () => {
  const r = computeLanded({
    ...base, incoterm: 'DDP', dutyRate: 20,
    lines: [{ id: 'a', qty: 1, unitCost: 10000 }],
    costs: [],
  });
  assert.equal(r.totals.duty, 0);
  assert.equal(r.totals.itbis, 0);
  assert.equal(r.totals.serviceFee, 0);
  assert.equal(r.totals.landed, 10000);
});

test('allocate: volume vs value split differently and both sum to the total', () => {
  const lines = [
    { id: 'a', qty: 1, unitCost: 8000, cbm: 1 },
    { id: 'b', qty: 1, unitCost: 2000, cbm: 9 },
  ];
  const byVol = allocate(lines, 1000, 'volume');
  assert.deepEqual(byVol, [100, 900]);   // 1:9 by m³
  const byVal = allocate(lines, 1000, 'value');
  assert.deepEqual(byVal, [800, 200]);   // 8:2 by value
  assert.equal(byVol[0] + byVol[1], 1000);
  assert.equal(byVal[0] + byVal[1], 1000);
});

test('allocate: rounding drift lands on the last line, never lost', () => {
  const lines = [
    { id: 'a', qty: 1, unitCost: 1 },
    { id: 'b', qty: 1, unitCost: 1 },
    { id: 'c', qty: 1, unitCost: 1 },
  ];
  const shares = allocate(lines, 100, 'value'); // 33.33 each → drift to last
  assert.equal(shares[0] + shares[1] + shares[2], 100);
});

test('allocate: never assigns a NEGATIVE share (round-up overshoot is clawed back from the largest)', () => {
  // 0.05 across cbm [1, 1, 0]: each half rounds to 0.03, overshooting the total,
  // so the zero-volume last line would get −0.01 of freight. It must get 0, the
  // excess comes off a positive share, and Σ still equals the total.
  const lines = [
    { id: 'a', qty: 1, unitCost: 1, cbm: 1 },
    { id: 'b', qty: 1, unitCost: 1, cbm: 1 },
    { id: 'c', qty: 1, unitCost: 1, cbm: 0 },
  ];
  const shares = allocate(lines, 0.05, 'volume');
  assert.ok(shares.every((s) => s >= 0), `negative share in ${JSON.stringify(shares)}`);
  assert.equal(Math.round(shares.reduce((a, b) => a + b, 0) * 100) / 100, 0.05);
});

test('allocate: zero metric falls back to an even split', () => {
  const lines = [{ id: 'a', qty: 1, unitCost: 5 }, { id: 'b', qty: 1, unitCost: 5 }];
  const shares = allocate(lines, 600, 'volume'); // no cbm → equal
  assert.deepEqual(shares, [300, 300]);
});

test('margin back-calc is two-way: price→margin→price round-trips', () => {
  assert.equal(priceForMargin(60, 40), 100);   // 60 / (1 − 0.40)
  assert.equal(marginForPrice(60, 100), 40);
  assert.equal(priceForMargin(100, 0), 100);    // 0% margin → cost
});

test('waterfall steps sum exactly to the landed total', () => {
  const r = computeLanded({
    ...base, incoterm: 'FOB', dutyRate: 20,
    lines: [{ id: 'a', qty: 2, unitCost: 5000, cbm: 3 }],
    costs: [
      { id: 'f', bucket: 'freight', amount: 1500, allocation: 'volume' },
      { id: 'b', bucket: 'broker', amount: 1180, allocation: 'value', itbis: 180 },
    ],
  });
  const sum = r.waterfall.reduce((s, step) => s + step.amount, 0);
  assert.equal(Math.round(sum * 100) / 100, r.totals.landed);
  // last cumulative === landed
  assert.equal(r.waterfall[r.waterfall.length - 1].cumulative, r.totals.landed);
  // broker's recoverable ITBIS stays out of landed, in the credit
  assert.equal(r.totals.localCostsItbis, 180);
  assert.equal(r.totals.creditableItbis, r.totals.itbis + 180);
});

test('per-unit landed cost divides the line total by quantity', () => {
  const r = computeLanded({
    ...base, incoterm: 'CIF', dutyRate: 0,
    lines: [{ id: 'a', qty: 4, unitCost: 1000 }],
    costs: [],
  });
  // CIF 4000, ITBIS recoverable, servicio 16 → landed 4016, /4 = 1004
  assert.equal(r.lines[0].landedTotal, 4016);
  assert.equal(r.lines[0].landedUnit, 1004);
});
