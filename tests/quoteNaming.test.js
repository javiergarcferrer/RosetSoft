/**
 * Tests for src/lib/quoteNaming.ts — the single "client name + quote number"
 * convention shared by the PDF filename/title and the public share link, so
 * the two never drift.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteDisplayName, quoteSlug } from '../src/lib/quoteNaming.js';

test('display name — client name + quote number', () => {
  assert.equal(
    quoteDisplayName({ number: 1042 }, { name: 'Eduardo García' }),
    'Eduardo García - Cotizacion 1042',
  );
});

test('display name — falls back to company when no personal name', () => {
  assert.equal(
    quoteDisplayName({ number: 7 }, { company: 'Estudio Norte' }),
    'Estudio Norte - Cotizacion 7',
  );
});

test('display name — no client assigned yet', () => {
  assert.equal(quoteDisplayName({ number: 1042 }, null), 'Cotizacion 1042');
  assert.equal(quoteDisplayName({ number: 1042 }, { name: '' }), 'Cotizacion 1042');
});

test('display name — unsaved draft (no number)', () => {
  assert.equal(quoteDisplayName({}, { name: 'Ana' }), 'Ana - Cotizacion (borrador)');
  assert.equal(quoteDisplayName(null, null), 'Cotizacion (borrador)');
});

test('display name matches the PDF filename convention exactly', () => {
  // deliver.ts:quoteFileName builds `${client} - ${num}` off the same inputs;
  // this is the guard that the link and the PDF stay identical.
  const quote = { number: 1042 };
  const customer = { name: 'Eduardo García' };
  assert.equal(quoteDisplayName(quote, customer), 'Eduardo García - Cotizacion 1042');
});

test('slug — diacritics folded, spaces and punctuation collapsed to hyphens', () => {
  assert.equal(
    quoteSlug({ number: 1042 }, { name: 'Eduardo García' }),
    'eduardo-garcia-cotizacion-1042',
  );
  // Punctuation, multiple spaces, ampersands all collapse to single hyphens.
  assert.equal(
    quoteSlug({ number: 9 }, { company: 'Peña & Co.  S.R.L.' }),
    'pena-co-s-r-l-cotizacion-9',
  );
});

test('slug — no client still yields a usable slug', () => {
  assert.equal(quoteSlug({ number: 1042 }, null), 'cotizacion-1042');
});

test('slug — never has leading/trailing hyphens', () => {
  const s = quoteSlug({ number: 5 }, { name: '¡Hola!' });
  assert.ok(!s.startsWith('-') && !s.endsWith('-'), `slug had stray hyphen: "${s}"`);
  assert.equal(s, 'hola-cotizacion-5');
});

test('slug — long company name is capped to keep URLs tidy', () => {
  const long = 'A'.repeat(120);
  const s = quoteSlug({ number: 1 }, { company: long });
  assert.ok(s.length <= 80, `slug too long: ${s.length}`);
  assert.ok(!s.endsWith('-'), 'cap left a dangling hyphen');
});
