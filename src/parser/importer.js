/**
 * State-machine PDF importer.
 *
 * Walks every page in order, classifies it, and dispatches to the
 * appropriate extractor. The state machine carries:
 *
 *   - currentCategory:    last seen section divider name (e.g. "SEATS")
 *   - currentProduct:     last product whose banner we saw
 *                          (continues across multiple pages)
 *   - currentMaterialKind: when in a fabric/leather/outdoor materials section
 *
 * Returns a preview object the UI can review before committing.
 */

import { openPdf } from './pdfLoader.js';
import { readPageItems, groupRows } from './pageReader.js';
import { classifyPage } from './classifier.js';
import {
  extractBanner,
  extractModelCode,
  extractDesigner,
  extractYear,
  extractDescription,
  extractImpossibilities,
  extractVariantTable,
} from './productParser.js';
import { parseMaterialPage } from './fabricParser.js';
import { parseCabinetryPage } from './cabinetryParser.js';
import { renderPdfPage, cropCanvasToBlob } from './pageImage.js';
import { db, newId, saveImage } from '../db/database.js';

const CATEGORY_HEADERS = [
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

export async function importPdf(source, { onProgress, extractImages = true } = {}) {
  const pdf = await openPdf(source);
  const total = pdf.numPages;

  const productsByName = new Map(); // name -> accumulator
  const fabrics = [];

  // State
  let currentCategory = null;
  let currentProductKey = null;
  let currentMaterialKind = null;
  let imageCount = 0;

  for (let p = 1; p <= total; p++) {
    onProgress?.({ page: p, total, stage: 'reading' });
    const page = await readPageItems(pdf, p);
    const cls = classifyPage(page);

    if (cls.type === 'section') {
      const sectionName = cls.sectionName;

      // If this "section" banner is actually the same as the current product,
      // it's a mid-spread page — keep the current product, don't change category.
      if (currentProductKey && sectionName.toUpperCase() === currentProductKey) {
        // Treat as product continuation — record the page on the accumulator
        const acc = productsByName.get(currentProductKey);
        if (acc && !acc.pages.includes(p)) acc.pages.push(p);
        continue;
      }

      // If the section name is in the known CATEGORY_HEADERS, treat as category.
      // Otherwise, only treat as category if name is plausibly a section title
      // (multi-word ALL-CAPS or capital-case heading).
      const matched = CATEGORY_HEADERS.find(
        (c) => c.toUpperCase() === sectionName.toUpperCase()
      );
      if (matched) {
        currentCategory = matched;
      } else if (/\s/.test(sectionName) && sectionName.length > 8) {
        currentCategory = sectionName.toUpperCase();
      } else {
        // Single-word ALL-CAPS like "AVA" — most likely a product banner on a sparse page.
        // Treat as a product instead.
        let acc = productsByName.get(sectionName.toUpperCase());
        if (!acc) {
          acc = {
            name: sectionName,
            designer: '', year: null, description: '', impossibilities: [],
            modelCode: '', variants: [], pages: [],
            categoryName: currentCategory || 'SEATS',
          };
          productsByName.set(sectionName.toUpperCase(), acc);
        }
        currentProductKey = sectionName.toUpperCase();
        if (!acc.pages.includes(p)) acc.pages.push(p);
        continue;
      }
      currentProductKey = null;

      if (/COVER MATERIALS/.test(currentCategory) && !/OUTDOOR/.test(currentCategory)) {
        currentMaterialKind = 'fabric';
      } else if (/OUTDOOR/.test(currentCategory) && /COVER MATERIALS/.test(currentCategory)) {
        currentMaterialKind = 'outdoor-fabric';
      }
      continue;
    }

    if (cls.type === 'fabric-list' || cls.type === 'outdoor-list' || cls.type === 'leather-list') {
      const kind =
        cls.type === 'leather-list' ? 'leather' :
        cls.type === 'outdoor-list' ? 'outdoor-fabric' : 'fabric';
      currentMaterialKind = kind;
      const found = parseMaterialPage(page.items, { kind });
      for (const m of found) fabrics.push({ ...m, page: p });
      continue;
    }

    if (cls.type === 'product' || cls.type === 'cabinetry') {
      const banner = extractBanner(page.items);
      const rows = groupRows(page.items, 2);

      let productKey;
      if (banner && isValidProductName(banner)) {
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
          designer: '',
          year: null,
          description: '',
          impossibilities: [],
          modelCode: '',
          variants: [],
          pages: [],
          categoryName: currentCategory || 'SEATS',
        };
        productsByName.set(productKey, acc);
      }

      if (banner) {
        const designer = extractDesigner(rows);
        const year = extractYear(rows);
        if (designer && !acc.designer) acc.designer = designer;
        if (year && !acc.year) acc.year = year;
        const desc = extractDescription(rows);
        if (desc && !acc.description) acc.description = desc;
        const imp = extractImpossibilities(rows);
        if (imp.length && !acc.impossibilities.length) acc.impossibilities = imp;
        const code = extractModelCode(page.items);
        if (code && !acc.modelCode) acc.modelCode = code;
      }

      let newVariants = [];
      if (cls.type === 'cabinetry') {
        const cVariants = parseCabinetryPage(page.items);
        for (const v of cVariants) {
          const exists = acc.variants.some((x) => x.reference === v.reference);
          if (!exists) { acc.variants.push(v); newVariants.push(v); }
        }
      } else {
        const variantTable = extractVariantTable(page.items);
        if (variantTable?.variants?.length) {
          for (const v of variantTable.variants) {
            const exists = acc.variants.some((x) => (v.reference && x.reference === v.reference) || (!v.reference && x.name === v.name));
            if (!exists) { acc.variants.push(v); newVariants.push(v); }
          }
        }
      }

      // Extract images for this page (hero + per-variant drawings)
      if (extractImages) {
        try {
          onProgress?.({ page: p, total, stage: 'rendering' });
          const imgs = await extractPageImages(pdf, p, page.items, { hasBanner: !!banner, isCabinetry: cls.type === 'cabinetry' });
          if (imgs.hero && !acc.heroBlob) {
            acc.heroBlob = imgs.hero;
            imageCount++;
          }
          // Match variant images by reference code, falling back to position
          for (const vimg of imgs.variantImages) {
            const match = acc.variants.find(
              (x) => vimg.reference && x.reference === vimg.reference && !x.imageBlob
            );
            if (match && vimg.blob) {
              match.imageBlob = vimg.blob;
              imageCount++;
            }
          }
        } catch (e) {
          console.warn(`Image extraction failed on page ${p}:`, e?.message || e);
        }
      }

      if (!acc.pages.includes(p)) acc.pages.push(p);
      continue;
    }

    // 'toc', 'cover', 'unknown' → skip
  }

  // Materials: dedup by name + kind, merge colors
  const fabricMap = new Map();
  for (const f of fabrics) {
    const key = (f.name + '|' + f.kind).toUpperCase();
    if (!fabricMap.has(key)) {
      fabricMap.set(key, f);
    } else {
      const prev = fabricMap.get(key);
      const seen = new Set(prev.colors.map((c) => c.name + '|' + c.code));
      for (const c of f.colors) {
        const k2 = c.name + '|' + c.code;
        if (!seen.has(k2)) {
          prev.colors.push(c);
          seen.add(k2);
        }
      }
      if (!prev.martindale && f.martindale) prev.martindale = f.martindale;
      if (!prev.wear && f.wear) prev.wear = f.wear;
    }
  }

  onProgress?.({ page: total, total, stage: 'done' });

  const products = [...productsByName.values()]
    .filter((p) => p.variants.length > 0 || p.description)
    .map((p) => ({ ...p, variantCount: p.variants.length }));

  return {
    fabrics: [...fabricMap.values()],
    products,
    imageCount,
  };
}

/**
 * Extract hero (whole-product) and per-variant drawings from a page.
 *
 * Layout assumptions (PDF user-space units, page 595 × 841):
 *   - Description page: drawing in the upper-middle area of the page,
 *     roughly x=20..575, y=50..460 (between the header strip and the
 *     "Description"/"Important" text block).
 *   - Pricing page: each variant column has its drawing above the
 *     "Name" header row. We crop the full top strip per column.
 *   - Cabinetry: drawing alongside each row's reference code.
 *
 * We render once, then crop. The blank-detector only rejects regions
 * that are *literally* all white.
 */
async function extractPageImages(pdf, pageNum, items, { hasBanner, isCabinetry }) {
  const rows = groupRows(items, 2);
  const nameRow = rows.find((r) => r.items.some((it) => it.x < 130 && /^Name$/i.test(it.str.trim())));
  const refRow = rows.find((r) => r.items.some((it) => it.x < 130 && /^Reference$/i.test(it.str.trim())));
  const importantRow = rows.find((r) => r.items.some((it) => it.x < 80 && /^Important$/i.test(it.str.trim())));

  if (!hasBanner && !nameRow && !isCabinetry) return { hero: null, variantImages: [] };

  const { canvas, scale } = await renderPdfPage(pdf, pageNum, 2.0);
  const result = { hero: null, variantImages: [] };

  // Hero crop: description-style page (banner + no variant table)
  if (hasBanner && !nameRow) {
    // The drawing sits between the page top and the "Important" label
    // (or, if Important is missing, between top and y=460).
    const heroBottom = importantRow ? importantRow.y - 10 : 460;
    const hero = await cropCanvasToBlob(
      canvas,
      { x: 20, y: 50, w: 555, h: Math.max(120, heroBottom - 50) },
      scale,
      { maxBlankPct: 0.999 }
    );
    if (hero) result.hero = hero;
  }

  // Pricing page: variant drawings above each column
  if (nameRow && !isCabinetry) {
    const refCells = refRow?.items
      ?.filter((it) => it.x > 130 && /^\d{6,10}$/.test(it.str.trim()))
      ?.sort((a, b) => a.x - b.x) || [];
    const anchors = refCells.map((r) => r.x);

    if (anchors.length) {
      for (let i = 0; i < anchors.length; i++) {
        const xMin = Math.max(0, anchors[i] - 18);
        const xMax = i < anchors.length - 1 ? anchors[i + 1] - 14 : Math.min(580, anchors[i] + 110);
        const w = xMax - xMin;
        const h = Math.max(40, nameRow.y - 4);
        const blob = await cropCanvasToBlob(canvas, { x: xMin, y: 2, w, h }, scale, { maxBlankPct: 0.999 });
        result.variantImages.push({ reference: refCells[i].str.trim(), blob });
      }
    }
  }

  // Cabinetry: a drawing typically sits next to each row's item description.
  // Different cabinetry layouts have refs at different x ranges, so search broadly.
  if (isCabinetry) {
    const upright = items.filter((it) => it.rotation === 0);
    const cabRows = groupRows(upright, 1.2);
    for (const row of cabRows) {
      const refItem = row.items.find(
        (it) => it.x > 150 && /^[A-Z0-9]{6,12}$/.test(it.str.trim()) && /[A-Z]/.test(it.str)
      ) || row.items.find(
        (it) => it.x > 150 && /^\d{6,10}$/.test(it.str.trim())
      );
      if (!refItem) continue;
      // Drawing usually to the left of the item label, in the Name column area
      const blob = await cropCanvasToBlob(canvas, { x: 30, y: row.y - 22, w: 130, h: 50 }, scale, { maxBlankPct: 0.999 });
      if (blob) result.variantImages.push({ reference: refItem.str.trim(), blob });
    }
  }

  return result;
}

function isValidProductName(s) {
  const t = (s || '').trim();
  if (!t) return false;
  if (t.length < 2 || t.length > 50) return false;
  if (/^[A-Z][A-Z0-9 &'’.\-/]+$/.test(t)) return true; // ALL-CAPS-ish
  if (/^[A-Z][a-zA-Z ]+$/.test(t)) return true; // proper-cased like "Cabinetry touch up items & samples"
  return false;
}

/* ------------------------------------------------------------------ */
/*  Commit                                                             */
/* ------------------------------------------------------------------ */

export async function commitImport(preview, { merge = true } = {}) {
  const counts = { categories: 0, materials: 0, colors: 0, products: 0, variants: 0, images: 0 };

  async function saveImageBlob(kind, ownerId, blob) {
    if (!blob) return null;
    const id = await saveImage({ kind, ownerId, file: blob });
    counts.images++;
    return id;
  }

  const categoryIdByName = new Map();
  const existingCats = await db.categories.toArray();
  for (const c of existingCats) categoryIdByName.set(c.name.toUpperCase(), c.id);

  const neededCategories = new Set(preview.products.map((p) => p.categoryName).filter(Boolean));
  for (const name of neededCategories) {
    if (categoryIdByName.has(name.toUpperCase())) continue;
    const id = newId();
    const idx = CATEGORY_HEADERS.indexOf(name);
    await db.categories.put({ id, name, sortOrder: idx >= 0 ? idx : 999 });
    categoryIdByName.set(name.toUpperCase(), id);
    counts.categories++;
  }

  for (const m of preview.fabrics) {
    let existing = null;
    if (merge) {
      const matches = await db.materials.where('name').equals(m.name).toArray();
      existing = matches.find((x) => x.kind === m.kind);
    }
    const id = existing?.id || newId();
    await db.materials.put({
      id,
      kind: m.kind,
      name: m.name,
      grade: m.grade || null,
      wear: m.wear || null,
      martindale: m.martindale || null,
      width: m.width || null,
      pricePerUnit: m.pricePerUnit ?? null,
      composition: m.composition || '',
      notes: (m.notes || []).join(' ').slice(0, 800),
      restrictedToProductNames: [],
    });
    if (!existing) counts.materials++;

    const existingColors = await db.materialColors.where('materialId').equals(id).toArray();
    const seen = new Set(existingColors.map((c) => (c.name + '|' + c.code).toUpperCase()));
    for (const col of m.colors) {
      const key = (col.name + '|' + col.code).toUpperCase();
      if (seen.has(key)) continue;
      const cid = newId();
      await db.materialColors.put({ id: cid, materialId: id, name: col.name, code: col.code, swatchImageId: null });
      counts.colors++;
    }
  }

  for (const p of preview.products) {
    let existing = null;
    if (merge) {
      const list = await db.products.where('name').equals(p.name).toArray();
      existing = list[0];
    }
    const productId = existing?.id || newId();
    const categoryId = categoryIdByName.get((p.categoryName || '').toUpperCase()) || null;

    // Save hero image if we extracted one and the product doesn't already have one
    let heroImageId = existing?.heroImageId || null;
    if (p.heroBlob && !heroImageId) {
      heroImageId = await saveImageBlob('product-hero', productId, p.heroBlob);
    }

    await db.products.put({
      id: productId,
      name: p.name,
      categoryId,
      designer: p.designer || existing?.designer || '',
      year: p.year || existing?.year || null,
      description: p.description || existing?.description || '',
      modelCode: p.modelCode || existing?.modelCode || '',
      technicalImpossibilities: p.impossibilities?.length ? p.impossibilities : (existing?.technicalImpossibilities || []),
      heroImageId,
      pages: p.pages || [],
    });
    if (!existing) counts.products++;

    const existingVariants = await db.productVariants.where('productId').equals(productId).toArray();
    const byKey = new Map(existingVariants.map((v) => [v.reference || v.name, v]));
    let order = 0;
    for (const v of p.variants) {
      const k = v.reference || v.name;
      const prev = byKey.get(k);
      const vid = prev?.id || newId();

      // Save variant image if we extracted one and there isn't one already
      let imageId = prev?.imageId || null;
      if (v.imageBlob && !imageId) {
        imageId = await saveImageBlob('variant', vid, v.imageBlob);
      }

      await db.productVariants.put({
        id: vid,
        productId,
        name: v.name,
        reference: v.reference || '',
        yardage: v.yardage || '',
        dimensions: v.dimensions || '',
        priceByGrade: v.priceByGrade || {},
        priceFixed: v.priceFixed ?? prev?.priceFixed ?? null,
        sortOrder: prev?.sortOrder ?? order,
        imageId,
      });
      if (!prev) counts.variants++;
      order++;
    }
  }

  return counts;
}
