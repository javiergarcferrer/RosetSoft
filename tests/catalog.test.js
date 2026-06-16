/**
 * Tests for src/lib/catalog.js — family grouping of catalog products by SKU
 * root, with the trailing letter as the fabric grade.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { splitSkuGrade, groupFamilies, availableGrades, productForGrade, switchLineProduct, materiallessRangePatch, skuFillPatch, productStock, isOutOfStock, familyStock, repriceComponentsAtGrade, gradeForFabric, catalogSellingPrice } from '../src/lib/catalog.js';
import { composeSubtype } from '../src/lib/subtype.js';

/* ------------------------------ splitSkuGrade ------------------------------ */

test('splits an 8-digit root + grade letter', () => {
  assert.deepEqual(splitSkuGrade('15420000A'), { root: '15420000', grade: 'A' });
  assert.deepEqual(splitSkuGrade('15420000S'), { root: '15420000', grade: 'S' });
  assert.deepEqual(splitSkuGrade('15420000U'), { root: '15420000', grade: 'U' });
});

test('rejects T/Y/Z (not in the grade taxonomy) — treats as ungraded', () => {
  // The price list skips T/Y/Z; such a tail is not a grade.
  assert.deepEqual(splitSkuGrade('15420000T'), { root: '15420000T', grade: '' });
});

test('leaves non-graded codes whole (alphanumeric tables, etc.)', () => {
  assert.deepEqual(splitSkuGrade('00A0AM20'), { root: '00A0AM20', grade: '' });
  assert.deepEqual(splitSkuGrade('0050W49N'), { root: '0050W49N', grade: '' });
});

/* ------------------------------ groupFamilies ------------------------------ */

const TOGO = [
  { reference: '15420000A', name: 'TOGO FIRESIDE CHAIR', family: 'SEATS', priceUsd: 3420, cost: 1243.64 },
  { reference: '15420000G', name: 'TOGO FIRESIDE CHAIR', family: 'SEATS', priceUsd: 4450, cost: 1618.18 },
  { reference: '15420000M', name: 'TOGO FIRESIDE CHAIR', family: 'SEATS', priceUsd: 5140, cost: 1869.09 },
  { reference: '15420000U', name: 'TOGO FIRESIDE CHAIR', family: 'SEATS', priceUsd: 4145, cost: 1507.27 },
  { reference: '15420000S', name: 'TOGO FIRESIDE CHAIR', family: 'SEATS', priceUsd: 4760, cost: 1730.91 },
  // an unrelated wood chair (distinct root, ungraded)
  { reference: '10261152W', name: 'VIK CHAIR W/ARMS', family: 'DINING CHAIRS', priceUsd: 2165, cost: 807.84 },
];

test('groups grade variants under one family root', () => {
  const fams = groupFamilies(TOGO);
  const togo = fams.find((f) => f.root === '15420000');
  assert.ok(togo);
  assert.equal(togo.name, 'TOGO FIRESIDE CHAIR');
  assert.equal(togo.graded, true);
  assert.equal(togo.byGrade.size, 5);
});

test('orders available grades by ascending price', () => {
  const togo = groupFamilies(TOGO).find((f) => f.root === '15420000');
  // prices: A 3420 < U 4145 < G 4450 < S 4760 < M 5140
  assert.deepEqual(availableGrades(togo), ['A', 'U', 'G', 'S', 'M']);
});

test('resolves a model + grade to the right SKU price/cost', () => {
  const togo = groupFamilies(TOGO).find((f) => f.root === '15420000');
  assert.equal(productForGrade(togo, 'G').reference, '15420000G');
  assert.equal(productForGrade(togo, 'G').priceUsd, 4450);
  assert.equal(productForGrade(togo, 'M').priceUsd, 5140);
});

test('a lone SKU ending in a grade letter is a standalone (not graded) family', () => {
  // VIK's W tail is a wood finish, not a fabric grade — and no sibling shares
  // its 8-digit root, so the ≥2-variant rule keeps it standalone.
  const vik = groupFamilies(TOGO).find((f) => f.root === '10261152');
  assert.ok(vik);
  assert.equal(vik.graded, false);
  assert.deepEqual(availableGrades(vik), []);
  assert.equal(productForGrade(vik, '').reference, '10261152W');
});

/* ----------------------------- switchLineProduct ----------------------------- */

const togoFamily = () => groupFamilies(TOGO).find((f) => f.root === '15420000');

// A second graded model offered in only A + G — used to force materials whose
// grade the target model doesn't carry.
const PRADO = [
  { reference: '16000000A', name: 'PRADO SOFA', family: 'SEATS', priceUsd: 2000, cost: 800 },
  { reference: '16000000G', name: 'PRADO SOFA', family: 'SEATS', priceUsd: 3000, cost: 1200 },
];
const pradoFamily = () => groupFamilies(PRADO).find((f) => f.root === '16000000');

// A non-graded model (its tail isn't a grade) — no fabric grades at all.
const TABLE = [
  { reference: '0050W49N', name: 'LOW TABLE', family: 'TABLES', subtype: 'Walnut', dimensions: 'H 30 × W 120', priceUsd: 1500, cost: 600 },
];
const tableFamily = () => groupFamilies(TABLE).find((f) => f.root === '0050W49N');

test('keeps a compatible base material and re-snapshots the new model price', () => {
  const line = { subtype: composeSubtype('G', 'DIVA'), swatchImageId: 'img1', materialOptions: null };
  const patch = switchLineProduct(line, togoFamily());
  assert.equal(patch.reference, '15420000G');
  assert.equal(patch.unitPrice, 4450);
  assert.equal(patch.unitCost, 1618.18);
  assert.equal(patch.name, 'TOGO FIRESIDE CHAIR');
  assert.equal(patch.subtype, composeSubtype('G', 'DIVA')); // material untouched
  assert.equal(patch.swatchImageId, 'img1');                // swatch kept
  assert.equal(patch.materialOptions, null);
});

test('drops options the new model has no grade for, keeps the rest', () => {
  const line = {
    subtype: composeSubtype('A', 'ALPHA'),
    swatchImageId: null,
    materialOptions: {
      baseGrade: 'A',
      baseLabel: 'ALPHA',
      options: [
        { grade: 'G', label: 'GAMMA' },   // TOGO has G → kept
        { grade: 'B', label: 'BETA' },    // TOGO has no B → dropped
      ],
    },
  };
  const patch = switchLineProduct(line, togoFamily());
  assert.equal(patch.subtype, composeSubtype('A', 'ALPHA'));   // base survives
  assert.equal(patch.materialOptions.baseGrade, 'A');
  assert.deepEqual(patch.materialOptions.options.map((o) => o.grade), ['G']);
});

test('promotes the first surviving option when the base material is incompatible', () => {
  const line = {
    subtype: composeSubtype('B', 'BETA'),   // TOGO has no B → base dropped
    swatchImageId: 'base-swatch',
    materialOptions: {
      baseGrade: 'B',
      baseLabel: 'BETA',
      options: [
        { grade: 'M', label: 'MICRO', swatchImageId: 'm-swatch' }, // promoted
        { grade: 'G', label: 'GAMMA' },                            // stays an option
        { grade: 'B', label: 'OTHER-B' },                          // dropped
      ],
    },
  };
  const patch = switchLineProduct(line, togoFamily());
  assert.equal(patch.subtype, composeSubtype('M', 'MICRO'));
  assert.equal(patch.swatchImageId, 'm-swatch');
  assert.equal(patch.unitPrice, 5140);   // TOGO grade M
  assert.equal(patch.materialOptions.baseGrade, 'M');
  assert.deepEqual(patch.materialOptions.options.map((o) => o.grade), ['G']);
});

test('clears the material and prices at the cheapest grade when nothing survives', () => {
  const line = { subtype: composeSubtype('M', 'MICRO'), swatchImageId: 'x', materialOptions: null };
  // PRADO offers only A + G — grade M doesn't survive and there are no options.
  const patch = switchLineProduct(line, pradoFamily());
  assert.equal(patch.subtype, '');
  assert.equal(patch.swatchImageId, null);
  assert.equal(patch.materialOptions, null);
  assert.equal(patch.reference, '16000000A');   // cheapest grade (A: 2000 < G: 3000)
  assert.equal(patch.unitPrice, 2000);
});

test('switching to a non-graded model drops every material and takes its subtype', () => {
  const line = {
    subtype: composeSubtype('G', 'DIVA'),
    swatchImageId: 'img1',
    materialOptions: { baseGrade: 'G', baseLabel: 'DIVA', options: [{ grade: 'A', label: 'ALPHA' }] },
  };
  const patch = switchLineProduct(line, tableFamily());
  assert.equal(patch.reference, '0050W49N');
  assert.equal(patch.subtype, 'Walnut');         // model's own finish text
  assert.equal(patch.swatchImageId, null);
  assert.equal(patch.materialOptions, null);
  assert.equal(patch.unitPrice, 1500);
});

test('returns null for a missing family (no-op guard)', () => {
  assert.equal(switchLineProduct({ subtype: 'Grade A' }, null), null);
});

/* --------------------------- materiallessRangePatch --------------------------- */

test('reverts to the model cheapest→priciest range (subtype/swatch cleared)', () => {
  // TOGO grades by price: A 3420 (lo) … M 5140 (hi).
  const patch = materiallessRangePatch(togoFamily());
  assert.deepEqual(patch, {
    subtype: '',
    swatchImageId: null,
    unitPrice: 3420,
    unitCost: 1243.64,
    priceMin: 3420,
    priceMax: 5140,
  });
});

test('no range to revert to → null (ungraded model, missing family)', () => {
  const vik = groupFamilies(TOGO).find((f) => f.root === '10261152'); // single SKU
  assert.equal(materiallessRangePatch(vik), null);
  assert.equal(materiallessRangePatch(null), null);
});

/* ------------------------------- skuFillPatch ------------------------------- */

const skuFams = () => new Map(groupFamilies([...TOGO, ...TABLE]).map((f) => [f.root, f]));

test('skuFillPatch resolves a pasted graded SKU to its product fields', () => {
  const patch = skuFillPatch(skuFams(), '15420000G');
  assert.equal(patch.reference, '15420000G');
  assert.equal(patch.name, 'TOGO FIRESIDE CHAIR');
  assert.equal(patch.unitPrice, 4450);
  assert.equal(patch.unitCost, 1618.18);
  assert.equal(patch.subtype, composeSubtype('G', '')); // grade pinned, no fabric
  assert.equal(patch.priceMin, null);
  assert.equal(patch.materialOptions, null);
});

test('skuFillPatch resolves a non-graded SKU to its single product', () => {
  const patch = skuFillPatch(skuFams(), '0050W49N');
  assert.equal(patch.reference, '0050W49N');
  assert.equal(patch.name, 'LOW TABLE');
  assert.equal(patch.unitPrice, 1500);
  assert.equal(patch.subtype, 'Walnut'); // model's own finish (no grade letter)
});

test('skuFillPatch leaves an unknown SKU (or null catalog) as just the reference', () => {
  assert.deepEqual(skuFillPatch(skuFams(), '99999999Z'), { reference: '99999999Z' });
  assert.deepEqual(skuFillPatch(null, '15420000G'), { reference: '15420000G' });
});

/* --------------------- gradeForFabric / catalogSellingPrice --------------------- */
// An inventory item minted from an import invoice is PRICED from the catalog:
// the invoice supplies the model reference + the fabric it shipped in, and the
// catalog prices upholstery by grade — so reference + fabric → grade → list price.

// The materials roster maps a fabric name to its grade (price tier).
const ROSTER = [
  { name: 'ALPAGA', grade: 'A' },
  { name: 'DIVA', grade: 'G' },
  { name: 'NABUK', grade: 'M' },
  { name: 'ALCANTARA — A', grade: 'A' }, // label carries its own grade suffix
  { name: 'COM SUPPLIED', grade: null }, // ungraded roster entry → no tier
];
const priceFams = () => new Map(groupFamilies([...TOGO, ...TABLE]).map((f) => [f.root, f]));

test('gradeForFabric: maps a fabric name to its grade off the roster', () => {
  assert.equal(gradeForFabric(ROSTER, 'DIVA'), 'G');
  assert.equal(gradeForFabric(ROSTER, 'diva'), 'G');            // case-insensitive
  assert.equal(gradeForFabric(ROSTER, 'ALCANTARA'), 'A');       // strips the label's grade suffix
  assert.equal(gradeForFabric(ROSTER, 'PHLOX · ECRU (#12)'), ''); // not on the roster
  assert.equal(gradeForFabric(ROSTER, 'COM SUPPLIED'), '');     // roster entry carries no grade
  assert.equal(gradeForFabric(ROSTER, ''), '');
  assert.equal(gradeForFabric(null, 'DIVA'), '');
});

test('catalogSellingPrice: a full SKU (or non-graded model) prices directly', () => {
  assert.equal(catalogSellingPrice(priceFams(), ROSTER, '15420000G'), 4450); // SKU pins grade G
  assert.equal(catalogSellingPrice(priceFams(), ROSTER, '0050W49N'), 1500);  // non-graded table
  assert.equal(catalogSellingPrice(priceFams(), ROSTER, '0050W49N', 'whatever'), 1500); // fabric ignored
});

test('catalogSellingPrice: a graded model resolves its price via the fabric grade', () => {
  // TOGO grades by price: A 3420 < U 4145 < G 4450 < S 4760 < M 5140.
  assert.equal(catalogSellingPrice(priceFams(), ROSTER, '15420000', 'DIVA'), 4450);  // → G
  assert.equal(catalogSellingPrice(priceFams(), ROSTER, '15420000', 'NABUK'), 5140); // → M
  assert.equal(catalogSellingPrice(priceFams(), ROSTER, '15420000', 'alcantara'), 3420); // → A
});

test('catalogSellingPrice: null (leave unset) when nothing resolves', () => {
  assert.equal(catalogSellingPrice(priceFams(), ROSTER, '15420000'), null);            // graded, no fabric
  assert.equal(catalogSellingPrice(priceFams(), ROSTER, '15420000', 'UNKNOWN'), null); // fabric not on roster
  assert.equal(catalogSellingPrice(priceFams(), ROSTER, '99999999', 'DIVA'), null);    // unknown model
  assert.equal(catalogSellingPrice(null, ROSTER, '15420000G'), null);                  // no catalog
});

/* ------------------------------- stock gate ------------------------------- */
// LSG rows carry stockQty (Shopify inventory, refreshed on sync); LR rows
// never do. The gate is data-integrity: a TRACKED product with no sellable
// units must not be quotable — pickers disable it and inserts hard-stop.

test('productStock: stockQty null/absent = untracked (LR, pre-stock LSG)', () => {
  assert.deepEqual(productStock({ stockQty: null }), { tracked: false, qty: 0 });
  assert.deepEqual(productStock({}), { tracked: false, qty: 0 });
  assert.deepEqual(productStock(null), { tracked: false, qty: 0 });
});

test('productStock: a tracked figure passes through, oversold stays negative', () => {
  assert.deepEqual(productStock({ stockQty: 7 }), { tracked: true, qty: 7 });
  assert.deepEqual(productStock({ stockQty: 0 }), { tracked: true, qty: 0 });
  assert.deepEqual(productStock({ stockQty: -2 }), { tracked: true, qty: -2 });
});

test('isOutOfStock: only a TRACKED product with qty <= 0 is blocked', () => {
  assert.equal(isOutOfStock({ stockQty: 0 }), true);
  assert.equal(isOutOfStock({ stockQty: -1 }), true);
  assert.equal(isOutOfStock({ stockQty: 3 }), false);
  // Untracked (LR special order / pre-stock import) is NEVER blocked.
  assert.equal(isOutOfStock({ stockQty: null }), false);
  assert.equal(isOutOfStock({}), false);
  assert.equal(isOutOfStock(null), false);
});

test('familyStock: an LSG single-member model carries its variant stock', () => {
  const [fam] = groupFamilies([{ reference: 'LSG-1', name: 'Nassau Sofa', stockQty: 3 }]);
  assert.deepEqual(familyStock(fam), { tracked: true, qty: 3 });
  const [out] = groupFamilies([{ reference: 'LSG-2', name: 'Nassau Chair', stockQty: 0 }]);
  assert.deepEqual(familyStock(out), { tracked: true, qty: 0 });
});

test('familyStock: graded LR models are untracked (special order, never gated)', () => {
  const togo = groupFamilies(TOGO).find((f) => f.root === '15420000');
  assert.deepEqual(familyStock(togo), { tracked: false, qty: 0 });
  assert.deepEqual(familyStock(null), { tracked: false, qty: 0 });
});

/* ----------------------- repriceComponentsAtGrade ----------------------- */

test('repriceComponentsAtGrade: every component re-snapshots to ITS model at the grade; ranges drop; fabric stamps', () => {
  const families = new Map(groupFamilies(TOGO).map((f) => [f.root, f]));
  const components = [
    // Togo piece on grade A, carrying a stale range → repriced to G, range dropped.
    { id: 'c1', reference: '15420000A', unitPrice: 3420, priceMin: 3000, priceMax: 5000, subtype: 'Grade A · Alpaga' },
    // A model that doesn't carry grade G → price/reference left intact, fabric still stamps.
    { id: 'c2', reference: '10261152W', unitPrice: 2165, subtype: '' },
  ];
  const next = repriceComponentsAtGrade(components, { grade: 'G', fabric: 'Steppe', swatchImageId: 'sw9' }, families);
  assert.equal(next[0].reference, '15420000G');
  assert.equal(next[0].unitPrice, 4450);
  assert.equal(next[0].priceMin, null);
  assert.equal(next[0].priceMax, null);
  assert.equal(next[0].swatchImageId, 'sw9');
  assert.equal(next[1].reference, '10261152W'); // intact
  assert.equal(next[1].unitPrice, 2165);
  assert.equal(next[0].subtype, next[1].subtype); // one stamp for all
  // Fabric-only pick (no grade): nothing reprices, subtype/swatch still stamp.
  const fabricOnly = repriceComponentsAtGrade(components, { fabric: 'Steppe' }, families);
  assert.equal(fabricOnly[0].reference, '15420000A');
  assert.equal(fabricOnly[0].priceMin, 3000); // range survives a fabric-only stamp
});
