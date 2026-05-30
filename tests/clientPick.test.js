// Tests for src/lib/clientPick.js — the optimistic, client-side replay of a
// public-quote pick. Must mirror the quote-share Edge Function so the
// instant preview matches the server's reconciled bundle.

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyClientPick } from '../src/lib/clientPick.js';

function bundle() {
  return {
    quote: { currencyCode: 'USD', rates: { USD: 1 } },
    lines: [
      { id: 'a', alternativeGroup: 'g1', isSelectedAlternative: true, name: 'Opción A', unitPrice: 100, qty: 1 },
      { id: 'b', alternativeGroup: 'g1', isSelectedAlternative: false, name: 'Opción B', unitPrice: 120, qty: 1 },
      { id: 'opt', isOptional: true, optionalOffered: true, name: 'Cojín', unitPrice: 50, qty: 1 },
      // An optional the dealer did NOT offer as client-toggleable (no
      // optionalOffered) — the recipient must not be able to flip it.
      { id: 'optLocked', isOptional: true, name: 'Garantía', unitPrice: 80, qty: 1 },
      {
        id: 'm', name: 'Sofá', reference: '12345678A', subtype: 'Grade A — Tela X',
        unitPrice: 100, qty: 2, swatchImageId: 'sw-A',
        materialOptions: {
          baseGrade: 'A', baseLabel: 'Tela X', options: [
            { grade: 'C', label: 'Tela Y', code: '111', swatchImageId: 'sw-C', delta: 50 },
            { grade: 'D', label: 'Cuero Z', code: '222', swatchImageId: 'sw-D', delta: 90 },
          ],
        },
      },
      {
        id: 'cmp', name: 'Modular', components: [
          {
            id: 'c1', name: 'Chaise', reference: '87654321A', subtype: 'Grade A — Tela X',
            unitPrice: 200, qty: 1, swatchImageId: 'sw-cA',
            materialOptions: { baseGrade: 'A', baseLabel: 'Tela X', options: [{ grade: 'C', label: 'Tela Y', swatchImageId: 'sw-cC', delta: 30 }] },
          },
          // An offered-optional sub-piece the client may fold in / out.
          { id: 'c2', name: 'Otomana', unitPrice: 75, qty: 1, isOptional: true, optionalOffered: true },
          // Optional but NOT offered — the client must not be able to flip it.
          { id: 'c3', name: 'Garantía', unitPrice: 20, qty: 1, isOptional: true },
        ],
      },
    ],
  };
}
const line = (b, id) => b.lines.find((l) => l.id === id);
const comp = (b, lineId, compId) => line(b, lineId).components.find((c) => c.id === compId);

test('alternative: only the chosen member stays selected', () => {
  const out = applyClientPick(bundle(), { alternatives: { g1: 'b' } });
  assert.equal(line(out, 'a').isSelectedAlternative, false);
  assert.equal(line(out, 'b').isSelectedAlternative, true);
});

test('alternative: no-op picks return the same bundle reference', () => {
  const b = bundle();
  assert.equal(applyClientPick(b, { alternatives: { g1: 'a' } }), b); // a already selected
  assert.equal(applyClientPick(b, { alternatives: { g1: 'ghost' } }), b); // invalid member
  assert.equal(applyClientPick(b, { alternatives: { nope: 'b' } }), b); // invalid group
});

test('optional: toggles in AND back out (offered lines, bidirectional)', () => {
  const b = bundle();
  // ON folds the add-on into the quote.
  const on = applyClientPick(b, { optionals: { opt: true } });
  assert.equal(line(on, 'opt').isOptional, false);
  // Re-applying the same state is a no-op (same reference).
  assert.equal(applyClientPick(on, { optionals: { opt: true } }), on);
  // OFF takes it back out — the toggle is reversible now.
  const off = applyClientPick(on, { optionals: { opt: false } });
  assert.equal(line(off, 'opt').isOptional, true);
});

test('optional: a non-offered optional can NOT be toggled by the client', () => {
  const b = bundle();
  assert.equal(applyClientPick(b, { optionals: { optLocked: true } }), b);
  assert.equal(line(b, 'optLocked').isOptional, true);
});

test('optional (component): an offered sub-piece toggles in AND back out', () => {
  const b = bundle();
  const on = applyClientPick(b, { optionals: { c2: true } });
  assert.equal(comp(on, 'cmp', 'c2').isOptional, false);              // folded in
  assert.equal(applyClientPick(on, { optionals: { c2: true } }), on); // same state → no-op
  const off = applyClientPick(on, { optionals: { c2: false } });
  assert.equal(comp(off, 'cmp', 'c2').isOptional, true);              // taken back out
  assert.equal(comp(on, 'cmp', 'c1').unitPrice, 200);                 // siblings untouched
});

test('optional (component): a non-offered component optional can NOT be toggled', () => {
  const b = bundle();
  assert.equal(applyClientPick(b, { optionals: { c3: true } }), b);
  assert.equal(comp(b, 'cmp', 'c3').isOptional, true);
});

test('alternative (component): selecting flips the chosen sub-piece within a compound', () => {
  const b = {
    quote: { currencyCode: 'USD', rates: { USD: 1 } },
    lines: [{
      id: 'cmp2', name: 'Sofá', components: [
        { id: 'p', alternativeGroup: 'cg', isSelectedAlternative: true, name: 'Tela', unitPrice: 100, qty: 1 },
        { id: 'q', alternativeGroup: 'cg', isSelectedAlternative: false, name: 'Cuero', unitPrice: 200, qty: 1 },
      ],
    }],
  };
  const out = applyClientPick(b, { alternatives: { cg: 'q' } });
  const comps = out.lines[0].components;
  assert.equal(comps.find((c) => c.id === 'p').isSelectedAlternative, false);
  assert.equal(comps.find((c) => c.id === 'q').isSelectedAlternative, true);
  // Invalid member → no-op (same reference back).
  assert.equal(applyClientPick(b, { alternatives: { cg: 'ghost' } }), b);
});

test('material (line): reprices via delta, recomposes subtype/reference/swatch, re-anchors options', () => {
  const out = applyClientPick(bundle(), { materials: { m: 'C' } });
  const m = line(out, 'm');
  assert.equal(m.unitPrice, 150);                  // 100 + delta(50)
  assert.equal(m.subtype, 'Grade C — Tela Y');
  assert.equal(m.reference, '12345678C');
  assert.equal(m.swatchImageId, 'sw-C');
  assert.equal(m.materialOptions.baseGrade, 'C');
  assert.equal(m.materialOptions.baseLabel, 'Tela Y');
  const opts = m.materialOptions.options;
  const d = opts.find((o) => o.grade === 'D');
  const oldBase = opts.find((o) => o.grade === 'A');
  assert.equal(d.delta, 40);                        // 90 - 50, re-based to new base C
  assert.equal(oldBase.delta, -50);                 // old base demoted, carries -picked
  assert.equal(oldBase.swatchImageId, 'sw-A');      // keeps the swatch it had
  assert.equal(oldBase.label, 'Tela X');
});

test('material (line): switching there and back round-trips price + options exactly', () => {
  const once = applyClientPick(bundle(), { materials: { m: 'C' } });
  const back = applyClientPick(once, { materials: { m: 'A' } });
  const m = line(back, 'm');
  assert.equal(m.unitPrice, 100);
  assert.equal(m.subtype, 'Grade A — Tela X');
  assert.equal(m.reference, '12345678A');
  assert.equal(m.swatchImageId, 'sw-A');
  assert.equal(m.materialOptions.baseGrade, 'A');
  assert.equal(m.materialOptions.options.find((o) => o.grade === 'C').delta, 50);
  assert.equal(m.materialOptions.options.find((o) => o.grade === 'D').delta, 90);
});

test('material: an unoffered grade is left untouched', () => {
  const b = bundle();
  assert.equal(applyClientPick(b, { materials: { m: 'Z' } }), b);
});

test('material (component): switches the right component inside a compound line', () => {
  const out = applyClientPick(bundle(), { materials: { c1: 'C' } });
  const c = line(out, 'cmp').components[0];
  assert.equal(c.unitPrice, 230);                  // 200 + delta(30)
  assert.equal(c.subtype, 'Grade C — Tela Y');
  assert.equal(c.reference, '87654321C');
  assert.equal(c.swatchImageId, 'sw-cC');
  assert.equal(c.materialOptions.baseGrade, 'C');
  // other lines untouched
  assert.equal(line(out, 'm').unitPrice, 100);
});

test('does not mutate the input bundle', () => {
  const b = bundle();
  applyClientPick(b, { materials: { m: 'C' }, alternatives: { g1: 'b' }, optionals: { opt: true } });
  assert.equal(line(b, 'm').unitPrice, 100);
  assert.equal(line(b, 'm').subtype, 'Grade A — Tela X');
  assert.equal(line(b, 'a').isSelectedAlternative, true);
  assert.equal(line(b, 'opt').isOptional, true);
});
