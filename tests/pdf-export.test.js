/**
 * Smoke test for the PDF generator. We don't unit-test pdf-lib's
 * internals — that's its job — but we want to know that the *integration*
 * works for the exact thing that used to break: a quote whose lines and
 * totals contain characters outside the WinAnsi (Latin-1) range.
 *
 * Specifically we exercise:
 *   • '≈' (U+2248) in the FX shadow — the smoking-gun character that
 *     blew up the previous implementation with "WinAnsi cannot encode".
 *   • '–' (U+2013 en dash) in a discount label.
 *   • 'ñ' / accented Latin in a customer name and product name.
 *   • '…' (U+2026 ellipsis) in a description.
 *   • Curly quotes '"' '"' '‘' '’' in terms text.
 *
 * The whole point: this set of inputs would have thrown synchronously
 * with StandardFonts.Helvetica + WinAnsi. With Inter embedded via
 * fontkit, the export completes and we get a valid PDF blob.
 *
 * The font fetch is stubbed because Node's `fetch` won't resolve
 * `/fonts/...` paths — we read the TTFs directly from disk.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fontDir = resolve(here, '..', 'public', 'fonts');

// Stub global fetch — generateQuotePdf does `fetch('/fonts/Inter-*.ttf')`
// for its embedded typography. Map those paths to local file reads so
// the test can run without a Vite dev server.
globalThis.fetch = async (url) => {
  if (typeof url !== 'string') url = String(url);
  if (url.startsWith('/fonts/')) {
    const buf = await readFile(resolve(fontDir, url.replace('/fonts/', '')));
    // Return a Response-shaped object with just the bits pdf-lib needs.
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  }
  throw new Error(`unexpected fetch in test: ${url}`);
};

test('PDF export survives Unicode characters that used to crash WinAnsi', async () => {
  // Import after the fetch stub is in place — the module body itself
  // doesn't fetch, but being explicit avoids order-of-load surprises.
  const { generateQuotePdf } = await import('../src/pdf/quotePdf.js');

  const quote = {
    id: 'q-test',
    number: 1001,
    status: 'sent',
    currencyCode: 'USD',
    rates: { USD: 1, DOP: 60.5 },
    marginPct: 0,
    discountPct: 5,
    shipping: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    terms: 'Pago a 30 días — entrega "en sitio" según acuerdo… No incluye instalación.',
  };
  const settings = {
    companyName: 'Cañón & Compañía',
    companyAddress: 'Av. Núñez de Cáceres #42',
    companyPhone: '809-555-0100',
    companyEmail: 'ventas@example.do',
    fxRate: 60.5,
  };
  const lines = [
    {
      id: 'l1', kind: 'section', name: 'Mobiliario de sala — colección Togo',
    },
    {
      id: 'l2', kind: 'item',
      family: 'TOGO',
      name: 'Sofá 3 plazas — edición clásica',
      subtype: 'Grade C · Alcantara mostaza',
      reference: 'TG-300',
      dimensions: 'H 33" × L 102" × P 65"',
      description: 'Choice of natural or black-stained ash… please specify when placing your order.',
      notes: 'Internal: confirm finish with the showroom — must not print.',
      qty: 1,
      unitPrice: 4250,
      lineMarginPct: 0,
      lineDiscountPct: 0,
    },
  ];
  const totals = {
    subtotal: 4250,
    marginAmt: 0,
    discountAmt: 212.5,
    taxableBase: 4037.5,
    taxAmt: 726.75,
    shipping: 0,
    grandTotal: 4764.25,
    taxPct: 18,
  };
  const customer = {
    id: 'c1',
    name: 'María Peña-Núñez',
    company: 'Estudio "Casa & Diseño"',
    address: 'Calle José Reyes #88',
    city: 'Santo Domingo',
    country: 'República Dominicana',
    email: 'maria@example.do',
    phone: '809-555-0200',
  };

  const blob = await generateQuotePdf({ quote, settings, lines, totals, customer });

  // A valid PDF blob: non-zero size, application/pdf MIME, %PDF header
  // when read back as bytes. We don't try to parse the structure —
  // pdf-lib is responsible for that — but we confirm the magic bytes.
  assert.ok(blob, 'blob produced');
  assert.equal(blob.type, 'application/pdf', 'mime is application/pdf');
  assert.ok(blob.size > 1000, `blob has meaningful size, got ${blob.size}`);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const header = String.fromCharCode(...bytes.slice(0, 5));
  assert.equal(header, '%PDF-', `pdf magic bytes present, got "${header}"`);
});
