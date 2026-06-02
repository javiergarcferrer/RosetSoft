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
} from '../src/lib/modules.js';
import { compoundSubtotal } from '../src/lib/pricing.js';

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
