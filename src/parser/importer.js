/**
 * Two-phase price-list importer.
 *
 *   importPdf(file)      — parse the entire PDF in the browser. No DB writes.
 *                          Returns a preview the UI can show before committing.
 *
 *   commitImport(preview)— map the preview to the RosetSoft schema and bulk
 *                          upsert categories, products, variants, materials,
 *                          colors. One Supabase request per chunk of 500 rows.
 *
 *   extractAndUploadImages(preview, opts) — optional follow-up pass. Renders
 *                          family-intro pages, crops the hero drawing, and
 *                          uploads to Storage with retry. Runs SEPARATELY from
 *                          the catalog text commit so a failed upload doesn't
 *                          take the catalog with it.
 *
 * Why two phases:
 *   - The old importer did 1 SELECT + 1 UPSERT per product AND per variant
 *     sequentially. For a full catalog (~165 families × ~28 variants = ~4525+
 *     variants) that's 9000+ round-trips. On Supabase free tier (~150ms RTT)
 *     a single import takes 20+ minutes and any browser hiccup or tab freeze
 *     kills the loop midway, leaving the catalog half-populated.
 *   - The new importer makes ~12 bulk requests for the whole catalog text,
 *     and each request is retried with exponential backoff. A full import
 *     completes in under a minute over a normal connection.
 *   - Image uploads are unavoidably one-per-file on the Storage API. Moving
 *     them to a separate, optional phase means catalog text always lands.
 */

import { parsePdfDocument, CATEGORY_HEADERS } from './parseDocument.js';
import { renderPdfPage, cropCanvasToBlob } from './pageImage.js';
import { db, newId, saveImageWithRetry } from '../db/database.js';
import { formatDimensions } from './lib/textUtils.js';

/* ------------------------------------------------------------------ */
/*  Parse                                                              */
/* ------------------------------------------------------------------ */

export async function importPdf(source, { onProgress, sourceFileName } = {}) {
  const result = await parsePdfDocument(source, {
    sourceFileName: sourceFileName || (source && source.name) || null,
    onProgress: (info) => onProgress?.({
      page: info.page,
      total: info.total,
      stage: info.phase,
    }),
  });

  // Shape the preview for the existing UI tabs (`fabrics`, `products`).
  // We expose the raw families and the per-family variant counts.
  const productsForUi = result.families.map(fam => {
    const variants = result.products.filter(p => p.family_id === fam.id);
    return {
      // keep the camelCase shape the existing Import.jsx expects
      name: fam.name,
      designer: fam.designer || '',
      year: fam.year || null,
      description: fam.description || '',
      modelCode: fam.code || '',
      impossibilities: parseImpossibilities(fam.technical_impossibilities),
      categoryName: fam.category || '',
      pages: [fam.intro_page, ...new Set(variants.map(v => v.page).filter(Boolean))]
        .filter(Boolean)
        .sort((a, b) => a - b),
      variantCount: variants.length,
      // preview-only — not used by commit, just for reference in the UI
      family: fam,
    };
  });

  return {
    sourceFileName: result.sourceFileName,
    families: result.families,
    products: result.products,                 // raw rows (one per reference)
    fabrics: result.materials,
    pages: result.pages,
    productsPreview: productsForUi,            // rolled-up per-family view for UI
    pdf: result.pdf,                            // kept for the optional image phase
    counts: {
      families: result.families.length,
      products: result.products.length,
      materials: result.materials.length,
    },
  };
}

function parseImpossibilities(text) {
  if (!text) return [];
  return String(text)
    .split(/[,.]/)
    .map(s => s.replace(/^\s*and\s+/i, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter(s => /^[A-Z][A-Z0-9/.\- ]{1,}$/.test(s));
}

/* ------------------------------------------------------------------ */
/*  Commit (catalog text — fast path)                                  */
/* ------------------------------------------------------------------ */

/**
 * Bulk-write categories, products (= families in the parser), variants
 * (= products in the parser), materials and colors.
 *
 * ID strategy — every id is DETERMINISTIC, derived from the catalog:
 *   - Categories: `cat_<slug>` (e.g. `cat_seats`)
 *   - Products:   the family slug (e.g. `amedee`, `amedee-106`)
 *   - Variants:   `v_<reference>` (catalog references are globally unique)
 *
 * Same input → same ids on every run, so re-imports upsert in place
 * instead of accumulating duplicates. Legacy rows from older imports that
 * use random ids can be collapsed with the productDedup / catalogDedup
 * tools in Settings (they merge by name and by reference respectively).
 */
export async function commitImport(preview, { onProgress } = {}) {
  const counts = {
    categories: 0, products: 0, variants: 0,
    materials: 0, colors: 0, images: 0,
  };

  function step(phase, done = 0, total = 0, label = '') {
    onProgress?.({ phase, done, total, label });
  }

  /* 1. Categories */
  step('categories', 0, 0, 'Categorías');
  const neededCategories = new Set(
    preview.families.map(f => f.category).filter(Boolean)
  );
  const existingCats = await db.categories.toArray();
  const catIdByName = new Map(existingCats.map(c => [c.name.toUpperCase(), c.id]));
  const categoryRows = [];
  for (const name of neededCategories) {
    const upper = name.toUpperCase();
    const id = catIdByName.get(upper) || `cat_${slug(name)}`;
    catIdByName.set(upper, id);
    const sortOrder = CATEGORY_HEADERS.indexOf(name);
    categoryRows.push({ id, name, sortOrder: sortOrder >= 0 ? sortOrder : 999 });
  }
  if (categoryRows.length) {
    await db.categories.bulkPut(categoryRows, {
      chunkSize: 500,
      onProgress: (d, t) => step('categories', d, t, 'Categorías'),
    });
    counts.categories = categoryRows.filter(r => !existingCats.some(e => e.id === r.id)).length;
  }

  /* 2. Products (families). ID strategy: each family gets a stable SLUG id
        ("amedee", "amedee-106"). The slug is deterministic from the catalog
        so subsequent imports upsert the same row in place. Legacy rows that
        predate the slug scheme can be collapsed with the existing
        productDedup tool from Settings → it merges by (name, designer). */
  step('products', 0, 0, 'Productos');
  const existingProducts = await db.products.toArray();
  const existingProductById = new Map(existingProducts.map(p => [p.id, p]));

  // Collect every page each family appears on (intro + product-list pages),
  // so the UI's "page reference" tooltip stays useful after re-imports.
  const pagesByFamily = new Map();
  for (const fam of preview.families) {
    pagesByFamily.set(fam.id, new Set(fam.intro_page ? [fam.intro_page] : []));
  }
  for (const item of preview.products) {
    if (!item.family_id || !item.page) continue;
    const set = pagesByFamily.get(item.family_id);
    if (set) set.add(item.page);
  }

  const productRows = [];
  const productIdByFamilyId = new Map();
  for (const fam of preview.families) {
    const id = fam.id;                       // stable slug
    productIdByFamilyId.set(fam.id, id);
    const categoryId = fam.category ? catIdByName.get(fam.category.toUpperCase()) || null : null;
    const existing = existingProductById.get(id);

    const famPages = [...(pagesByFamily.get(fam.id) || [])].sort((a, b) => a - b);

    productRows.push({
      id,
      name: fam.name,
      categoryId,
      designer: fam.designer || existing?.designer || '',
      year: fam.year || existing?.year || null,
      description: fam.description || existing?.description || '',
      modelCode: fam.code || existing?.modelCode || '',
      technicalImpossibilities: parseImpossibilities(fam.technical_impossibilities),
      heroImageId: existing?.heroImageId || null,
      vectorImageId: existing?.vectorImageId || null,
      pages: famPages.length ? famPages : (existing?.pages || []),
    });
  }
  if (productRows.length) {
    await db.products.bulkPut(productRows, {
      chunkSize: 500,
      onProgress: (d, t) => step('products', d, t, 'Productos'),
    });
    counts.products = productRows.filter(r => !existingProducts.some(e => e.id === r.id)).length;
  }

  /* 3. Variants. ID strategy: id = `v_<reference>` (catalog references are
        unique and case-stable). Legacy rows with random ids and the same
        reference are merged via the catalogDedup tool in Settings. */
  step('variants', 0, 0, 'Variantes');
  const existingVariants = await db.productVariants.toArray();
  const existingVariantById = new Map(existingVariants.map(v => [v.id, v]));

  // Group products by family for sortOrder.
  const variantRows = [];
  const familyOrder = new Map();
  for (const item of preview.products) {
    const productId = productIdByFamilyId.get(item.family_id);
    if (!productId) continue;             // unattached product, skip
    const order = (familyOrder.get(productId) || 0);
    familyOrder.set(productId, order + 1);

    const id = `v_${item.reference}`;
    const existing = existingVariantById.get(id);

    // Catalog products either expose graded prices (seating, A–Z columns) or
    // a single fixed price (cabinetry). Keep them in their own slot and
    // never write to both — the UI prefers graded prices when present.
    const priceByGrade = {};
    let priceFixed = null;
    for (const pr of (item.prices || [])) {
      if (pr.price == null) continue;
      if (pr.grade) priceByGrade[pr.grade] = pr.price;
    }
    if (Object.keys(priceByGrade).length === 0) {
      for (const pr of (item.prices || [])) {
        if (pr.price == null) continue;
        if (priceFixed == null || pr.price < priceFixed) priceFixed = pr.price;
      }
    }

    const fullName = [item.variant_name, item.variant_subtitle, item.finish]
      .filter(Boolean).join(' — ');

    variantRows.push({
      id,
      productId,
      name: fullName || item.variant_name || item.finish || `Ref ${item.reference}`,
      reference: item.reference,
      yardage: item.yardage != null ? `${item.yardage}yd` : '',
      dimensions: formatDimensions(item),
      priceByGrade,
      priceFixed,
      sortOrder: existing?.sortOrder ?? order,
      imageId: existing?.imageId || null,
    });
  }
  if (variantRows.length) {
    await db.productVariants.bulkPut(variantRows, {
      chunkSize: 500,
      onProgress: (d, t) => step('variants', d, t, 'Variantes'),
    });
    counts.variants = variantRows.filter(r => !existingVariants.some(e => e.id === r.id)).length;
  }

  /* 4. Materials + colors */
  step('materials', 0, 0, 'Materiales');
  const existingMaterials = await db.materials.toArray();
  const materialIdByKey = new Map();
  for (const m of existingMaterials) {
    materialIdByKey.set(`${(m.name || '').toUpperCase()}|${m.kind}`, m.id);
  }

  const materialRows = [];
  for (const m of preview.fabrics) {
    const key = `${m.name.toUpperCase()}|${m.kind}`;
    const id = materialIdByKey.get(key) || newId();
    materialIdByKey.set(key, id);
    materialRows.push({
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
  }
  if (materialRows.length) {
    await db.materials.bulkPut(materialRows, {
      chunkSize: 500,
      onProgress: (d, t) => step('materials', d, t, 'Materiales'),
    });
    counts.materials = materialRows.filter(r => !existingMaterials.some(e => e.id === r.id)).length;
  }

  /* 5. Material colors. Build the new rows, then upsert. We DO NOT delete
        existing colors — colors users added by hand should survive. */
  step('colors', 0, 0, 'Colores');
  const existingColors = await db.materialColors.toArray();
  const colorIdByKey = new Map();
  for (const c of existingColors) {
    colorIdByKey.set(`${c.materialId}|${(c.name || '').toUpperCase()}|${c.code || ''}`, c.id);
  }
  const colorRows = [];
  for (const m of preview.fabrics) {
    const key = `${m.name.toUpperCase()}|${m.kind}`;
    const materialId = materialIdByKey.get(key);
    if (!materialId) continue;
    for (const col of (m.colors || [])) {
      const ck = `${materialId}|${(col.name || '').toUpperCase()}|${col.code || ''}`;
      const id = colorIdByKey.get(ck) || newId();
      colorIdByKey.set(ck, id);
      colorRows.push({
        id,
        materialId,
        name: col.name || '',
        code: col.code || '',
        swatchImageId: existingColors.find(e => e.id === id)?.swatchImageId || null,
      });
    }
  }
  if (colorRows.length) {
    await db.materialColors.bulkPut(colorRows, {
      chunkSize: 500,
      onProgress: (d, t) => step('colors', d, t, 'Colores'),
    });
    counts.colors = colorRows.filter(r => !existingColors.some(e => e.id === r.id)).length;
  }

  step('done', 1, 1, 'Listo');
  return counts;
}

function slug(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/* ------------------------------------------------------------------ */
/*  Image extraction (optional second pass)                            */
/* ------------------------------------------------------------------ */

/**
 * Render each family-intro page and crop the large hero drawing. Uploads
 * are issued with bounded concurrency and per-file retry, so a flaky
 * Storage response doesn't take down the whole pass.
 *
 * Re-running this is safe: families that already have a vectorImageId are
 * skipped.
 */
export async function extractAndUploadImages(preview, {
  concurrency = 3,
  onProgress,
} = {}) {
  if (!preview?.pdf) {
    throw new Error('extractAndUploadImages: preview.pdf is missing — re-parse the PDF first.');
  }
  const pdf = preview.pdf;

  // Refresh which products already have a vector image — re-runs should skip
  // anything that landed last time.
  const existing = await db.products.toArray();
  const productIdByName = new Map();
  for (const p of existing) productIdByName.set((p.name || '').toUpperCase(), p);

  const tasks = [];
  for (const fam of preview.families) {
    if (!fam.intro_page) continue;
    const product = productIdByName.get(fam.name.toUpperCase());
    if (!product) continue;
    if (product.vectorImageId) continue;     // already imported
    tasks.push({ fam, product });
  }

  if (!tasks.length) {
    onProgress?.({ done: 0, total: 0 });
    return { uploaded: 0, skipped: 0, failed: 0 };
  }

  let done = 0;
  let uploaded = 0;
  let failed = 0;
  onProgress?.({ done: 0, total: tasks.length });

  async function worker(slice) {
    for (const { fam, product } of slice) {
      try {
        const blob = await renderHeroBlob(pdf, fam.intro_page);
        if (blob) {
          const imageId = await saveImageWithRetry({
            kind: 'product-vector',
            ownerId: product.id,
            file: blob,
            label: fam.name,
          });
          if (imageId) {
            await db.products.update(product.id, { vectorImageId: imageId });
            uploaded++;
          } else {
            failed++;
          }
        }
      } catch (e) {
        console.warn(`[image] page ${fam.intro_page} (${fam.name}):`, e?.message || e);
        failed++;
      } finally {
        done++;
        onProgress?.({ done, total: tasks.length });
      }
    }
  }

  // Slice tasks across N workers — Storage tolerates ~3-5 concurrent uploads
  // on free tier without throttling.
  const slices = Array.from({ length: Math.min(concurrency, tasks.length) }, () => []);
  tasks.forEach((t, i) => slices[i % slices.length].push(t));
  await Promise.all(slices.map(worker));

  return { uploaded, skipped: tasks.length - uploaded - failed, failed };
}

/**
 * Render a family-intro page at moderate scale and crop the big drawing.
 * Layout assumption: hero drawing sits in the upper third of the page,
 * roughly x=20..575, y=50..460 in PDF user units (page is 595 × 841).
 */
async function renderHeroBlob(pdf, pageNo) {
  const { canvas, scale } = await renderPdfPage(pdf, pageNo, 1.6);
  const blob = await cropCanvasToBlob(
    canvas,
    { x: 20, y: 50, w: 555, h: 410 },
    scale,
    { mime: 'image/jpeg', maxBlankPct: 0.999 },
  );
  return blob;
}
