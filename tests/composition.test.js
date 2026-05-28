/**
 * Tests for src/lib/composition.js — the heuristic parser that turns a fabric's
 * free-text composition ("COTTON 80%, POLYESTER 20%") into fiber/percent parts
 * and a primary (dominant) fiber, so the catalog picker can sort and group by
 * fiber without a schema change.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseComposition,
  primaryFiber,
  compositionGroup,
  NO_COMPOSITION,
} from '../src/lib/composition.js';

test('parse — fiber then percent', () => {
  assert.deepEqual(parseComposition('COTTON 80%, POLYESTER 20%'), [
    { fiber: 'Cotton', pct: 80 },
    { fiber: 'Polyester', pct: 20 },
  ]);
});

test('parse — percent then fiber', () => {
  assert.deepEqual(parseComposition('80% COTTON, 20% POLYESTER'), [
    { fiber: 'Cotton', pct: 80 },
    { fiber: 'Polyester', pct: 20 },
  ]);
});

test('parse — multi-word fiber and single component', () => {
  assert.deepEqual(parseComposition('100% VIRGIN WOOL'), [{ fiber: 'Virgin Wool', pct: 100 }]);
});

test('parse — no percentages keeps listed order', () => {
  assert.deepEqual(parseComposition('Linen, Cotton'), [
    { fiber: 'Linen', pct: null },
    { fiber: 'Cotton', pct: null },
  ]);
});

test('parse — tolerates slash, plus and "and"/"y" separators', () => {
  assert.deepEqual(parseComposition('Wool 70% + Nylon 30%'), [
    { fiber: 'Wool', pct: 70 },
    { fiber: 'Nylon', pct: 30 },
  ]);
  assert.deepEqual(parseComposition('Cotton and Linen'), [
    { fiber: 'Cotton', pct: null },
    { fiber: 'Linen', pct: null },
  ]);
});

test('parse — empty/blank yields no parts', () => {
  assert.deepEqual(parseComposition(''), []);
  assert.deepEqual(parseComposition(null), []);
  assert.deepEqual(parseComposition('   '), []);
});

test('primaryFiber — highest percentage wins regardless of order', () => {
  assert.equal(primaryFiber('POLYESTER 20%, COTTON 80%'), 'Cotton');
  assert.equal(primaryFiber('COTTON 80%, POLYESTER 20%'), 'Cotton');
  assert.equal(primaryFiber('100% LINEN'), 'Linen');
});

test('primaryFiber — first listed when no percentages', () => {
  assert.equal(primaryFiber('Linen, Cotton'), 'Linen');
});

test('primaryFiber — empty for blank text', () => {
  assert.equal(primaryFiber(''), '');
  assert.equal(primaryFiber(undefined), '');
});

test('compositionGroup — falls back to the no-composition bucket', () => {
  assert.equal(compositionGroup('COTTON 80%, POLYESTER 20%'), 'Cotton');
  assert.equal(compositionGroup(''), NO_COMPOSITION);
  assert.equal(compositionGroup(null), NO_COMPOSITION);
});
