/**
 * Tests for src/lib/rosetInvoice.js — parsing the Ligne Roset commercial
 * invoice into article lines + the furniture subset. The fixture is real text
 * geometry captured from invoice L450 page 2 (pdfjs item positions, y top-down):
 * the Togo armchair group (seats, HS 9401) and a vase group (HS 6913, dropped),
 * plus a Mini Togo (seat). Same reference 15420000 ships in three fabrics at
 * three costs → three distinct pieces.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRosetInvoice } from '../src/lib/rosetInvoice.js';

const it = (x, y, str) => ({ x, y, str, page: 2 });

const FIXTURE = [
  // ---- group 149547 — HS 94018000 (seats) ----
  it(19.4, 66.2, '149547'), it(112.9, 66.2, 'Cmq'), it(138.7, 66.2, 'EXPO'), it(162.7, 66.2, 'FLOOR'),
  it(191.5, 66.2, '1'), it(201.1, 66.2, 'WINDOW'), it(234.7, 66.2, 'TOGOS'), it(414.8, 66.2, '94018000'), it(519.4, 66.2, '4.197,91'),
  // Togo armchair in PHLOX
  it(83.6, 86.9, '1'), it(94.4, 86.9, '15420000'), it(138.7, 86.9, 'SILLON'), it(239.5, 86.9, 'TOGO'),
  it(268.3, 86.9, 'PHLOX'), it(297.1, 86.9, 'AMBRE'), it(325.9, 86.9, '443'), it(415.9, 86.9, 'EU/FR'), it(458.6, 86.9, '1488,40'),
  // Togo armchair in SPORT
  it(83.6, 102.9, '1'), it(94.4, 102.9, '15420000'), it(138.7, 102.9, 'SILLON'), it(239.5, 102.9, 'TOGO'),
  it(268.3, 102.9, 'SPORT'), it(297.1, 102.9, 'HOCKEY'), it(330.7, 102.9, '113'), it(458.6, 102.9, '1336,49'),
  // Togo armchair in HARALD
  it(83.6, 118.8, '1'), it(94.4, 118.8, '15420000'), it(138.7, 118.8, 'SILLON'), it(239.5, 118.8, 'TOGO'),
  it(268.3, 118.8, 'HARALD-3'), it(311.5, 118.8, 'MELEZE'), it(345.1, 118.8, '952'), it(458.6, 118.8, '1373,02'),

  // ---- group 149551 — HS 69131000 (porcelain vases → NOT furniture) ----
  it(19.4, 228.2, '149551'), it(112.9, 228.2, 'Cmq'), it(138.7, 228.2, 'EXPO'), it(414.8, 228.2, '69131000'), it(529, 228.2, '289,45'),
  it(83.6, 249, '2'), it(94.4, 249, '11230082'), it(138.7, 249, 'FLORERO'), it(177.1, 249, 'BAJO'),
  it(234.7, 249, 'DALVA'), it(263.5, 249, 'BLANCO'), it(297.1, 249, 'MATE'), it(415.9, 249, 'EU/PT'), it(468.2, 249, '88,61'),
  it(138.7, 260.2, 'DIA'), it(157.9, 260.2, '200'), it(177.1, 260.2, 'X'), it(186.7, 260.2, 'AL'), it(201.1, 260.2, '185'), it(220.3, 260.2, 'MM'),
  it(83.6, 276.2, '1'), it(94.4, 276.2, '11230083'), it(138.7, 276.2, 'FLORERO'), it(177.1, 276.2, 'ALTO'), it(234.7, 276.2, 'DALVA'), it(463.4, 276.2, '112,23'),

  // ---- group 149569 — HS 94018000 (Mini Togo seat) ----
  it(19.4, 724.2, '149569'), it(112.9, 724.2, 'Cmq'), it(138.7, 724.2, 'EXPO'), it(414.8, 724.2, '94018000'), it(519.4, 724.2, '1.701,87'),
  it(83.6, 744.9, '1'), it(94.4, 744.9, '14100100'), it(138.7, 744.9, 'MINI'), it(239.5, 744.9, 'TOGO'),
  it(268.3, 744.9, 'ALCANTARA'), it(316.3, 744.9, 'GOYA'), it(340.3, 744.9, 'RED'), it(359.5, 744.9, 'Y396'), it(415.9, 744.9, 'EU/FR'), it(463.4, 744.9, '567,29'),
];

test('parses every article line, with group order-no and HS code', () => {
  const { lines } = parseRosetInvoice(FIXTURE);
  // 3 Togo + 2 vases + 1 Mini Togo
  assert.equal(lines.length, 6);
  assert.equal(lines[0].orderNo, '149547');
  assert.equal(lines[0].hsCode, '94018000');
});

test('same reference, three fabrics, three costs → three distinct pieces', () => {
  const { furniture } = parseRosetInvoice(FIXTURE);
  const togo = furniture.filter((l) => l.reference === '15420000');
  assert.equal(togo.length, 3);
  assert.deepEqual(togo.map((l) => l.fabric), ['PHLOX AMBRE 443', 'SPORT HOCKEY 113', 'HARALD-3 MELEZE 952']);
  assert.deepEqual(togo.map((l) => l.unitCostUsd), [1488.40, 1336.49, 1373.02]);
  assert.deepEqual(togo.map((l) => l.quantity), [1, 1, 1]);
});

test('full description = TYPE MODEL FABRIC; origin captured', () => {
  const { furniture } = parseRosetInvoice(FIXTURE);
  const first = furniture[0];
  assert.equal(first.description, 'SILLON TOGO PHLOX AMBRE 443');
  assert.equal(first.origin, 'EU/FR');
});

test('furniture filter keeps seats (9401), drops vases (6913)', () => {
  const { lines, furniture } = parseRosetInvoice(FIXTURE);
  // 3 Togo armchairs + 1 Mini Togo = 4 furniture pieces
  assert.equal(furniture.length, 4);
  assert.ok(furniture.every((l) => l.isFurniture));
  // the two vases are present in lines but not furniture
  const vases = lines.filter((l) => l.reference.startsWith('1123008'));
  assert.equal(vases.length, 2);
  assert.ok(vases.every((l) => !l.isFurniture));
});

test('continuation rows append to the article description (dimensions)', () => {
  const { lines } = parseRosetInvoice(FIXTURE);
  const vaseBajo = lines.find((l) => l.reference === '11230082');
  assert.match(vaseBajo.description, /DIA 200 X AL 185 MM/);
});

test('Mini Togo fabric = ALCANTARA GOYA RED Y396', () => {
  const { furniture } = parseRosetInvoice(FIXTURE);
  const mini = furniture.find((l) => l.reference === '14100100');
  assert.equal(mini.fabric, 'ALCANTARA GOYA RED Y396');
  assert.equal(mini.unitCostUsd, 567.29);
});
