/**
 * Tests for src/lib/priceListCsv.js — the Ligne Roset price-list CSV parser
 * (RFC-4180 cells, dimension splitting, column mapping). Sample rows are taken
 * verbatim from the real "LigneRosetPriceList_Profits May 2026.csv".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, splitDimensions, parsePriceList } from '../src/lib/priceListCsv.js';

const HEADER = 'SKU,Description 1,Description 2,Sales Code,Sales Code Description,Sales Code Divisor,Retail,Cost,Category Code,Category Description,Item Style Code,Item Style Code Description';

/* ------------------------------ parseCsv ------------------------------ */

test('parses plain rows', () => {
  const rows = parseCsv('a,b,c\n1,2,3\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('handles quoted fields with embedded commas and "" escapes', () => {
  // RUCHE row: the Description 1 is quoted and contains embedded inch-quotes.
  const line = '15131900C,"RUCHE KING SIZE 76"" x 80""",LOW HEADBOARD,15M,BEDS,2.68,8260,3082.09';
  const [row] = parseCsv(line);
  assert.equal(row[0], '15131900C');
  assert.equal(row[1], 'RUCHE KING SIZE 76" x 80"');
  assert.equal(row[2], 'LOW HEADBOARD');
  assert.equal(row[6], '8260');
  assert.equal(row[7], '3082.09');
});

test('strips a leading BOM', () => {
  const rows = parseCsv('﻿SKU,Retail\nX1,100');
  assert.equal(rows[0][0], 'SKU');
});

/* ------------------------------ splitDimensions ------------------------------ */

test('splits finish from the H/D/S/W dimension tail', () => {
  const { subtype, dimensions } = splitDimensions('LIGHT NATURAL ASH W/O HANDLE H(33) - D(22.75) - S(19.75) - W(23.50)');
  assert.equal(subtype, 'LIGHT NATURAL ASH W/O HANDLE');
  assert.equal(dimensions, 'H(33) - D(22.75) - S(19.75) - W(23.50)');
});

test('does not mistake "W/O" or "W/HANDLE" for a dimension token', () => {
  const { subtype, dimensions } = splitDimensions('BLACK STAINED ASH W/HANDLE H(40.50) - D(20.50)');
  assert.equal(subtype, 'BLACK STAINED ASH W/HANDLE');
  assert.equal(dimensions, 'H(40.50) - D(20.50)');
});

test('handles a THK( token and no-dimension case', () => {
  assert.equal(splitDimensions('PLAIN VERSION THK(3.25) - H(38.25)').dimensions, 'THK(3.25) - H(38.25)');
  assert.deepEqual(splitDimensions('JUST A FINISH'), { subtype: 'JUST A FINISH', dimensions: '' });
});

/* ------------------------------ parsePriceList ------------------------------ */

test('maps a sample row to a product by header name', () => {
  const csv = `${HEADER}\n10261152W,VIK CHAIR W/ARMS,LIGHT NATURAL ASH W/O HANDLE H(33) - D(22.75) - S(19.75) - W(23.50),106,DINING CHAIRS,2.68,2165,807.84,958,DINING CHAIRS,6,106 DINING CHAIRS`;
  const products = parsePriceList(csv);
  assert.equal(products.length, 1);
  assert.deepEqual(products[0], {
    reference: '10261152W',
    name: 'VIK CHAIR W/ARMS',
    subtype: 'LIGHT NATURAL ASH W/O HANDLE',
    dimensions: 'H(33) - D(22.75) - S(19.75) - W(23.50)',
    family: 'DINING CHAIRS',
    familyCode: '106',
    category: 'DINING CHAIRS',
    priceUsd: 2165,
    cost: 807.84,
  });
});

test('confirms Cost = Retail / Sales Code Divisor on the sample', () => {
  const csv = `${HEADER}\n10261150S,VIK CHAIR W/ARMS,BLACK STAINED ASH,106,DINING CHAIRS,2.68,1785,666.04,958,DINING CHAIRS,6,106 DINING CHAIRS`;
  const p = parsePriceList(csv)[0];
  assert.ok(Math.abs(p.priceUsd / 2.68 - p.cost) < 0.01);
});

test('skips rows with no SKU; tolerates missing columns', () => {
  const csv = `${HEADER}\n,No SKU here,,,,,,\n9999X,ONLY NAME,,,,,1000,400,,,,`;
  const products = parsePriceList(csv);
  assert.equal(products.length, 1);
  assert.equal(products[0].reference, '9999X');
  assert.equal(products[0].priceUsd, 1000);
});
