/**
 * Catalog-JSON importer.
 *
 * Replaces the in-browser PDF parser. The parser is now an offline Node CLI
 * (`tarif-parser/`) that emits `out/catalog.json` and `out/images/*.jpg`.
 * This module accepts the JSON plus a Map<filename, Blob> built from a
 * user-uploaded image folder, builds the same preview shape the UI used
 * before, and writes it to Supabase with the same merge / upsert behavior
 * the legacy importer.js had.
 */

import { db, newId, uploadImageOnly } from '../db/database.js';
import { normalizeKey } from './normalizeKey.js';

// Order used to assign sortOrder when we encounter a new category for the
// first time. Anything not in this list lands at the end (sortOrder 999).
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

/* ---------------------------------------------------------------------- */
/*  Preview                                                                */
/* ---------------------------------------------------------------------- */

/**
 * Convert a catalog.json (validated against CatalogSchema in tarif-parser)
 * plus an imageBlobs Map<relativePath, Blob> into the preview shape the
 * Import page renders. Image paths are looked up in the map; missing
 * images degrade silently to null blobs (the commit step skips them).
 *
 * The relative paths in catalog.json look like `images/<id>.jpg`. The
 * map must use the SAME keys — the Import page is responsible for
 * stripping the upload-root prefix when it builds the map from a folder.
 */
export function buildPreview(catalog, imageBlobs) {
  if (!catalog || typeof catalog !== 'object') {
    throw new Error('catalog.json is empty or malformed');
  }
  if (!Array.isArray(catalog.products) || !Array.isArray(catalog.materials)) {
    throw new Error('catalog.json missing products[] or materials[]');
  }
  const blobs = imageBlobs instanceof Map ? imageBlobs : new Map();

  // Track image hits so the Import page can show a "matched / expected"
  // counter and warn when the user dropped the wrong folder.
  let imageCount = 0;
  let expectedImages = 0;
  const lookup = (path) => {
    if (!path) return null;
    expectedImages += 1;
    const b = blobs.get(path) || blobs.get(path.replace(/^images\//, '')) || null;
    if (b) imageCount += 1;
    return b;
  };

  const fabrics = catalog.materials.map((m) => ({
    kind: m.kind,
    name: m.name,
    grade: m.grade || null,
    composition: m.composition || '',
    width: m.width || null,
    wear: m.wear || null,
    martindale: m.martindale || null,
    pricePerUnit: m.pricePerUnit ?? null,
    notes: [],
    colors: (m.colors || []).map((c) => ({
      name: c.name,
      code: c.code,
      swatchBlob: lookup(c.swatchFile),
    })),
  }));

  const products = catalog.products.map((p) => {
    const variants = (p.variants || []).map((v) => ({
      name: v.name,
      reference: v.reference || '',
      dimensions: v.dimensions || '',
      yardage: v.yardage || '',
      priceByGrade: v.priceByGrade || {},
      priceFixed: v.priceFixed ?? null,
      imageBlob: lookup(v.imageFile),
    }));
    return {
      name: p.name,
      categoryName: p.categoryName || null,
      designer: p.designer || '',
      year: p.year ?? null,
      description: p.description || '',
      impossibilities: p.impossibilities || [],
      modelCode: p.modelCode || '',
      pages: p.pages || [],
      heroBlob: lookup(p.heroImageFile),
      variants,
      variantCount: variants.length,
    };
  });

  return { fabrics, products, imageCount, expectedImages };
}

/* ---------------------------------------------------------------------- */
/*  Commit                                                                 */
/* ---------------------------------------------------------------------- */

// Concurrency for the upload worker pool — 6 simultaneous PUTs is a good
// middle for HTTP/2 single-origin throughput. Higher numbers create
// contention with whatever else the tab is doing without speeding the link
// up on residential connections.
export async function commitCatalog(preview, {
  merge = true,
  onProgress,
  uploadConcurrency = 6,
} = {}) {
  const counts = { categories: 0, materials: 0, colors: 0, products: 0, variants: 0, images: 0 };

  // Pre-count uploads so we can show "X / N" progress.
  let totalUploads = 0;
  for (const p of preview.products) {
    if (p.heroBlob) totalUploads++;
    for (const v of p.variants) if (v.imageBlob) totalUploads++;
  }
  for (const m of preview.fabrics) {
    for (const c of m.colors) if (c.swatchBlob) totalUploads++;
  }
  let uploadsDone = 0;
  const reportUpload = () => {
    uploadsDone++;
    onProgress?.({ phase: 'uploading', done: uploadsDone, total: totalUploads });
  };
  onProgress?.({ phase: 'starting', done: 0, total: totalUploads });

  // Collected `images` table rows for ALL uploads in this import. We upload
  // to Storage in parallel (network-bound) but stash the row metadata here
  // instead of `db.images.put`-ing each one — those per-image inserts were
  // exhausting the Supabase connection pool on large catalogs. One bulkPut
  // at the end of the upload phase replaces N round-trips.
  const pendingImageRows = [];
  async function saveImageBlob(kind, ownerId, blob) {
    if (!blob) return null;
    const row = await uploadImageOnly({ kind, ownerId, file: blob });
    pendingImageRows.push(row);
    counts.images++;
    reportUpload();
    return row.id;
  }

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

  /* ----- Categories ---- */
  const categoryIdByName = new Map();
  const existingCats = await db.categories.toArray();
  for (const c of existingCats) categoryIdByName.set(c.name.toUpperCase(), c.id);

  const neededCategories = new Set(preview.products.map((p) => p.categoryName).filter(Boolean));
  const newCategoryRecords = [];
  for (const name of neededCategories) {
    if (categoryIdByName.has(name.toUpperCase())) continue;
    const id = newId();
    const idx = CATEGORY_HEADERS.indexOf(name);
    newCategoryRecords.push({ id, name, sortOrder: idx >= 0 ? idx : 999 });
    categoryIdByName.set(name.toUpperCase(), id);
    counts.categories++;
  }
  if (newCategoryRecords.length) await db.categories.bulkPut(newCategoryRecords);

  /* ----- Variants pre-fetch (used in planning) ---- */
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

  /* ----- Materials + colors ---- */
  // Pre-fetch ALL existing materials and material colors in two requests
  // instead of N+M round-trips inside the loop.
  const allExistingMaterials = merge ? await db.materials.toArray() : [];
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

  const materialRecords = [];
  const colorRecords = [];
  const colorUploadTasks = [];
  for (const m of preview.fabrics) {
    const existing = merge ? materialByNameKind.get(m.name + '|' + m.kind) || null : null;
    const id = existing?.id || newId();
    materialRecords.push({
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
      const row = {
        id: cid, materialId: id, name: col.name, code: col.code,
        swatchImageId: null,
      };
      colorRecords.push(row);
      counts.colors++;
      if (col.swatchBlob) {
        colorUploadTasks.push(async () => {
          row.swatchImageId = await saveImageBlob('color-swatch', cid, col.swatchBlob);
        });
      }
    }
  }
  if (materialRecords.length) await db.materials.bulkPut(materialRecords);
  // Swatches upload BEFORE inserting color rows so swatchImageId is set
  // when the rows hit the DB.
  if (colorUploadTasks.length) await runParallel(colorUploadTasks);
  if (colorRecords.length) await db.materialColors.bulkPut(colorRecords);

  /* ----- Products + variants ---- */
  // Phase 1: plan every product + variant. Pre-fetch products once so the
  // per-product loop is pure in-memory work.
  onProgress?.({ phase: 'planning', done: uploadsDone, total: totalUploads });
  const allExistingProducts = merge ? await db.products.toArray() : [];
  const productByName = new Map();
  for (const r of allExistingProducts) {
    if (r.name != null) productByName.set(r.name, r);
  }
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

    const variantPlans = p.variants.map((v) => {
      const refKey = normalizeKey(v.reference, 'ref');
      const globalMatch = refKey ? variantByRef.get(refKey) : null;
      const prev = globalMatch || byKey.get(v.reference || v.name);
      const vid = prev?.id || newId();
      // Reserve the ref→vid mapping at plan time so two products in this
      // import that share a reference dedupe against each other.
      if (refKey) variantByRef.set(refKey, { id: vid, reference: v.reference || '' });
      return { v, prev, vid };
    });

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

  // Phase 2.5: bulk-insert every `images` row we accumulated. Doing this
  // BEFORE the product/variant writes means variants whose imageId
  // references a freshly-uploaded image won't end up dangling.
  if (pendingImageRows.length) await db.images.bulkPut(pendingImageRows);

  // Phase 3: write the per-product DB rows now that every upload id is
  // resolved. Bulk-upsert in two calls (products, then variants) instead
  // of N separate `.put()`s.
  onProgress?.({ phase: 'writing', done: uploadsDone, total: totalUploads });
  const productRecords = [];
  const variantRecords = [];
  for (const plan of productPlans) {
    const { p, existing, productId, categoryId, variantPlans, vectorImageId } = plan;

    productRecords.push({
      id: productId,
      name: p.name,
      categoryId,
      designer: p.designer || existing?.designer || '',
      year: p.year || existing?.year || null,
      description: p.description || existing?.description || '',
      modelCode: p.modelCode || existing?.modelCode || '',
      technicalImpossibilities: p.impossibilities?.length
        ? p.impossibilities
        : (existing?.technicalImpossibilities || []),
      heroImageId: existing?.heroImageId || null,
      vectorImageId,
      pages: p.pages || [],
    });
    if (!existing) counts.products++;

    let order = 0;
    for (const pl of variantPlans) {
      const imageId = pl.imageId ?? pl.prev?.imageId ?? null;
      variantRecords.push({
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
      });
      if (!pl.prev) counts.variants++;
      order++;
    }
  }
  if (productRecords.length) await db.products.bulkPut(productRecords);
  if (variantRecords.length) await db.productVariants.bulkPut(variantRecords);

  onProgress?.({ phase: 'done', done: uploadsDone, total: totalUploads });

  return counts;
}
