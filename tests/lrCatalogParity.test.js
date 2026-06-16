// Parity contract across the Deno↔Vite wall — the catalog MERGE.
//
// The website-only sync that keeps the Materials catalog current runs at TWO
// layers that can't share code (separate runtimes):
//   • CLIENT — src/lib/lrCatalog.ts `mergeCatalog`, inside the manual "Importar"
//     flow (merges the sweep into the catalog the browser holds, writes via db).
//   • SERVER — supabase/functions/lr-catalog/merge.ts `mergeCatalog`, inside the
//     WEEKLY cron (merges the sweep into the rows it reads, upserts them).
//
// They are deliberate copies. This test is what keeps them from drifting: it
// runs the SAME corpus through both and asserts byte-equal rows + summary. If a
// merge rule is changed on one side only, this goes red — fix the other side,
// never relax this. (Same role as quotePickParity.test.js for the pick reducer.)

import test from 'node:test';
import assert from 'node:assert/strict';

import * as vite from '../src/lib/lrCatalog.js';
import * as deno from '../supabase/functions/lr-catalog/merge.ts';

const PROFILE = 'team';
const NOW = 1_700_000_000_000;

// Fresh fixtures per call so neither reducer can observe the other's input
// (and so a deterministic newId sequence lines up id-for-id across both).
function existingFixture() {
  return [
    // colors add/remove + imageId carried + composition filled + notes set
    {
      id: 'diva', profileId: PROFILE, category: 'fabric', name: 'DIVA',
      grade: 'C', price: 80, priceUnit: 'yard', measure: 55, measureUnit: 'in',
      composition: null, notes: null,
      colors: [{ name: 'Red', code: '100' }, { name: 'Blue', code: '200', imageId: 'img-blue' }],
      createdAt: NOW - 9000, updatedAt: NOW - 9000,
    },
    // flagged → reappears on site → restored; composition already set → kept
    {
      id: 'vidar', profileId: PROFILE, category: 'fabric', name: 'VIDAR',
      grade: 'D', composition: 'EXISTING COMP', notes: null,
      colors: [{ name: 'A', code: '1' }],
      discontinuedAt: NOW - 1000, createdAt: NOW - 9000, updatedAt: NOW - 1000,
    },
    // identical on the site → unchanged (no row)
    {
      id: 'steel', profileId: PROFILE, category: 'leather', name: 'STEELCUT',
      grade: 'A', composition: 'C', notes: 'KEEP',
      colors: [{ name: 'X', code: '9' }],
      createdAt: NOW - 9000, updatedAt: NOW - 9000,
    },
    // not in the sweep → complete: flagged; partial: untouched
    {
      id: 'ghost', profileId: PROFILE, category: 'fabric', name: 'GHOST',
      grade: 'B', composition: null, notes: null,
      colors: [{ name: 'g', code: '5' }],
      createdAt: NOW - 9000, updatedAt: NOW - 9000,
    },
    // empty colors payload must NOT wipe the color set (notes change forces a row)
    {
      id: 'empty', profileId: PROFILE, category: 'fabric', name: 'EMPTYPAT',
      grade: 'A', composition: 'HELD', notes: null,
      colors: [{ name: 'keep', code: '7' }],
      createdAt: NOW - 9000, updatedAt: NOW - 9000,
    },
  ];
}

function patternsFixture() {
  return [
    { name: 'DIVA', type: 'Velvets', composition: 'WOOL 100%', remark: 'CARE: dry clean',
      colors: [{ code: '200', name: 'Blue' }, { code: '300', name: 'Green' }] },
    { name: 'VIDAR', type: 'Fabrics', composition: 'NEW COMP', remark: null,
      colors: [{ code: '1', name: 'A' }] },
    { name: 'STEELCUT', type: 'Leather', composition: 'C', remark: 'KEEP',
      colors: [{ code: '9', name: 'X' }] },
    { name: 'EMPTYPAT', type: 'Fabrics', composition: null, remark: 'NEW NOTE',
      colors: [] },
    // brand-new fabric (leather → mm / sm defaults)
    { name: 'NEWFAB', type: 'Leather', composition: 'LEATHER', remark: null,
      colors: [{ code: '900', name: 'Tan' }] },
  ];
}

// A deterministic, identical id factory for each reducer call.
const makeIds = () => { let n = 0; return () => `gen-${n++}`; };

function runBoth(complete) {
  const v = vite.mergeCatalog(existingFixture(), patternsFixture(), { profileId: PROFILE, now: NOW, newId: makeIds(), complete });
  const d = deno.mergeCatalog(existingFixture(), patternsFixture(), { profileId: PROFILE, now: NOW, newId: makeIds(), complete });
  return { v, d };
}

const byId = (rows, id) => rows.find((r) => r.id === id);

// ── The shared rule: identical rows + summary on both sides ───────────────────

test('parity — full sweep (complete: true) merges identically', () => {
  const { v, d } = runBoth(true);
  assert.deepStrictEqual(d, v);
});

test('parity — partial sweep (complete: false) merges identically', () => {
  const { v, d } = runBoth(false);
  assert.deepStrictEqual(d, v);
});

// ── Sanity: the corpus actually exercises every branch (so parity means something)

test('the corpus exercises add/remove/restore/new/flag/preserve', () => {
  const { d } = runBoth(true);
  const rows = d.rows;

  // DIVA: colors replaced (200 kept w/ imageId, 300 added, 100 dropped), comp filled, notes set
  const diva = byId(rows, 'diva');
  assert.deepStrictEqual(diva.colors, [{ name: 'Blue', code: '200', imageId: 'img-blue' }, { name: 'Green', code: '300' }]);
  assert.equal(diva.composition, 'WOOL 100%');
  assert.equal(diva.notes, 'CARE: dry clean');
  assert.equal(diva.discontinuedAt, null);

  // VIDAR: reappeared → un-flagged; its already-set composition is preserved
  const vidar = byId(rows, 'vidar');
  assert.equal(vidar.discontinuedAt, null);
  assert.equal(vidar.composition, 'EXISTING COMP');

  // STEELCUT: identical on site → no row emitted
  assert.equal(byId(rows, 'steel'), undefined);

  // GHOST: missing from a complete sweep → flagged (kept, not deleted)
  const ghost = byId(rows, 'ghost');
  assert.equal(ghost.discontinuedAt, NOW);
  assert.deepStrictEqual(ghost.colors, [{ name: 'g', code: '5' }]);

  // EMPTYPAT: empty payload preserves the color set; only the note changed
  const empty = byId(rows, 'empty');
  assert.deepStrictEqual(empty.colors, [{ name: 'keep', code: '7' }]);
  assert.equal(empty.notes, 'NEW NOTE');

  // NEWFAB: created with leather defaults
  const created = rows.find((r) => r.name === 'NEWFAB');
  assert.equal(created.id, 'gen-0');
  assert.equal(created.category, 'leather');
  assert.equal(created.measureUnit, 'mm');
  assert.equal(created.priceUnit, 'sm');
  assert.equal(created.grade, null);

  assert.equal(d.summary.flaggedMissing, 1);
  assert.equal(d.summary.restored, 1);
  assert.equal(d.summary.newMaterials, 1);
});

test('the corpus distinguishes complete vs partial (only complete flags GHOST)', () => {
  const partial = runBoth(false).d;
  assert.equal(byId(partial.rows, 'ghost'), undefined);
  assert.equal(partial.summary.flaggedMissing, 0);
});

// ── Helper parity (the merge's building blocks, used in both layers) ──────────

test('parity — normalizeName / lrTypeToCategory / cleanNotes agree across the wall', () => {
  for (const n of ['  alcantara - a ', 'Steelcut  Trio 3/FR', 'MOSAÏC', 'MOSAÍC', null, '']) {
    assert.equal(deno.normalizeName(n), vite.normalizeName(n), `normalizeName ${JSON.stringify(n)}`);
  }
  for (const t of ['Leather', 'Outdoor fabrics', 'Velvets', 'Microfibres', null]) {
    assert.equal(deno.lrTypeToCategory(t), vite.lrTypeToCategory(t), `lrTypeToCategory ${t}`);
  }
  for (const r of [' SWATCH A', 'SWATCH B', '', null, 'THIS FABRIC IS NOT TB117-2013 APPROVED   X']) {
    assert.equal(deno.cleanNotes(r), vite.cleanNotes(r), `cleanNotes ${JSON.stringify(r)}`);
  }
});
