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
import { normalizeKey } from '../lib/normalizeKey.js';

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

      // Extract images for this page (hero + per-variant drawings).
      // PDF render is single-threaded CPU work on the main thread — yield
      // to the event loop after each render so the progress bar redraws
      // and the tab doesn't feel frozen.
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
          // Yield to the browser so the UI can repaint between renders.
          await new Promise((r) => setTimeout(r, 0));
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

  // Render at a moderate scale — every crop is downscaled to <= 800px on
  // the longest edge by cropCanvasToBlob anyway. Halving the scale (2.0 → 1.25)
  // ~halves render time, which is the single biggest contributor to
  // perceived import latency. See pageImage.js header comment.
  const { canvas, scale } = await renderPdfPage(pdf, pageNum, 1.25);
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

// Concurrency for the upload worker pool. Was raised 5 → 10 in b93c523 on
// the assumption that storage uploads were the wall, but the real wall is
// the synchronous PDF-page render in the preview phase + per-product DB
// round-trips in the commit phase (both of which this file now addresses).
// 10 simultaneous PUTs over a residential cellular link don't speed
// anything up — the link is the bottleneck — and they do create contention
// with whatever else the tab is doing (XHR queue, fetch backpressure).
// 6 is empirically a good middle for HTTP/2 single-origin throughput.
export async function commitImport(preview, { merge = true, onProgress, uploadConcurrency = 6 } = {}) {
  const counts = { categories: 0, materials: 0, colors: 0, products: 0, variants: 0, images: 0 };

  // Pre-count uploads so we can show "X / N" progress.
  let totalUploads = 0;
  for (const p of preview.products) {
    if (p.heroBlob) totalUploads++;
    for (const v of p.variants) if (v.imageBlob) totalUploads++;
  }
  let uploadsDone = 0;
  const reportUpload = () => {
    uploadsDone++;
    onProgress?.({ phase: 'uploading', done: uploadsDone, total: totalUploads });
  };
  onProgress?.({ phase: 'starting', done: 0, total: totalUploads });

  async function saveImageBlob(kind, ownerId, blob) {
    if (!blob) return null;
    const id = await saveImage({ kind, ownerId, file: blob });
    counts.images++;
    reportUpload();
    return id;
  }

  // Run N image uploads in parallel; await all before continuing.
  // See the comment on commitImport's uploadConcurrency default for why
  // this is bounded at a modest number rather than maxed out.
  async function runParallel(tasks, limit = uploadConcurrency) {
    const results = new Array(tasks.length);
    let i = 0;
    async function worker() {
      while (i < tasks.length) {
        const idx = i++;
        results[idx] = await tasks[idx]();
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return results;
  }

  const categoryIdByName = new Map();
  const existingCats = await db.categories.toArray();
  for (const c of existingCats) categoryIdByName.set(c.name.toUpperCase(), c.id);

  // Reference numbers must be globally unique across the catalog. Build a
  // lookup of every existing variant keyed by its reference once, then
  // re-use it inside the per-product loop so an incoming variant with a
  // reference that already exists ANYWHERE — even on a different product —
  // updates the existing row in place (and gets moved to the new product
  // if needed) instead of creating a duplicate.
  const allExistingVariants = await db.productVariants.toArray();
  const variantByRef = new Map();
  for (const v of allExistingVariants) {
    const key = normalizeKey(v.reference, 'ref');
    if (key) variantByRef.set(key, v);
  }

  const neededCategories = new Set(preview.products.map((p) => p.categoryName).filter(Boolean));
  for (const name of neededCategories) {
    if (categoryIdByName.has(name.toUpperCase())) continue;
    const id = newId();
    const idx = CATEGORY_HEADERS.indexOf(name);
    await db.categories.put({ id, name, sortOrder: idx >= 0 ? idx : 999 });
    categoryIdByName.set(name.toUpperCase(), id);
    counts.categories++;
  }

  // Pre-fetch ALL existing materials and material colors in two requests
  // instead of N+M round-trips inside the loop. Same rationale as the
  // products block below.
  const allExistingMaterials = merge ? await db.materials.toArray() : [];
  // Case-sensitive name keys — matches the historical behavior of
  // `db.materials.where('name').equals(m.name)`.
  const materialByNameKind = new Map();
  for (const r of allExistingMaterials) {
    if (r.name != null) materialByNameKind.set(r.name + '|' + r.kind, r);
  }
  const allExistingColors = merge ? await db.materialColors.toArray() : [];
  const colorsByMaterialId = new Map();
  for (const c of allExistingColors) {
    const arr = colorsByMaterialId.get(c.materialId) || [];
    arr.push(c);
    colorsByMaterialId.set(c.materialId, arr);
  }

  for (const m of preview.fabrics) {
    const existing = merge ? materialByNameKind.get(m.name + '|' + m.kind) || null : null;
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

    const existingColors = colorsByMaterialId.get(id) || [];
    const seen = new Set(existingColors.map((c) => (c.name + '|' + c.code).toUpperCase()));
    for (const col of m.colors) {
      const key = (col.name + '|' + col.code).toUpperCase();
      if (seen.has(key)) continue;
      const cid = newId();
      await db.materialColors.put({ id: cid, materialId: id, name: col.name, code: col.code, swatchImageId: null });
      counts.colors++;
    }
  }

  // ------------------------------------------------------------------
  //  Phase 1: plan every product + variant. We resolve existing rows,
  //  pre-assign new ids, and collect a single flat list of upload tasks
  //  across ALL products.
  //
  //  Critical perf detail: previously this loop did
  //    `await db.products.where('name').equals(p.name).toArray()` and
  //    `await db.productVariants.where('productId').equals(productId).toArray()`
  //  per product. With ~50 products that's ~100 sequential Supabase
  //  round-trips before the first upload could even start — invisible to
  //  the user (no progress UI for it) and on cellular it dominated the
  //  "starting…" wait. We already fetch `productVariants` in full above
  //  to build `variantByRef`, so we can reuse those rows and bulk-fetch
  //  `products` once too — turning N+M HTTP requests into 0 inside the
  //  loop.
  // ------------------------------------------------------------------
  onProgress?.({ phase: 'planning', done: 0, total: totalUploads });
  const allExistingProducts = merge ? await db.products.toArray() : [];
  // Use exact-name keys — matches the historical behavior of
  // `db.products.where('name').equals(p.name)` (case-sensitive).
  const productByName = new Map();
  for (const r of allExistingProducts) {
    if (r.name != null) productByName.set(r.name, r);
  }
  // Group already-loaded variant rows by productId so per-product lookups
  // are pure in-memory work.
  const variantsByProductId = new Map();
  for (const v of allExistingVariants) {
    const arr = variantsByProductId.get(v.productId) || [];
    arr.push(v);
    variantsByProductId.set(v.productId, arr);
  }

  const productPlans = [];
  const allUploadTasks = [];

  for (const p of preview.products) {
    const existing = merge ? productByName.get(p.name) || null : null;
    const productId = existing?.id || newId();
    const categoryId = categoryIdByName.get((p.categoryName || '').toUpperCase()) || null;

    const existingVariants = variantsByProductId.get(productId) || [];
    const byKey = new Map(existingVariants.map((v) => [v.reference || v.name, v]));

    // Plan variants. Reference takes precedence over name. A reference that
    // matches an existing variant anywhere in the catalog updates that row
    // in place (and re-parents it to the current product if needed);
    // otherwise we fall back to a name match within the current product,
    // matching the historical behavior for reference-less variants.
    //
    // We also reserve the ref → vid mapping in the global lookup at plan
    // time (not at DB-write time) so two products in the same import that
    // share a reference dedupe against each other — preserving the
    // original behavior, which used to happen via the per-product write
    // loop updating the same map.
    const variantPlans = p.variants.map((v) => {
      const refKey = normalizeKey(v.reference, 'ref');
      const globalMatch = refKey ? variantByRef.get(refKey) : null;
      const prev = globalMatch || byKey.get(v.reference || v.name);
      const vid = prev?.id || newId();
      if (refKey) variantByRef.set(refKey, { id: vid, reference: v.reference || '' });
      return { v, prev, vid };
    });

    // Plan the hero (vector) image — only upload if there's no existing one.
    // The customer-facing `heroImageId` stays untouched — it's uploaded
    // manually and only appears in the exported PDF.
    const plan = {
      p, existing, productId, categoryId, variantPlans,
      vectorImageId: existing?.vectorImageId || null,
    };
    if (p.heroBlob && !plan.vectorImageId) {
      allUploadTasks.push(async () => {
        plan.vectorImageId = await saveImageBlob('product-vector', productId, p.heroBlob);
      });
    }
    for (const pl of variantPlans) {
      if (pl.v.imageBlob && !pl.prev?.imageId) {
        allUploadTasks.push(async () => {
          pl.imageId = await saveImageBlob('variant', pl.vid, pl.v.imageBlob);
        });
      }
    }
    productPlans.push(plan);
  }

  // Phase 2: fire ALL image uploads through a single shared worker pool.
  await runParallel(allUploadTasks);

  // Phase 3: write the per-product DB rows now that every upload id is
  // resolved. Build a flat task list of all product+variant puts and run
  // them through the same worker pool so the rows across products don't
  // wait on each other.
  onProgress?.({ phase: 'writing', done: 0, total: totalUploads });
  const writeTasks = [];
  for (const plan of productPlans) {
    const { p, existing, productId, categoryId, variantPlans, vectorImageId } = plan;

    writeTasks.push(() => db.products.put({
      id: productId,
      name: p.name,
      categoryId,
      designer: p.designer || existing?.designer || '',
      year: p.year || existing?.year || null,
      description: p.description || existing?.description || '',
      modelCode: p.modelCode || existing?.modelCode || '',
      technicalImpossibilities: p.impossibilities?.length ? p.impossibilities : (existing?.technicalImpossibilities || []),
      heroImageId: existing?.heroImageId || null,
      vectorImageId,
      pages: p.pages || [],
    }));
    if (!existing) counts.products++;

    let order = 0;
    for (const pl of variantPlans) {
      const imageId = pl.imageId ?? pl.prev?.imageId ?? null;
      const record = {
        id: pl.vid,
        productId,
        name: pl.v.name,
        reference: pl.v.reference || '',
        yardage: pl.v.yardage || '',
        dimensions: pl.v.dimensions || '',
        priceByGrade: pl.v.priceByGrade || {},
        priceFixed: pl.v.priceFixed ?? pl.prev?.priceFixed ?? null,
        sortOrder: pl.prev?.sortOrder ?? order,
        imageId,
      };
      writeTasks.push(() => db.productVariants.put(record));
      if (!pl.prev) counts.variants++;
      order++;
    }
  }
  await runParallel(writeTasks);

  onProgress?.({ phase: 'done', done: uploadsDone, total: totalUploads });

  return counts;
}
