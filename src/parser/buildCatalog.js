// Orchestrator: take a PDF File/Blob, parse it via PDF.js, and emit the same
// JSON shape the Python parser does (so `src/lib/catalogImport.js` can ingest
// it without changes).
//
// This is the JS port of `build_catalog.py:main()`. Phases:
//
//   1. Open PDF.
//   2. Read built-in ToC + printed index → categories + products with page
//      ranges.
//   3. For each product:
//        a. Pull first-page meta (designer, year, code, description, …).
//        b. Harvest 8-char references across its page range.
//        c. Walk each page in its range, dispatch on SECTION_STRUCTURE to one
//           of the four parsers (grade / row / cabinetry / cover), emit
//           variants.
//   4. Pull cover materials (fabric / leather / outdoor) for the COVER
//      MATERIALS sections.
//   5. Final variant_name cleanup, then return the JSON-shaped object.
//
// Image extraction is intentionally not included here — it'd add a heavy
// rendering pass that doubles the parse time, and the downstream Supabase
// upload skips images anyway. Add it in a separate pass when needed.

import { openPdf } from './lib/pdfSetup.js';
import { readPageSpans } from './lib/readSpans.js';
import { loadCategoriesAndProducts } from './lib/readToc.js';
import { harvestRefs, REF_FULLMATCH } from './lib/refs.js';
import { extractFirstPageMeta } from './lib/firstPageMeta.js';
import {
  detectGradeTable,
  parseGradeTablePage,
} from './lib/parseGradeTable.js';
import { parseColorTablePage } from './lib/parseColorTable.js';
import { parseCabinetryPage } from './lib/parseCabinetry.js';
import { parseCoverMaterialsPage } from './lib/parseCoverMaterials.js';

const SECTION_STRUCTURE = {
  'COVER MATERIALS': 'cover',
  'COVER MATERIALS - OUTDOOR': 'cover',
  'Samples & additional sales tools': 'row',
  'Cabinetry touch up items & samples': 'row',
  SEATS: 'grade',
  BEDS: 'grade',
  LINENS: 'row',
  'MATTRESSES AND SLATS': 'row',
  'DINING CHAIRS': 'hybrid',
  'SWIVELLING DESK CHAIRS': 'grade',
  'DINING TABLES': 'row',
  'LOW TABLES': 'row',
  'OTHER OCCASIONAL ITEMS': 'row',
  'ADDITIONAL ACCESSORIES': 'row',
  DESKS: 'row',
  LIGHTING: 'row',
  'DECORATIVE ACCESSORIES': 'row',
  TABLEWARE: 'row',
  RUGS: 'row',
  'BEDCOVERS AND FURNISHING FABRICS': 'row',
  CABINETRY: 'cabinetry',
  'SEATS & CHAIRS - OUTDOOR': 'hybrid',
  'TABLES - OUTDOOR': 'row',
  'LIGHTING - OUTDOOR': 'row',
  'DECORATIVE ACCESSORIES - OUTDOOR': 'row',
  'RUGS & CUSHIONS - OUTDOOR': 'row',
};

const WARN_LIMIT = 500;

/**
 * Parse a PDF into the same shape `out/catalog.json` has.
 *
 * `onProgress({ phase, page, total, label })` is called as parsing advances.
 * Phases: 'toc', 'cover-materials', 'products', 'done'.
 */
export async function buildCatalogFromPdf(source, { onProgress, sourceName } = {}) {
  const report = (info) => onProgress?.(info);
  const warnings = [];
  function warn(msg) {
    if (warnings.length < WARN_LIMIT) warnings.push(msg);
  }

  report({ phase: 'toc', page: 0, total: 0, label: 'Leyendo índice' });
  const doc = await openPdf(source);

  const { categories, products } = await loadCategoriesAndProducts(doc);

  // --- cover materials -----------------------------------------------------
  // Walk each cover-materials section's page range, parse all pages.
  let coverMaterials = { fabric: [], leather: [], 'outdoor-fabric': [] };
  let coverIdNext = 1;
  const catByName = new Map(categories.map((c) => [c.name, c]));
  async function parseCoverSection(catName, defaultKind) {
    const cat = catByName.get(catName);
    if (!cat) return;
    // For "COVER MATERIALS" the children specify the kind (FABRICS / LEATHER);
    // for "COVER MATERIALS - OUTDOOR" the whole category is outdoor-fabric.
    const catProducts = products.filter((p) => p.category_id === cat.id);
    if (defaultKind === 'outdoor-fabric') {
      for (let pno = cat.page_start; pno <= Math.min(cat.page_end, doc.numPages); pno++) {
        const page = await doc.getPage(pno);
        const { spans } = await readPageSpans(page);
        const found = parseCoverMaterialsPage(spans, { kind: 'outdoor-fabric', startId: coverIdNext });
        coverIdNext += found.length;
        coverMaterials['outdoor-fabric'].push(...found);
        report({ phase: 'cover-materials', page: pno, total: doc.numPages, label: 'Materiales — outdoor' });
      }
      return;
    }
    // Indoor: dispatch by sub-product name.
    for (const p of catProducts) {
      const upper = (p.name || '').toUpperCase();
      let kind = null;
      if (upper.startsWith('FABRIC')) kind = 'fabric';
      else if (upper.startsWith('LEATHER')) kind = 'leather';
      if (!kind) continue;
      for (let pno = p.page_start; pno <= Math.min(p.page_end, doc.numPages); pno++) {
        const page = await doc.getPage(pno);
        const { spans } = await readPageSpans(page);
        const found = parseCoverMaterialsPage(spans, { kind, startId: coverIdNext });
        coverIdNext += found.length;
        coverMaterials[kind].push(...found);
        report({ phase: 'cover-materials', page: pno, total: doc.numPages, label: `Materiales — ${kind}` });
      }
    }
  }
  try { await parseCoverSection('COVER MATERIALS', 'fabric'); } catch (e) { warn(`cover-materials indoor: ${e.message || e}`); }
  try { await parseCoverSection('COVER MATERIALS - OUTDOOR', 'outdoor-fabric'); } catch (e) { warn(`cover-materials outdoor: ${e.message || e}`); }

  // --- per-product walk ----------------------------------------------------
  const variants = [];
  let productIdx = 0;
  for (const p of products) {
    productIdx++;
    report({
      phase: 'products',
      page: productIdx,
      total: products.length,
      label: `${p.name} (${p.page_start}-${p.page_end})`,
    });

    // Skip the cover-materials child products — they're handled above.
    const catName = catByName.get(categories.find((c) => c.id === p.category_id)?.name)?.name;
    const structure = SECTION_STRUCTURE[catName] || 'row';
    if (structure === 'cover') continue;

    // First-page meta.
    try {
      const firstPage = await doc.getPage(p.page_start);
      const { spans } = await readPageSpans(firstPage);
      const meta = extractFirstPageMeta(spans, { pageNumber: p.page_start, productName: p.name_raw });
      for (const [k, v] of Object.entries(meta)) {
        if (Object.prototype.hasOwnProperty.call(p, k)) p[k] = v;
      }
    } catch (e) {
      warn(`meta-extract failed for ${p.name} p.${p.page_start}: ${e.message || e}`);
    }

    // References across the whole spread.
    try {
      p.references = await harvestRefs(doc, p);
    } catch (e) {
      warn(`ref harvest failed for ${p.name}: ${e.message || e}`);
    }

    // Per-page variant tables.
    for (let pno = p.page_start; pno <= Math.min(p.page_end, doc.numPages); pno++) {
      try {
        const page = await doc.getPage(pno);
        const { spans } = await readPageSpans(page);
        let vs = [];
        if (structure === 'grade') {
          if (detectGradeTable(spans)) vs = parseGradeTablePage(spans, p, pno);
          if (!vs.length) vs = parseColorTablePage(spans, p, pno, { productCode: p.code });
        } else if (structure === 'hybrid') {
          if (detectGradeTable(spans)) vs = parseGradeTablePage(spans, p, pno);
          if (!vs.length) vs = parseColorTablePage(spans, p, pno, { productCode: p.code });
        } else if (structure === 'cabinetry') {
          vs = parseCabinetryPage(spans, p, pno);
          if (!vs.length) vs = parseColorTablePage(spans, p, pno, { productCode: p.code });
        } else {
          vs = parseColorTablePage(spans, p, pno, { productCode: p.code });
        }
        variants.push(...vs);
        if (structure === 'grade' && detectGradeTable(spans) && !vs.length) {
          warn(`grade-table parsed 0 variants on p.${pno} for ${p.name}`);
        }
      } catch (e) {
        warn(`variant parse failed for ${p.name} p.${pno}: ${e.message || e}`);
      }
    }
  }

  // Final cleanup: when variant_name accidentally equals reference_code, null it.
  for (const v of variants) {
    if (v.variant_name && v.reference_code && v.variant_name === v.reference_code) {
      v.variant_name = null;
    }
  }

  // Strip internal _row_y from JSON output (still present on dicts during the
  // upload-phase dedupe, but the JSON we emit matches the Python catalog).
  const variantsClean = variants.map((v) => {
    // eslint-disable-next-line no-unused-vars
    const { _row_y, ...rest } = v;
    // Preserve _row_y as a public property too — the importer's optional
    // image phase reads it to anchor row-aligned thumbnails. The Python
    // pipeline doesn't surface this in JSON; we add it here without
    // breaking the rest of the schema.
    if (_row_y != null) rest._row_y = _row_y;
    return rest;
  });

  // Shape JSON like out/catalog.json.
  const json = {
    source_pdf: sourceName || (source && source.name) || null,
    pages: doc.numPages,
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      page_start: c.page_start,
      page_end: c.page_end,
    })),
    products: products.map((p) => ({
      id: p.id,
      category_id: p.category_id,
      name_raw: p.name_raw,
      name: p.name,
      slug: p.slug,
      page_start: p.page_start,
      page_end: p.page_end,
      designer: p.designer,
      year: p.year,
      code: p.code,
      important: p.important,
      description: p.description,
      technical_notes: p.technical_notes,
      compatible_materials: p.compatible_materials,
      references: p.references,
    })),
    cover_materials: {
      fabrics: coverMaterials.fabric,
      leathers: coverMaterials.leather,
      outdoor_fabrics: coverMaterials['outdoor-fabric'],
    },
    variants: variantsClean,
  };

  report({ phase: 'done', page: doc.numPages, total: doc.numPages, label: 'Listo' });
  // Expose the live pdf.js document so an optional second pass can render
  // page regions (product hero images) without re-opening the file.
  return { json, warnings, pdf: doc };
}
