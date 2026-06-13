// Pinned invariants for the AI reply-suggestion Model (core/crm/buildDraftTurns):
//
//   • the transcript fed to the `wa-draft` Edge Function maps inbound→customer
//     and outbound→agent, folds media to a short placeholder (so a photo still
//     gives context without shipping bytes), and drops rows that carry no reply
//     signal (reactions, system notices, empties).
//   • canDraft gates the composer button: it's true ONLY when there's an
//     inbound message to answer — no point drafting a reply to a thread the
//     customer never wrote in.
//   • the transcript is bounded (recent turns only, each capped) so the prompt
//     stays cheap and a runaway paste can't blow the request up.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftTurns } from '../src/core/crm/index.js';

test('maps direction to role and keeps chronological order', () => {
  const { turns, canDraft } = buildDraftTurns([
    { direction: 'in', kind: 'text', body: 'Hola, ¿tienen el sofá Togo?' },
    { direction: 'out', kind: 'text', body: 'Sí, en varias telas.' },
    { direction: 'in', kind: 'text', body: '¿Precio?' },
  ]);
  assert.deepEqual(turns, [
    { role: 'customer', text: 'Hola, ¿tienen el sofá Togo?' },
    { role: 'agent', text: 'Sí, en varias telas.' },
    { role: 'customer', text: '¿Precio?' },
  ]);
  assert.equal(canDraft, true);
});

test('folds media to a placeholder and labels templates', () => {
  const { turns } = buildDraftTurns([
    { direction: 'in', kind: 'image', body: '' },
    { direction: 'out', kind: 'template', templateName: 'bienvenida', body: '' },
    { direction: 'in', kind: 'audio' },
  ]);
  assert.deepEqual(turns.map((t) => t.text), ['[imagen]', '[plantilla · bienvenida]', '[nota de voz]']);
});

test('drops reactions, system notices, and empty rows (no reply signal)', () => {
  const { turns } = buildDraftTurns([
    { direction: 'in', kind: 'reaction', body: '❤️' },
    { direction: 'out', kind: 'system', body: 'Aviso' },
    { direction: 'in', kind: 'text', body: '   ' },
    { direction: 'in', kind: 'text', body: 'Buenas' },
  ]);
  assert.deepEqual(turns, [{ role: 'customer', text: 'Buenas' }]);
});

test('canDraft is false when the customer never wrote (only outbound)', () => {
  const { turns, canDraft } = buildDraftTurns([
    { direction: 'out', kind: 'text', body: 'Le escribimos de Alcover.' },
  ]);
  assert.equal(canDraft, false);
  assert.equal(turns.length, 1); // still built, just not offered
});

test('bounds the transcript: recent turns only, each capped', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ direction: 'in', kind: 'text', body: `m${i}` }));
  const { turns } = buildDraftTurns(many, { maxTurns: 16 });
  assert.equal(turns.length, 16);
  assert.equal(turns[turns.length - 1].text, 'm29'); // kept the latest

  const long = 'x'.repeat(5000);
  const { turns: capped } = buildDraftTurns([{ direction: 'in', kind: 'text', body: long }], { maxChars: 600 });
  assert.equal(capped[0].text.length, 601); // 600 chars + ellipsis
  assert.ok(capped[0].text.endsWith('…'));
});

test('handles empty / missing input without throwing', () => {
  assert.deepEqual(buildDraftTurns(), { turns: [], canDraft: false });
  assert.deepEqual(buildDraftTurns([]), { turns: [], canDraft: false });
});
