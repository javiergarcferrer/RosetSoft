/**
 * Tests for src/lib/modules.js — the catalog-agnostic module grouping that turns
 * a compound line's flat component list into a modular product. No catalog, no
 * model-specific data: grouping is purely structural over the components array,
 * and the per-module subtotals always sum back to the compound subtotal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isModularLine,
  modulesOf,
  moduleSubtotal,
  groupComponents,
  ungroupModule,
  renameModule,
  setModuleOptional,
  addModuleAlternative,
  selectModuleAlternative,
} from '../src/lib/modules.js';
import { compoundSubtotal } from '../src/lib/pricing.js';
import { isPricedComponent } from '../src/lib/constants.js';

const ids = () => {
  let n = 0;
  return () => `m${++n}`;
};

/* Three elements of one component product (corner: frame + back + scatter) plus
 * a standalone ottoman — the shape of a hand-assembled modular. */
const COMPS = [
  { id: 'a', name: 'CORNER FRAME', unitPrice: 6430, qty: 1 },
  { id: 'b', name: 'BACK CUSHION', unitPrice: 1235, qty: 1 },
  { id: 'c', name: 'SCATTER CUSHION', unitPrice: 630, qty: 2 },
  { id: 'd', name: 'OTTOMAN', unitPrice: 2100, qty: 1 },
];

/* ---------------------- module optional / alternative ---------------------- */

// A module = components sharing a moduleGroup. Optional/alternative live at the
// MODULE level (per the structure spec); components never carry an alternative.
const MOD = [
  { id: 'a', moduleGroup: 'L', moduleName: 'Loveseat', unitPrice: 6430, qty: 1 },
  { id: 'b', moduleGroup: 'L', unitPrice: 1235, qty: 1 },
  { id: 'd', name: 'OTTOMAN', unitPrice: 2100, qty: 1 },
];

test('setModuleOptional stamps the whole module + drops it from the total', () => {
  const opt = setModuleOptional(MOD, 'L', true);
  assert.ok(opt.filter((c) => c.moduleGroup === 'L').every((c) => c.moduleOptional === true));
  assert.equal(opt.find((c) => c.id === 'd').moduleOptional, undefined); // ottoman untouched
  // an optional module is excluded from the compound total (only the ottoman left)
  assert.equal(compoundSubtotal({ components: opt }), 2100);
  // clearing folds it back in: 6430 + 1235 + 2100
  assert.equal(compoundSubtotal({ components: setModuleOptional(opt, 'L', false) }), 9765);
});

test('isPricedComponent excludes an optional or non-selected-alternative module', () => {
  assert.equal(isPricedComponent({ moduleOptional: true }), false);
  assert.equal(isPricedComponent({ moduleAlternativeGroup: 'g', moduleSelected: false }), false);
  assert.equal(isPricedComponent({ moduleAlternativeGroup: 'g', moduleSelected: true }), true);
  assert.equal(isPricedComponent({ moduleGroup: 'L' }), true); // a plain module element counts
});

test('addModuleAlternative duplicates the module as a non-selected sibling', () => {
  const next = addModuleAlternative(MOD, 'L', ids());
  const src = next.filter((c) => c.moduleGroup === 'L');
  assert.ok(src.every((c) => c.moduleSelected === true && c.moduleAlternativeGroup));
  const altGroup = src[0].moduleAlternativeGroup;
  const dup = next.filter((c) => c.moduleAlternativeGroup === altGroup && c.moduleGroup !== 'L');
  assert.equal(dup.length, 2);
  assert.ok(dup.every((c) => c.moduleSelected === false));
  assert.notEqual(dup[0].moduleGroup, 'L');
  // only the selected module prices into the total (ottoman + selected loveseat)
  assert.equal(compoundSubtotal({ components: next }), 6430 + 1235 + 2100);
});

test('selectModuleAlternative flips the priced module', () => {
  const next = addModuleAlternative(MOD, 'L', ids());
  const dupGroup = next.find((c) => c.moduleAlternativeGroup && c.moduleGroup !== 'L').moduleGroup;
  const picked = selectModuleAlternative(next, dupGroup);
  assert.ok(picked.filter((c) => c.moduleGroup === dupGroup).every((c) => c.moduleSelected === true));
  assert.ok(picked.filter((c) => c.moduleGroup === 'L').every((c) => c.moduleSelected === false));
});

/* ------------------------------ isModularLine ------------------------------ */

test('isModularLine: explicit kind OR any grouped component', () => {
  assert.equal(isModularLine({ compoundKind: 'modular', components: COMPS }), true);
  assert.equal(isModularLine({ components: COMPS }), false); // plain component product
  assert.equal(isModularLine({ components: [{ id: 'a', moduleGroup: 'g1' }] }), true);
  assert.equal(isModularLine(null), false);
});

/* -------------------------------- modulesOf -------------------------------- */

test('modulesOf: ungrouped components are each their own single-element module', () => {
  const mods = modulesOf(COMPS);
  assert.equal(mods.length, 4);
  assert.deepEqual(mods.map((m) => m.moduleGroup), [null, null, null, null]);
  assert.deepEqual(mods.map((m) => m.name), ['CORNER FRAME', 'BACK CUSHION', 'SCATTER CUSHION', 'OTTOMAN']);
});

test('modulesOf: grouped components collapse into one module, name from moduleName', () => {
  const grouped = groupComponents(COMPS, ['a', 'b', 'c'], 'EXCLUSIF Corner Seat', ids());
  const mods = modulesOf(grouped);
  assert.equal(mods.length, 2); // the corner module + the standalone ottoman
  assert.equal(mods[0].moduleGroup, 'm1');
  assert.equal(mods[0].name, 'EXCLUSIF Corner Seat');
  assert.deepEqual(mods[0].components.map((c) => c.id), ['a', 'b', 'c']);
  assert.equal(mods[1].name, 'OTTOMAN');
});

test('modulesOf: module order follows first appearance, tolerating a reorder', () => {
  // Group a+c (not contiguous); b sits between them. The module appears at a's slot.
  const grouped = groupComponents(COMPS, ['a', 'c'], 'Split module', ids());
  const mods = modulesOf(grouped);
  assert.deepEqual(mods.map((m) => m.name), ['Split module', 'BACK CUSHION', 'OTTOMAN']);
  assert.deepEqual(mods[0].components.map((c) => c.id), ['a', 'c']);
});

/* ------------------------ subtotal parity (the core) ------------------------ */

test('Σ moduleSubtotal === compoundSubtotal — grouping never changes the price', () => {
  const grouped = groupComponents(COMPS, ['a', 'b', 'c'], 'Corner', ids());
  const line = { components: grouped };
  const total = modulesOf(grouped).reduce((s, m) => s + moduleSubtotal(m.components), 0);
  assert.equal(total, compoundSubtotal(line));
  // scatter qty 2 → 6430 + 1235 + 2*630 + 2100 = 11025
  assert.equal(total, 11025);
});

test('moduleSubtotal drops an excluded optional and a non-selected alternative', () => {
  const comps = [
    { id: 'a', unitPrice: 100, qty: 1 },
    { id: 'b', unitPrice: 50, qty: 1, isOptional: true },
    { id: 'c', unitPrice: 70, qty: 1, alternativeGroup: 'g', isSelectedAlternative: true },
    { id: 'd', unitPrice: 999, qty: 1, alternativeGroup: 'g', isSelectedAlternative: false },
  ];
  assert.equal(moduleSubtotal(comps), 170);
});

/* ----------------------------- group / ungroup ----------------------------- */

test('groupComponents stamps a shared moduleGroup + name, leaving others untouched', () => {
  const out = groupComponents(COMPS, ['a', 'b', 'c'], 'Corner', ids());
  const stamped = out.filter((c) => c.moduleGroup === 'm1');
  assert.equal(stamped.length, 3);
  stamped.forEach((c) => assert.equal(c.moduleName, 'Corner'));
  assert.equal(out.find((c) => c.id === 'd').moduleGroup, undefined);
});

test('groupComponents name defaults to the first member when blank; null on no targets', () => {
  const out = groupComponents(COMPS, ['b', 'c'], '', ids());
  assert.equal(out.find((c) => c.id === 'b').moduleName, 'BACK CUSHION');
  assert.equal(groupComponents(COMPS, [], 'x', ids()), null);
  assert.equal(groupComponents(COMPS, ['nope'], 'x', ids()), null);
});

test('ungroupModule clears the group on its members only', () => {
  const grouped = groupComponents(COMPS, ['a', 'b'], 'Corner', ids());
  const out = ungroupModule(grouped, 'm1');
  out.forEach((c) => assert.ok(!c.moduleGroup));
  // round-trips back to all-ungrouped modules
  assert.equal(modulesOf(out).length, 4);
});

test('renameModule sets moduleName across the whole group', () => {
  const grouped = groupComponents(COMPS, ['a', 'b'], 'Old', ids());
  const out = renameModule(grouped, 'm1', 'New name');
  out.filter((c) => c.moduleGroup === 'm1').forEach((c) => assert.equal(c.moduleName, 'New name'));
});

/* ----------------------- line ⇄ component moves ----------------------- */

import { absorbLineAsComponents, extractComponentsAsLine, healComponentAlternatives } from '../src/lib/modules.js';
import { lineTotal } from '../src/lib/pricing.js';

test('absorb: simple line into a modular → one module, total preserved, optional maps to moduleOptional', () => {
  const line = {
    kind: 'item', name: 'TOGO OTTOMAN', reference: '10002953E', subtype: 'E · ALCANTARA',
    qty: 2, unitPrice: 1000, lineMarginPct: 10, lineDiscountPct: 5, isOptional: true,
    description: '', productDescription: 'STANDARD SEAT',
  };
  const comps = absorbLineAsComponents(line, true, ids());
  assert.equal(comps.length, 1);
  const c = comps[0];
  assert.ok(c.moduleGroup);
  assert.equal(c.moduleName, 'TOGO OTTOMAN');
  assert.equal(c.moduleOptional, true);
  // margin/discount folded: 1000 × 1.10 × 0.95 = 1045 per unit
  assert.equal(c.unitPrice, 1045);
  // the catalog descriptor rides in the component's read-only productDescription,
  // separate from the editable description (never polluted) — just like the line
  assert.equal(c.productDescription, 'STANDARD SEAT');
  assert.equal(c.description, '');
  // the priced contribution is identical before and after the move
  assert.equal(c.unitPrice * c.qty, lineTotal({ ...line, isOptional: false }));
});

test('absorb: simple line into a plain compound keeps component-level optional', () => {
  const line = { kind: 'item', name: 'X', qty: 1, unitPrice: 100, isOptional: true, optionalOffered: true };
  const comps = absorbLineAsComponents(line, false, ids());
  assert.equal(comps[0].isOptional, true);
  assert.equal(comps[0].optionalOffered, true);
  assert.ok(!comps[0].moduleGroup);
});

test('absorb gates: section refused; compound into plain compound refused', () => {
  assert.equal(absorbLineAsComponents({ kind: 'section' }, true, ids()), null);
  const compound = { kind: 'item', name: 'C', components: [{ id: 'x', qty: 1, unitPrice: 10 }] };
  assert.equal(absorbLineAsComponents(compound, false, ids()), null);
  assert.ok(absorbLineAsComponents(compound, true, ids()));
});

test('absorb: compound into modular — modules carry over, loose pieces wrap as one module, ids re-minted', () => {
  const line = {
    kind: 'item', name: 'SECTIONAL', lineDiscountPct: 0,
    components: [
      { id: 'a', name: 'LEFT', qty: 1, unitPrice: 500, moduleGroup: 'g1', moduleName: 'Left arm' },
      { id: 'b', name: 'BACK', qty: 1, unitPrice: 100, moduleGroup: 'g1', moduleName: 'Left arm' },
      { id: 'c', name: 'OTTO', qty: 1, unitPrice: 200 },
    ],
  };
  const comps = absorbLineAsComponents(line, true, ids());
  const mods = modulesOf(comps);
  assert.equal(mods.length, 2);
  assert.equal(mods[0].name, 'Left arm');
  assert.equal(mods[1].name, 'SECTIONAL');           // loose ottoman wrapped under the line's name
  assert.notEqual(comps[0].moduleGroup, 'g1');       // fresh group id
  assert.notEqual(comps[0].id, 'a');                 // fresh component id
  assert.equal(compoundSubtotal({ components: comps }), 800);
});

test('extract: single component → simple line seed; module/component optional maps back to line optional', () => {
  const line = {
    family: 'TOGO', name: 'COMPO',
    components: [
      { id: 'a', name: 'SEAT', reference: 'R1', qty: 2, unitPrice: 300, moduleGroup: 'g', moduleName: 'Seat', moduleOptional: true },
      { id: 'b', name: 'BACK', qty: 1, unitPrice: 100, moduleGroup: 'g', moduleName: 'Seat', moduleOptional: true },
    ],
  };
  const res = extractComponentsAsLine(line, ['a'], ids());
  assert.equal(res.seed.name, 'SEAT');
  assert.equal(res.seed.family, 'TOGO');
  assert.equal(res.seed.isOptional, true);
  assert.equal(res.seed.unitPrice, 300);
  assert.equal(res.remaining.length, 1);
});

test('extract: whole module → compound line seed stripped of module chrome', () => {
  const line = {
    family: 'KASHIMA', name: 'MODULAR',
    components: [
      { id: 'a', name: 'LOVESEAT', qty: 1, unitPrice: 900, moduleGroup: 'g', moduleName: 'Right module' },
      { id: 'b', name: 'CUSHION', qty: 2, unitPrice: 50, moduleGroup: 'g', moduleName: 'Right module' },
      { id: 'c', name: 'CHAISE', qty: 1, unitPrice: 700 },
    ],
  };
  const res = extractComponentsAsLine(line, ['a', 'b'], ids());
  assert.equal(res.seed.name, 'Right module');
  assert.equal(res.seed.components.length, 2);
  assert.ok(res.seed.components.every((c) => !c.moduleGroup && !c.moduleName));
  assert.equal(compoundSubtotal({ components: res.seed.components }), 1000);
  assert.equal(res.remaining.length, 1);
});

test('extract gate: a module inside a pick-one refuses extraction', () => {
  const line = {
    components: [
      { id: 'a', qty: 1, unitPrice: 10, moduleGroup: 'g', moduleAlternativeGroup: 'alt', moduleSelected: true },
    ],
  };
  assert.equal(extractComponentsAsLine(line, ['a'], ids()), null);
});

test('healComponentAlternatives: lone survivor dissolves; lost selection promotes', () => {
  const healed = healComponentAlternatives([
    { id: 'a', alternativeGroup: 'g', isSelectedAlternative: false },
    { id: 'b', alternativeGroup: 'h', isSelectedAlternative: false },
    { id: 'c', alternativeGroup: 'h', isSelectedAlternative: false },
  ]);
  assert.equal(healed[0].alternativeGroup, undefined);     // lone 'g' member dissolved
  assert.equal(healed[1].isSelectedAlternative, true);     // 'h' promoted its first member
  assert.equal(healed[2].isSelectedAlternative, false);
});
