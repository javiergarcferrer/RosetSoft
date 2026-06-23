import { test } from 'node:test';
import assert from 'node:assert/strict';
import { togoQuickStarts } from '../src/lib/togo/quickStarts.js';

const M = (id, name) => ({ id, name });
const FBX4 = [M('c', 'Togo Corner'), M('f', 'Togo Fireside'), M('s', 'Togo Sofa w/o Arms'), M('l', 'Togo Loveseat')];

test('resolves templates against the available catalogue (roles can repeat)', () => {
  const qs = togoQuickStarts(FBX4);
  const ids = qs.map((q) => q.id);
  assert.ok(ids.includes('love'), 'loveseat present → Loveseat set');
  assert.ok(ids.includes('lshape'), 'corner+sofa+fireside present → L set');
  assert.ok(!ids.includes('lounge'), 'no lounge model → no lounge set');
  const lshape = qs.find((q) => q.id === 'lshape');
  assert.deepEqual(lshape.pieceIds, ['f', 's', 'c', 's'], 'roles resolve to ids, sofa reused');
});

test('a template needing a missing role is hidden', () => {
  const qs = togoQuickStarts([M('f', 'Togo Fireside')]);
  assert.deepEqual(qs.map((q) => q.id), ['armchair'], 'only the single-fireside set survives');
});

test('disambiguates loveseat from the generic sofa matcher', () => {
  // "Loveseat" must map to the loveseat role, not fall through to sofa.
  const qs = togoQuickStarts([M('l', 'Togo Loveseat')]);
  assert.deepEqual(qs.map((q) => q.id), ['love']);
});

test('empty / null input → no templates, never throws', () => {
  assert.deepEqual(togoQuickStarts([]), []);
  assert.deepEqual(togoQuickStarts(null), []);
});
