/**
 * Headless test harness: parse a PDF using the same code the browser uses,
 * then print a summary and assertions against expected products.
 *
 *   node tools/testParser.mjs <pdfPath>
 *
 * Implementation note: we bypass src/parser/pdfjsSetup.js (which uses Vite's
 * ?url import) by stubbing the worker path manually before importing the
 * other parser modules.
 */
import { readFileSync } from 'node:fs';

const [, , pdfPath] = process.argv;
if (!pdfPath) {
  console.error('Usage: node tools/testParser.mjs <pdfPath>');
  process.exit(1);
}

// Setup pdfjs first
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  import.meta.url
).href;

// Stub the browser pdfjsSetup module so productParser etc. find the same pdfjs
// We use a module loader hack: replace the import map for our setup file.
import { Module } from 'node:module';
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req && req.endsWith('/pdfjsSetup.js')) {
    return new URL('./_pdfjs_node_setup.mjs', import.meta.url).pathname;
  }
  return origResolve.call(this, req, parent, ...rest);
};

// Now import the parsers
const { openPdf, readPageItems, groupRows } = await import('../src/parser/pageReader.js');
const { classifyPage } = await import('../src/parser/classifier.js');
const productParser = await import('../src/parser/productParser.js');
const { parseMaterialPage } = await import('../src/parser/fabricParser.js');
const { parseCabinetryPage } = await import('../src/parser/cabinetryParser.js');

const data = new Uint8Array(readFileSync(pdfPath));
const pdf = await pdfjs.getDocument({ data, disableFontFace: true, isEvalSupported: false, useSystemFonts: false }).promise;

console.log(`PDF: ${pdfPath} | pages: ${pdf.numPages}`);

// Manually replicate the importer state machine (to avoid Dexie dependency)
const CATEGORY_HEADERS = [
  'COVER MATERIALS', 'SEATS', 'BEDS', 'LINENS', 'MATTRESSES AND SLATS',
  'DINING CHAIRS', 'SWIVELLING DESK CHAIRS', 'DINING TABLES', 'LOW TABLES',
  'DECORATIVE ACCESSORIES', 'TABLEWARE', 'RUGS', 'BEDCOVERS AND FURNISHING FABRICS',
  'CABINETRY', 'COVER MATERIALS - OUTDOOR', 'SEATS & CHAIRS - OUTDOOR',
  'TABLES - OUTDOOR', 'LIGHTING - OUTDOOR', 'DECORATIVE ACCESSORIES - OUTDOOR',
  'RUGS & CUSHIONS - OUTDOOR', 'CABINETRY TOUCH UP ITEMS & SAMPLES',
];

const productsByName = new Map();
const fabrics = [];
let currentCategory = null;
let currentProductKey = null;
const debug = process.env.DEBUG === '1';

for (let p = 1; p <= pdf.numPages; p++) {
  // Read items inline (mimics readPageItems)
  const page = await pdf.getPage(p);
  const viewport = page.getViewport({ scale: 1.0 });
  const tc = await page.getTextContent({ includeMarkedContent: false });
  const items = [];
  for (const it of tc.items) {
    if (!it.str || it.str === ' ') continue;
    const [a, b, , , e, f] = it.transform;
    const x = e;
    const y = viewport.height - f;
    const fontSize = Math.hypot(a, b) || it.height || 10;
    let rotation = 0;
    if (Math.abs(a) < 0.5 && Math.abs(b) > 0.5) rotation = b > 0 ? 90 : -90;
    else if (a < -0.5) rotation = 180;
    items.push({ str: it.str, x, y, w: it.width || 0, h: it.height || fontSize, fontSize, rotation, hasEOL: !!it.hasEOL });
  }

  const pageData = { items, width: viewport.width, height: viewport.height, pageNumber: p };
  const cls = classifyPage(pageData);

  if (debug) {
    console.error(`p${p}: ${cls.type}${cls.sectionName ? ' ' + cls.sectionName : ''}`);
  }

  if (cls.type === 'section') {
    const sectionName = cls.sectionName;
    if (currentProductKey && sectionName.toUpperCase() === currentProductKey) {
      const acc = productsByName.get(currentProductKey);
      if (acc && !acc.pages.includes(p)) acc.pages.push(p);
      continue;
    }
    const matched = CATEGORY_HEADERS.find((c) => c.toUpperCase() === sectionName.toUpperCase());
    if (matched) {
      currentCategory = matched;
    } else if (/\s/.test(sectionName) && sectionName.length > 8) {
      currentCategory = sectionName.toUpperCase();
    } else {
      let acc = productsByName.get(sectionName.toUpperCase());
      if (!acc) {
        acc = {
          name: sectionName, designer: '', year: null, description: '', impossibilities: [],
          modelCode: '', variants: [], pages: [], categoryName: currentCategory || 'SEATS',
        };
        productsByName.set(sectionName.toUpperCase(), acc);
      }
      currentProductKey = sectionName.toUpperCase();
      if (!acc.pages.includes(p)) acc.pages.push(p);
      continue;
    }
    currentProductKey = null;
    continue;
  }

  if (cls.type === 'fabric-list' || cls.type === 'outdoor-list' || cls.type === 'leather-list') {
    const kind = cls.type === 'leather-list' ? 'leather' : cls.type === 'outdoor-list' ? 'outdoor-fabric' : 'fabric';
    const found = parseMaterialPage(items, { kind });
    for (const m of found) fabrics.push({ ...m, page: p });
    continue;
  }

  if (cls.type === 'product' || cls.type === 'cabinetry') {
    const banner = productParser.extractBanner(items);
    const rows = groupRows(items, 2);
    let productKey;
    if (banner && isValid(banner)) {
      productKey = banner.toUpperCase();
      currentProductKey = productKey;
    } else if (currentProductKey) {
      productKey = currentProductKey;
    } else {
      continue;
    }

    let acc = productsByName.get(productKey);
    if (!acc) {
      acc = {
        name: banner || productKey,
        designer: '', year: null, description: '', impossibilities: [],
        modelCode: '', variants: [], pages: [], categoryName: currentCategory || 'SEATS',
      };
      productsByName.set(productKey, acc);
    }

    if (banner) {
      const designer = productParser.extractDesigner(rows);
      const year = productParser.extractYear(rows);
      if (designer && !acc.designer) acc.designer = designer;
      if (year && !acc.year) acc.year = year;
      const desc = productParser.extractDescription(rows);
      if (desc && !acc.description) acc.description = desc;
      const imp = productParser.extractImpossibilities(rows);
      if (imp.length && !acc.impossibilities.length) acc.impossibilities = imp;
      const code = productParser.extractModelCode(items);
      if (code && !acc.modelCode) acc.modelCode = code;
    }

    if (cls.type === 'cabinetry') {
      const cVariants = parseCabinetryPage(items);
      for (const v of cVariants) {
        const exists = acc.variants.some((x) => x.reference === v.reference);
        if (!exists) acc.variants.push(v);
      }
    } else {
      const variantTable = productParser.extractVariantTable(items);
      if (variantTable?.variants?.length) {
        for (const v of variantTable.variants) {
          const exists = acc.variants.some((x) =>
            (v.reference && x.reference === v.reference) ||
            (!v.reference && x.name === v.name)
          );
          if (!exists) acc.variants.push(v);
        }
      }
    }

    if (!acc.pages.includes(p)) acc.pages.push(p);
  }
}

function isValid(s) {
  const t = (s || '').trim();
  if (!t) return false;
  if (t.length < 2 || t.length > 50) return false;
  if (/^[A-Z][A-Z0-9 &'’.\-/]+$/.test(t)) return true;
  if (/^[A-Z][a-zA-Z ]+$/.test(t)) return true;
  return false;
}

const products = [...productsByName.values()].filter((p) => p.variants.length > 0 || p.description);

console.log(`\n=== SUMMARY ===`);
console.log(`Products: ${products.length}`);
console.log(`Materials: ${fabrics.length}`);
console.log(`Total variants: ${products.reduce((a, p) => a + p.variants.length, 0)}`);

console.log(`\n=== PRODUCTS ===`);
for (const p of products) {
  const grades = new Set();
  for (const v of p.variants) for (const g of Object.keys(v.priceByGrade || {})) grades.add(g);
  console.log(
    `  ${p.name.padEnd(36)} ${(p.designer || '—').padEnd(20)} ${String(p.year || '—').padEnd(6)} ` +
    `vars=${String(p.variants.length).padStart(2)} grades=${grades.size} ` +
    `imps=${p.impossibilities.length} pages=[${p.pages.join(',')}]`
  );
}
if (products.length > 60) console.log(`  … and ${products.length - 60} more`);

function dumpProduct(p) {
  if (!p) return;
  console.log(`\n=== ${p.name} DETAIL ===`);
  console.log('designer:', p.designer);
  console.log('year:', p.year);
  console.log('modelCode:', p.modelCode);
  console.log('category:', p.categoryName);
  console.log('impossibilities:', p.impossibilities.join(', '));
  console.log('variants:');
  for (const v of p.variants) {
    console.log(`  - ${v.name.padEnd(45)} ref=${v.reference} yd=${v.yardage}`);
    console.log(`    dim=${v.dimensions}`);
    if (v.priceFixed != null) console.log(`    priceFixed=$${v.priceFixed}`);
    const grades = Object.entries(v.priceByGrade).slice(0, 5).map(([g, q]) => `${g}=${q}`).join(' ');
    if (grades) console.log(`    prices: ${grades} ... (${Object.keys(v.priceByGrade).length} total)`);
  }
}

for (const name of ['ANDY', 'STORE LAYOUT', 'PRADO CADENCE', 'PLOUM', 'EATON', 'EVERYWHERE', 'TODANA - WARDROBE']) {
  dumpProduct(products.find((p) => p.name === name));
}

console.log(`\n=== MATERIALS (first 10) ===`);
for (const m of fabrics.slice(0, 10)) {
  console.log(`  ${m.name.padEnd(22)} ${m.kind.padEnd(12)} grade=${m.grade} wear=${m.wear || '—'} width=${m.width || '—'} $${m.pricePerUnit} colors=${m.colors.length}`);
}
