/**
 * Headless test harness — runs the same parser the browser uses against a
 * local PDF and prints a summary.
 *
 *   node tools/testParser.mjs <pdfPath>
 *
 * Implementation note: the parser modules under src/parser/lib/ are pure ES
 * modules with no Vite-specific imports, so we can `await import()` them
 * directly from Node. The fabricParser still uses the legacy pageReader,
 * so we stub the browser pdfjsSetup the same way the original harness did.
 */
import { readFileSync } from 'node:fs';

const [, , pdfPath] = process.argv;
if (!pdfPath) {
  console.error('Usage: node tools/testParser.mjs <pdfPath>');
  process.exit(1);
}

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  import.meta.url
).href;

import { Module } from 'node:module';
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req && req.endsWith('/pdfjsSetup.js')) {
    return new URL('./_pdfjs_node_setup.mjs', import.meta.url).pathname;
  }
  return origResolve.call(this, req, parent, ...rest);
};

const { classifyPage } = await import('../src/parser/lib/pageClassifier.js');
const { extractFamily } = await import('../src/parser/lib/extractFamily.js');
const { extractProductsFromPage } = await import('../src/parser/lib/extractProducts.js');
const { slugify } = await import('../src/parser/lib/textUtils.js');

const data = new Uint8Array(readFileSync(pdfPath));
const pdf = await pdfjs.getDocument({
  data, disableFontFace: true, isEvalSupported: false, useSystemFonts: false
}).promise;
console.log(`PDF: ${pdfPath} | pages: ${pdf.numPages}`);

const families = [];
const familyById = new Map();
const products = [];

let currentFamilyKey = null;
let currentFamilyName = null;
const counts = {};

const debug = process.env.DEBUG === '1';

for (let p = 1; p <= pdf.numPages; p++) {
  const page = await pdf.getPage(p);
  const tc = await page.getTextContent({ includeMarkedContent: false });
  const cls = classifyPage(tc.items);
  counts[cls.type] = (counts[cls.type] || 0) + 1;
  if (debug) console.error(`p${p}: ${cls.type}${cls.family ? ' ' + cls.family : ''}`);

  if (cls.type === 'family-intro') {
    const fam = extractFamily(cls.items, p);
    const familyName = fam.name || cls.family;
    if (!familyName) continue;
    const baseId = slugify(familyName);
    const variantKey = fam.code || (fam.year ? String(fam.year) : null);
    let id = baseId;
    const existing = familyById.get(baseId);
    if (existing) {
      const existingVariant = existing.code || (existing.year ? String(existing.year) : null);
      if (variantKey && existingVariant && variantKey !== existingVariant) {
        id = `${baseId}-${slugify(variantKey)}`;
      }
    }
    const entry = { id, ...fam, name: familyName };
    if (familyById.has(id)) Object.assign(familyById.get(id), entry);
    else { families.push(entry); familyById.set(id, entry); }
    currentFamilyKey = id;
    currentFamilyName = familyName;
    continue;
  }

  if (cls.type === 'product-list') {
    const familyOnPage = cls.family;
    if (familyOnPage) {
      const baseId = slugify(familyOnPage);
      const matchesCurrent = currentFamilyKey &&
        (currentFamilyKey === baseId || currentFamilyKey.startsWith(baseId + '-'));
      if (!matchesCurrent) {
        currentFamilyKey = baseId;
        currentFamilyName = familyOnPage;
        if (!familyById.has(baseId)) {
          const entry = { id: baseId, name: familyOnPage };
          families.push(entry); familyById.set(baseId, entry);
        }
      }
    }
    const pageProducts = extractProductsFromPage(cls.items, p, cls.refKind);
    for (const pr of pageProducts) {
      pr.family_id = currentFamilyKey || null;
      pr.family_name = currentFamilyName || null;
      products.push(pr);
    }
  }
}

const byRef = new Map();
for (const p of products) {
  const ex = byRef.get(p.reference);
  if (!ex || (p.prices?.length || 0) > (ex.prices?.length || 0)) byRef.set(p.reference, p);
}
const cleanProducts = [...byRef.values()];

console.log(`\n=== SUMMARY ===`);
for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(14)} ${v}`);
console.log(`\nFamilies:        ${families.length}`);
console.log(`Products (refs): ${cleanProducts.length}`);
console.log(`Price points:    ${cleanProducts.reduce((a, p) => a + (p.prices?.length || 0), 0)}`);

console.log(`\n=== TOP FAMILIES ===`);
const byFam = {};
for (const p of cleanProducts) {
  const k = p.family_name || '(unknown)';
  byFam[k] = (byFam[k] || 0) + 1;
}
const sorted = Object.entries(byFam).sort((a, b) => b[1] - a[1]).slice(0, 20);
for (const [name, n] of sorted) console.log(`  ${String(n).padStart(4)}  ${name}`);
