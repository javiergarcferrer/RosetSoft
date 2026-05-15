// Top-level parsing driver. Walks every page of a Ligne Roset USA price-list
// PDF and emits a normalised in-memory result:
//
//   { families, products, materials, pages, sourceFileName }
//
// `families` and `products` use the same shape the standalone tarif-parser
// produces (slugged family ids, denormalised product rows with a nested
// prices[]). `materials` is the fabricParser output (kept as-is — the
// reference parser doesn't touch materials).
//
// This is the *parse* step. Mapping to the RosetSoft DB schema and the
// actual upload happen in importer.js.

import { openPdf } from './pdfLoader.js';
import { classifyPage } from './lib/pageClassifier.js';
import { extractFamily } from './lib/extractFamily.js';
import { extractProductsFromPage } from './lib/extractProducts.js';
import { slugify } from './lib/textUtils.js';
import { parseMaterialPage } from './fabricParser.js';

// Section dividers in the catalog. When a section-cover banner matches one
// of these, every family/product that follows is tagged with that category.
// Order matches the catalog's table of contents.
export const CATEGORY_HEADERS = [
  'COVER MATERIALS',
  'SEATS',
  'BEDS',
  'LINENS',
  'MATTRESSES AND SLATS',
  'DINING CHAIRS',
  'SWIVELLING DESK CHAIRS',
  'DINING TABLES',
  'LOW TABLES',
  'DECORATIVE ACCESSORIES',
  'TABLEWARE',
  'RUGS',
  'BEDCOVERS AND FURNISHING FABRICS',
  'CABINETRY',
  'COVER MATERIALS - OUTDOOR',
  'SEATS & CHAIRS - OUTDOOR',
  'TABLES - OUTDOOR',
  'LIGHTING - OUTDOOR',
  'DECORATIVE ACCESSORIES - OUTDOOR',
  'RUGS & CUSHIONS - OUTDOOR',
  'CABINETRY TOUCH UP ITEMS & SAMPLES',
  'SAMPLES & ADDITIONAL SALES TOOLS',
];

const SECTION_TO_MATERIAL_KIND = new Map([
  ['COVER MATERIALS', 'fabric'],
  ['COVER MATERIALS - OUTDOOR', 'outdoor-fabric'],
]);

/**
 * Read the raw text items from a pdf.js page. Returns the upright shape used
 * by the new lib/ parsers (y increases upward, `rotated` boolean, `size`).
 */
async function readRawPageItems(pdf, pageNo) {
  const page = await pdf.getPage(pageNo);
  const tc = await page.getTextContent({ includeMarkedContent: false });
  return tc.items;
}

/**
 * Inverted-y shape required by the fabric parser. Built once on demand for
 * cover-material pages — keeps fabricParser.js untouched.
 */
async function readInvertedPageItems(pdf, pageNo) {
  const page = await pdf.getPage(pageNo);
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
    items.push({
      str: it.str,
      x, y,
      w: it.width || 0,
      h: it.height || fontSize,
      fontSize,
      rotation,
      hasEOL: !!it.hasEOL,
    });
  }
  return items;
}

function detectMaterialKind(category, leatherHinted) {
  if (leatherHinted) return 'leather';
  if (!category) return 'fabric';
  return SECTION_TO_MATERIAL_KIND.get(category) || 'fabric';
}

export async function parsePdfDocument(source, { onProgress, sourceFileName } = {}) {
  const pdf = await openPdf(source);
  const total = pdf.numPages;

  const families = [];
  const familyIdSet = new Set();
  const products = [];
  const materials = [];
  const pages = [];

  let currentFamilyKey = null;
  let currentFamilyName = null;
  let currentCategory = null;

  for (let p = 1; p <= total; p++) {
    onProgress?.({ page: p, total, phase: 'parsing' });

    const rawTextItems = await readRawPageItems(pdf, p);
    const cls = classifyPage(rawTextItems);
    pages.push({ page: p, type: cls.type, family: cls.family || null });

    if (cls.type === 'section-cover') {
      // Track category if the cover's banner text matches a known header.
      const name = cls.family;
      if (name) {
        const matched = CATEGORY_HEADERS.find(c => c.toUpperCase() === name.toUpperCase());
        if (matched) currentCategory = matched;
      }
      continue;
    }

    if (cls.type === 'family-intro') {
      const fam = extractFamily(cls.items, p);
      const familyName = fam.name || cls.family;
      if (!familyName) continue;

      const baseId = slugify(familyName);
      // Catalog ships occasional multi-generation families (AMÉDÉE 2017 vs
      // 2020 with different codes). Keep them separate via a suffix.
      const variantKey = fam.code || (fam.year ? String(fam.year) : null);
      let id = baseId;
      const existingSameBase = families.find(f => f.id === baseId);
      if (existingSameBase) {
        const existingVariant = existingSameBase.code || (existingSameBase.year ? String(existingSameBase.year) : null);
        if (variantKey && existingVariant && variantKey !== existingVariant) {
          id = `${baseId}-${slugify(variantKey)}`;
        }
      }

      const entry = {
        id,
        ...fam,
        name: familyName,
        category: currentCategory || null,
      };
      const idx = families.findIndex(f => f.id === id);
      if (idx >= 0) families[idx] = { ...families[idx], ...entry };
      else { families.push(entry); familyIdSet.add(id); }

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
          if (!familyIdSet.has(baseId)) {
            families.push({
              id: baseId, name: familyOnPage,
              designer: null, year: null,
              description: null, important: null,
              technical_impossibilities: null, cover_materials: null,
              code: null, intro_page: null,
              category: currentCategory || null,
            });
            familyIdSet.add(baseId);
          }
        }
      }
      const pageProducts = extractProductsFromPage(cls.items, p, cls.refKind);
      for (const item of pageProducts) {
        item.family_id = currentFamilyKey || null;
        item.family_name = currentFamilyName || null;
        item.category = currentCategory || null;
        products.push(item);
      }
      continue;
    }

    // Cover-materials pages have no `Reference` row in our new classifier;
    // they fall under 'other' but contain a recognisable name/grade/price
    // table. Run the fabric parser when we're inside a known materials
    // section.
    if (currentCategory && SECTION_TO_MATERIAL_KIND.has(currentCategory)) {
      const inverted = await readInvertedPageItems(pdf, p);
      const kind = detectMaterialKind(currentCategory, /* leatherHinted */ false);
      const found = parseMaterialPage(inverted, { kind });
      for (const m of found) materials.push({ ...m, page: p });
    }
  }

  // De-dup products by reference. The catalog repeats a reference on a
  // "Part B"-style continuation page; prefer the entry that captured more
  // prices.
  const byRef = new Map();
  for (const item of products) {
    const existing = byRef.get(item.reference);
    if (!existing || (item.prices?.length || 0) > (existing.prices?.length || 0)) {
      byRef.set(item.reference, item);
    }
  }
  const productsClean = [...byRef.values()].sort((a, b) =>
    (a.family_name || '').localeCompare(b.family_name || '') ||
    a.reference.localeCompare(b.reference)
  );

  // Materials: de-dup by name+kind, merging colors.
  const materialMap = new Map();
  for (const m of materials) {
    const key = (m.name + '|' + m.kind).toUpperCase();
    const prev = materialMap.get(key);
    if (!prev) {
      materialMap.set(key, m);
    } else {
      const seen = new Set(prev.colors.map(c => c.name + '|' + c.code));
      for (const c of m.colors) {
        const k2 = c.name + '|' + c.code;
        if (!seen.has(k2)) {
          prev.colors.push(c);
          seen.add(k2);
        }
      }
      if (!prev.martindale && m.martindale) prev.martindale = m.martindale;
      if (!prev.wear && m.wear) prev.wear = m.wear;
    }
  }

  onProgress?.({ page: total, total, phase: 'parsed' });

  return {
    sourceFileName: sourceFileName || null,
    families,
    products: productsClean,
    materials: [...materialMap.values()],
    pages,
    pdf, // exposed so a follow-up image-extraction pass can render pages without re-opening
  };
}
