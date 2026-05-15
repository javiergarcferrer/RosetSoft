/**
 * Catalog import — takes the JSON produced by the external Python parser
 * (tarif-parser/out/catalog.json) and lands it in Supabase.
 *
 * The parser does the heavy lifting (PDF → normalized JSON). This module
 * only has to:
 *
 *   1. Map the parser's int-id schema onto the app's text-slug schema.
 *   2. Dedupe variants that the parser emits more than once for the same
 *      (product, reference, name) tuple.
 *   3. Upload in bulk-upsert batches of 500 with retry-on-error so a free-
 *      tier Supabase project doesn't reject the run mid-flight.
 *
 * The catalog text lands in five tables, in this order so foreign keys
 * resolve as we go:
 *
 *     categories  →  products  →  product_variants
 *     materials   →  material_colors
 *
 * Images are deliberately out of scope here. The Python parser writes them
 * to `out/images/p<page>/…` on the user's disk, and the JSON only carries
 * a relative `image_filename`. A future pass can read those files and
 * upload them to Supabase Storage; for now `image_id` stays null and the
 * catalog UI shows its placeholder icon.
 */

import { db } from '../db/database.js';

/* ------------------------------------------------------------------ */
/*  Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Cheap sanity check that this JSON came from the parser. Doesn't try to
 * validate every field — only enough to fail fast on the wrong file.
 */
export function inspectCatalogJson(data) {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'JSON root is not an object.' };
  }
  const required = ['categories', 'products', 'variants', 'cover_materials'];
  for (const k of required) {
    if (!(k in data)) return { ok: false, error: `Missing "${k}" key.` };
  }
  if (!Array.isArray(data.categories)) return { ok: false, error: '"categories" is not an array.' };
  if (!Array.isArray(data.products))   return { ok: false, error: '"products" is not an array.' };
  if (!Array.isArray(data.variants))   return { ok: false, error: '"variants" is not an array.' };
  const cm = data.cover_materials;
  if (!cm || typeof cm !== 'object') return { ok: false, error: '"cover_materials" missing/wrong type.' };

  const fabrics  = Array.isArray(cm.fabrics)         ? cm.fabrics.length         : 0;
  const leathers = Array.isArray(cm.leathers)        ? cm.leathers.length        : 0;
  const outdoor  = Array.isArray(cm.outdoor_fabrics) ? cm.outdoor_fabrics.length : 0;

  return {
    ok: true,
    counts: {
      categories: data.categories.length,
      products:   data.products.length,
      variants:   data.variants.length,
      fabrics, leathers, outdoor,
      materials:  fabrics + leathers + outdoor,
    },
    sourcePdf: data.source_pdf || null,
    pages:     data.pages || null,
  };
}

/* ------------------------------------------------------------------ */
/*  Transform                                                           */
/* ------------------------------------------------------------------ */

const CATEGORY_PREFIX = 'cat';

function slugify(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function categoryId(name) {
  return `${CATEGORY_PREFIX}_${slugify(name)}`;
}

/** Title-Case a SCREAMING-CASE catalog header so the UI doesn't yell. */
function prettyCategoryName(name) {
  return String(name)
    .toLowerCase()
    .replace(/(^|[\s\-/])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/** "H 33 · W 30¼ · D 32¼ · S 15¾" from { H: '33', W: '30¼', … } */
function formatDimensions(dims) {
  if (!dims || typeof dims !== 'object') return '';
  const order = ['H', 'W', 'D', 'S', 'L'];
  const parts = [];
  for (const k of order) {
    if (dims[k] != null && String(dims[k]).trim() !== '') {
      parts.push(`${k} ${String(dims[k]).trim()}`);
    }
  }
  return parts.join(' · ');
}

/** "ARMCHAIR PART A — BLACK STAINED OAK" from a parser variant. */
function variantDisplayName(v) {
  const finish = v.color_options?.[0]?.color_or_finish || '';
  const parts = [v.variant_name, v.subtype, finish].filter(Boolean);
  // Strip duplicates (the catalog sometimes prints the same label twice).
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const k = p.trim().toUpperCase();
    if (seen.has(k) || !k) continue;
    seen.add(k);
    out.push(p.trim());
  }
  return out.join(' — ').replace(/\s+/g, ' ').trim();
}

/** Split the parser's "FOO, BAR (NOTE), BAZ." string into a clean array. */
function parseTechnicalNotes(text) {
  if (!text) return [];
  return String(text)
    .split(',')
    .map(s => s.replace(/[.;]\s*$/, '').trim())
    .filter(Boolean);
}

/**
 * Convert the parser JSON into the row shapes the four import phases need.
 * Returns an object with arrays ready to feed straight into bulkPut().
 *
 * Errors are collected but don't abort the transform; the caller decides
 * whether to proceed.
 */
export function transformCatalog(json) {
  const warnings = [];

  /* categories */
  const categoryIdByParserId = new Map();   // int id → text slug
  const categories = [];
  let catSort = 0;
  for (const c of json.categories) {
    const id = categoryId(c.name);
    categoryIdByParserId.set(c.id, id);
    categories.push({
      id,
      name: prettyCategoryName(c.name),
      sortOrder: catSort++,
    });
  }

  /* products */
  const productIdByParserId = new Map();    // int id → text slug
  const products = [];
  const usedSlugs = new Set();
  for (const p of json.products) {
    let slug = p.slug || slugify(p.name);
    if (!slug) {
      warnings.push(`product ${p.id} ("${p.name}") has no slug, skipping`);
      continue;
    }
    // Disambiguate slug collisions across products (parser sometimes emits
    // the same slug for two distinct products on different pages).
    let unique = slug;
    let n = 2;
    while (usedSlugs.has(unique)) unique = `${slug}-${n++}`;
    usedSlugs.add(unique);

    productIdByParserId.set(p.id, unique);
    products.push({
      id: unique,
      categoryId: categoryIdByParserId.get(p.category_id) || null,
      name: p.name,
      designer: p.designer || '',
      year: p.year ?? null,
      description: p.description || '',
      important: p.important || '',
      modelCode: p.code || '',
      technicalImpossibilities: parseTechnicalNotes(p.technical_notes),
      heroImageId: null,
      vectorImageId: null,
      pages: rangeAsArray(p.page_start, p.page_end),
    });
  }

  /* variants — dedupe first, then assign deterministic ids */
  const variants = transformVariants(json.variants, productIdByParserId, warnings);

  /* materials + colors */
  const cm = json.cover_materials || {};
  const allMaterials = [
    ...(cm.fabrics         || []),
    ...(cm.leathers        || []),
    ...(cm.outdoor_fabrics || []),
  ];
  const materialIdByParserId = new Map();
  const materials = [];
  const materialColors = [];

  for (const m of allMaterials) {
    const id = `mat_${m.type}_${slugify(m.name)}`;
    if (materialIdByParserId.has(m.id)) {
      warnings.push(`material parser id ${m.id} appeared twice`);
      continue;
    }
    materialIdByParserId.set(m.id, id);

    materials.push({
      id,
      kind: m.type,                          // 'fabric' / 'leather' / 'outdoor-fabric' — schema matches
      name: m.name,
      grade: m.grade || null,
      wear: m.abrasion || null,
      martindale: m.martindale ?? null,
      width: m.width_in || null,
      pricePerUnit: m.price_per_unit ?? null,
      composition: m.composition || '',
      notes: composeNotes(m),
      restrictedToProductNames: [],
    });

    // The parser occasionally emits the same (code, name) twice on a single
    // material — skip the duplicates so we don't waste a batch slot on rows
    // that would upsert to the same id anyway.
    const seenColorKeys = new Set();
    for (const c of (m.colors || [])) {
      const key = `${(c.code || '').toUpperCase()}|${(c.name || '').toUpperCase()}`;
      if (seenColorKeys.has(key)) continue;
      seenColorKeys.add(key);
      // Prefix with the full material id (which includes the kind) so a color
      // shared between a fabric and an outdoor-fabric of the same name —
      // e.g. ROMA exists in both — gets distinct ids.
      const colorId = `${id}_color_${slugify(c.code || c.name || '')}`;
      materialColors.push({
        id: colorId,
        materialId: id,
        name: c.name || '',
        code: c.code || '',
        swatchImageId: null,
      });
    }
  }

  return { categories, products, variants, materials, materialColors, warnings };
}

function rangeAsArray(start, end) {
  if (start == null) return [];
  if (end == null || end < start) return [start];
  const out = [];
  for (let p = start; p <= end; p++) out.push(p);
  return out;
}

/**
 * Tack the parser's `unit` and `thickness` onto a material's notes column so
 * the data isn't lost — the existing schema has no columns for them.
 */
function composeNotes(m) {
  const bits = [];
  if (m.notes) bits.push(m.notes);
  if (m.unit && m.unit !== 'yard') bits.push(`Unit: ${m.unit}`);
  if (m.thickness) bits.push(`Thickness: ${m.thickness}`);
  return bits.join(' · ').slice(0, 800);
}

/**
 * The parser emits the same (product, reference, variant_name) tuple multiple
 * times in some cases — same SKU referenced under several sofa configurations,
 * or the dedupe pass missed a row. We collapse them, keeping the row with the
 * most price data, so the catalog doesn't show ghost duplicates.
 *
 * Variant IDs are stable across re-imports: `v_<product>_<reference>_<seq>`,
 * where seq is the position of this variant within the dedupe group for that
 * (product, reference) pair (almost always 0).
 */
function transformVariants(rawVariants, productIdByParserId, warnings) {
  // 1. Group by dedupe key
  const groups = new Map();
  for (const v of rawVariants) {
    const productSlug = productIdByParserId.get(v.product_id);
    if (!productSlug) {
      warnings.push(`variant on page ${v.page} references unknown product_id ${v.product_id}`);
      continue;
    }
    const ref = v.reference_code || v.color_options?.[0]?.reference_code || '';
    const key = [productSlug, ref, (v.variant_name || '').trim(), v.subtype || ''].join('|');
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push({ ...v, _productSlug: productSlug, _ref: ref });
  }

  // 2. Within each group, pick the variant with the most price data.
  // Within a (product, reference) pair, number the surviving rows so their
  // ids stay unique even after dedupe — the rare case where two variants
  // genuinely differ on something we can't see in the key.
  const seqByPair = new Map();
  const variants = [];
  for (const arr of groups.values()) {
    arr.sort((a, b) => priceWeight(b) - priceWeight(a));
    const v = arr[0];
    if (arr.length > 1) {
      warnings.push(`deduped ${arr.length} variants of (${v._productSlug}, ${v._ref}, "${v.variant_name}")`);
    }
    const pairKey = `${v._productSlug}|${v._ref}`;
    const seq = seqByPair.get(pairKey) || 0;
    seqByPair.set(pairKey, seq + 1);

    const refToken = v._ref || `noref-${seq}`;
    const id = `v_${v._productSlug}_${refToken}${seq ? `_${seq}` : ''}`;

    const priceByGrade = (v.pricing_model === 'grade' && v.grade_prices && typeof v.grade_prices === 'object')
      ? { ...v.grade_prices }
      : {};
    const priceFixed = (v.pricing_model === 'color' && v.color_options?.length)
      ? v.color_options[0].price_usd ?? null
      : null;

    variants.push({
      id,
      productId: v._productSlug,
      name: variantDisplayName(v) || `Ref ${v._ref || '(unknown)'}`,
      reference: v._ref || '',
      yardage: v.yardage || '',
      dimensions: formatDimensions(v.dimensions),
      priceByGrade,
      priceFixed,
      sortOrder: variants.length,
      imageId: null,
    });
  }

  return variants;
}

function priceWeight(v) {
  const grades = v.pricing_model === 'grade' ? Object.keys(v.grade_prices || {}).length : 0;
  const colors = v.pricing_model === 'color' ? (v.color_options || []).length : 0;
  // 1 point per grade column, 100 points per color option (color rows carry
  // the actual SKU price), tie-broken by description presence.
  return grades + colors * 100 + (v.description ? 1 : 0);
}

/* ------------------------------------------------------------------ */
/*  Commit                                                              */
/* ------------------------------------------------------------------ */

/**
 * Write a transformed catalog to Supabase in five bulk-upsert phases.
 * Phases run sequentially because each one's foreign keys reference the
 * previous one's rows. Within a phase, db.bulkPut() chunks at 500 rows and
 * retries each chunk on transient errors.
 *
 * Returns counts of rows attempted (not necessarily *new*) per phase.
 */
export async function commitCatalog(transformed, { onProgress } = {}) {
  const step = (phase, done, total, label) =>
    onProgress?.({ phase, done, total, label });

  const counts = {};

  step('categories', 0, transformed.categories.length, 'Categorías');
  await db.categories.bulkPut(transformed.categories, {
    chunkSize: 500,
    onProgress: (d, t) => step('categories', d, t, 'Categorías'),
  });
  counts.categories = transformed.categories.length;

  step('products', 0, transformed.products.length, 'Productos');
  await db.products.bulkPut(transformed.products, {
    chunkSize: 500,
    onProgress: (d, t) => step('products', d, t, 'Productos'),
  });
  counts.products = transformed.products.length;

  step('variants', 0, transformed.variants.length, 'Variantes');
  await db.productVariants.bulkPut(transformed.variants, {
    chunkSize: 500,
    onProgress: (d, t) => step('variants', d, t, 'Variantes'),
  });
  counts.variants = transformed.variants.length;

  step('materials', 0, transformed.materials.length, 'Materiales');
  await db.materials.bulkPut(transformed.materials, {
    chunkSize: 500,
    onProgress: (d, t) => step('materials', d, t, 'Materiales'),
  });
  counts.materials = transformed.materials.length;

  step('colors', 0, transformed.materialColors.length, 'Colores');
  await db.materialColors.bulkPut(transformed.materialColors, {
    chunkSize: 500,
    onProgress: (d, t) => step('colors', d, t, 'Colores'),
  });
  counts.colors = transformed.materialColors.length;

  step('done', 1, 1, 'Listo');
  return counts;
}
