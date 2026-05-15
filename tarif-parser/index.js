#!/usr/bin/env node
// CLI entry point and pipeline orchestrator. Owns the only state machine in
// the parser — every extractor below is pure (no module-level mutation).

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openPdf, readPage, extractPageImages, rawToJpeg } from './pdf.js';
import { classifyPage } from './classify.js';
import { extractProductFields } from './product.js';
import { extractAllVariantTables, extractCabinetryTable } from './variant.js';
import { parseSingleFabricPage, parseLegacyMaterialPage } from './material.js';
import { normalizeKey, normalizeRef, shortId } from './normalize.js';
import { CatalogSchema, checkInvariants } from './schema.js';

const USAGE = `Usage: node index.js <input.pdf> [--out <dir>] [--no-images] [--dry-run] [--only-pages 12-18] [--verbose]`;

function parseArgs(argv) {
  const args = { inputPath: null, out: 'out', noImages: false, dryRun: false, onlyPages: null, verbose: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--out') args.out = rest[++i];
    else if (a === '--no-images') args.noImages = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--only-pages') {
      const range = rest[++i] || '';
      const m = range.match(/^(\d+)-(\d+)$/);
      if (!m) throw new Error('--only-pages must look like 12-18');
      args.onlyPages = [Number(m[1]), Number(m[2])];
    } else if (a === '--verbose') args.verbose = true;
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else if (!args.inputPath) args.inputPath = a;
    else throw new Error('unexpected positional arg: ' + a);
  }
  if (!args.inputPath) throw new Error('input.pdf is required\n' + USAGE);
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = resolve(args.out);
  const imagesDir = join(outDir, 'images');
  await mkdir(outDir, { recursive: true });
  if (!args.noImages && !args.dryRun) await mkdir(imagesDir, { recursive: true });

  const report = new Report();
  report.add(`Source: ${args.inputPath}`);
  report.add(`Output: ${outDir}`);
  report.add(`Flags:  ${[args.noImages && '--no-images', args.dryRun && '--dry-run',
    args.onlyPages && `--only-pages ${args.onlyPages[0]}-${args.onlyPages[1]}`, args.verbose && '--verbose']
    .filter(Boolean).join(' ') || '(none)'}`);

  const t0 = Date.now();
  const pdf = await openPdf(args.inputPath);
  const numPages = pdf.numPages;
  report.add(`Pages: ${numPages}`);

  const firstP = args.onlyPages ? args.onlyPages[0] : 1;
  const lastP = args.onlyPages ? args.onlyPages[1] : numPages;

  const state = {
    currentCategory: null,
    currentMaterialKind: null,
    currentProductKey: null,
  };
  const productsByKey = new Map();
  const materialsByKey = new Map();
  const kindCounts = {};
  const warnings = [];
  const imageJobs = [];
  // Globally seen variant references. Cabinetry pages repeat cross-product
  // accessory SKUs (LED kits, glass shelves, lacquer packs). The first
  // product page that introduces a ref owns the variant; subsequent pages
  // skip it.
  const seenRefs = new Set();
  // Banners that have appeared as standalone section dividers (a page whose
  // sole content is the banner). When we later see the same banner on a
  // cabinetry page, we know it's a multi-product layout and look at the
  // sub-banners on the page to attribute each variant to its real product.
  const sectionBanners = new Set();

  // Cabinetry pages whose banner is a known section name are MULTI-PRODUCT:
  // we defer them to a second pass so clean (single-product) pages claim
  // their references first via the global seenRefs set. Otherwise, e.g.,
  // p600 ("OTHER OCCASIONAL ITEMS") would claim KAKUDO refs before p808
  // ("KAKUDO") had a chance.
  const deferred = [];
  for (let p = firstP; p <= lastP; p++) {
    let pageInfo;
    try {
      pageInfo = await readPage(pdf, p);
    } catch (err) {
      warnings.push(`p${p}: read failure: ${err.message}`);
      continue;
    }
    let classified;
    try {
      classified = classifyPage(pageInfo);
    } catch (err) {
      warnings.push(`p${p}: classify failure: ${err.message}`);
      continue;
    }
    kindCounts[classified.kind] = (kindCounts[classified.kind] || 0) + 1;
    if (args.verbose) {
      process.stderr.write(`p${p.toString().padStart(4)} ${classified.kind}\n`);
    }
    try {
      if (classified.kind === 'cabinetry') {
        const banner = extractProductFields(pageInfo).banner;
        const bannerKey = banner ? normalizeKey(canonicalProductName(banner)) : '';
        if (bannerKey && sectionBanners.has(bannerKey)) {
          deferred.push({ pageInfo, classified });
          continue;
        }
      }
      handlePage(pageInfo, classified, state, productsByKey, materialsByKey, warnings, imageJobs, seenRefs, sectionBanners);
    } catch (err) {
      warnings.push(`p${p}: handler failure: ${err.message}`);
    }
    if ((p - firstP) % 8 === 7) await new Promise((r) => setImmediate(r));
  }

  // Second pass: section-banner cabinetry pages, with sub-banner attribution.
  for (const { pageInfo, classified } of deferred) {
    try {
      handlePage(pageInfo, classified, state, productsByKey, materialsByKey, warnings, imageJobs, seenRefs, sectionBanners);
    } catch (err) {
      warnings.push(`p${pageInfo.pageNumber}: deferred handler failure: ${err.message}`);
    }
  }

  // Optional image-extraction pass (concurrency 4). For each product, we
  // scan its pages in order and use the LARGEST embedded raster image we
  // find as the hero. Product front-card pages typically carry the photo;
  // variant table pages typically don't.
  if (!args.noImages && !args.dryRun) {
    await imageExtractionPass(pdf, productsByKey, imagesDir, warnings);
  }

  // Build per-category fallback image map. The largest hero image in a
  // category becomes the default image for any product in that category
  // that lacks its own embedded raster.
  const categoryFallbacks = new Map();
  for (const acc of productsByKey.values()) {
    if (!acc.heroImageFile || !acc.categoryName) continue;
    const cat = acc.categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!categoryFallbacks.has(cat)) categoryFallbacks.set(cat, acc.heroImageFile);
  }

  const ctx = { categoryFallbacks };

  // Build deterministic output. Every variant ends up with a reference,
  // dimensions, image, and description (synthesised when needed) — no
  // variants are dropped. The "real" extracted value is preferred at every
  // level; we only fall back if extraction came up empty.
  const products = [...productsByKey.values()]
    .map((acc) => serializeProduct(acc, ctx))
    .filter((p) => p.variants.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));

  const materials = [...materialsByKey.values()]
    .map(serializeMaterial)
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));

  const catalog = {
    meta: {
      source: args.inputPath,
      pageCount: numPages,
      generatedAt: '1970-01-01T00:00:00.000Z',
    },
    products,
    materials,
  };

  let parsed;
  try {
    parsed = CatalogSchema.parse(catalog);
  } catch (err) {
    report.add('SCHEMA VALIDATION FAILED:');
    report.add(String(err.message || err));
    await flushReport(outDir, report, products, materials, warnings, kindCounts, numPages);
    process.exit(1);
  }

  const invariants = checkInvariants(parsed);
  if (!invariants.ok) {
    report.add('HARD INVARIANT VIOLATIONS:');
    for (const e of invariants.errors) report.add('  - ' + e);
    await flushReport(outDir, report, products, materials, warnings, kindCounts, numPages);
    await writeFile(join(outDir, 'catalog.json'), stableStringify(parsed) + '\n', 'utf8');
    process.exit(1);
  }

  await writeFile(join(outDir, 'catalog.json'), stableStringify(parsed) + '\n', 'utf8');

  // Page-noise threshold: only count truly-unrecognised pages (kind=noise);
  // blank pages (kind=blank) are expected and don't count against the gate.
  const noisePct = (kindCounts.noise || 0) / numPages;
  await flushReport(outDir, report, products, materials, warnings, kindCounts, numPages);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  process.stderr.write(`done in ${dt}s · products=${products.length} variants=${countVariants(products)}\n`);

  if (noisePct > 0.05) {
    process.stderr.write(`unrecognised pages exceeded 5% (${(noisePct * 100).toFixed(1)}%) — exiting 2\n`);
    process.exit(2);
  }
  process.exit(0);
}

// -- handlers -----------------------------------------------------------------

function handlePage(pageInfo, classified, state, productsByKey, materialsByKey, warnings, imageJobs, seenRefs, sectionBanners) {
  switch (classified.kind) {
    case 'section': {
      const section = (classified.hints.sectionName || '').toUpperCase().replace(/\s+/g, ' ').trim();
      state.currentCategory = section;
      state.currentProductKey = null;
      sectionBanners.add(normalizeKey(section));
      // Track the section banner if it implies a material kind.
      const c = state.currentCategory;
      if (/LEATHER/.test(c)) state.currentMaterialKind = 'leather';
      else if (/OUTDOOR/.test(c)) state.currentMaterialKind = 'outdoor-fabric';
      else if (/FABRIC|COVER MATERIALS/.test(c)) state.currentMaterialKind = 'fabric';
      else state.currentMaterialKind = null;
      return;
    }
    case 'product':
    case 'cabinetry': {
      handleProductPage(pageInfo, classified, state, productsByKey, warnings, imageJobs, seenRefs, sectionBanners);
      return;
    }
    case 'fabric-list':
    case 'leather-list':
    case 'outdoor-list': {
      handleMaterialPage(pageInfo, classified, state, materialsByKey, warnings);
      return;
    }
    case 'info':
    case 'noise':
    default:
      return;
  }
}

// Strip the trailing " 2"/" 3" continuation marker Ligne Roset adds to
// long product pages so the second page of EXCLUSIF reads as "EXCLUSIF 2".
function canonicalProductName(s) {
  if (!s) return s;
  return s.replace(/\s+[2-9]$/u, '').trim();
}

function handleProductPage(pageInfo, classified, state, productsByKey, warnings, imageJobs, seenRefs, sectionBanners) {
  const fields = extractProductFields(pageInfo);
  const banner = fields.banner;

  // If the banner is actually a SECTION name (a banner we've seen as a
  // standalone section divider earlier in the document), this is a
  // multi-product cabinetry page. Don't create a "OTHER OCCASIONAL ITEMS"
  // product — instead use sub-banner attribution below.
  const bannerKey = banner ? normalizeKey(canonicalProductName(banner)) : '';
  const bannerIsSection = bannerKey && sectionBanners.has(bannerKey);
  const usableBanner = bannerIsSection ? null : banner;

  let key;
  if (usableBanner) {
    key = normalizeKey(canonicalProductName(usableBanner));
    state.currentProductKey = key;
  } else if (state.currentProductKey && !bannerIsSection) {
    key = state.currentProductKey;
  } else if (!bannerIsSection) {
    warnings.push(`p${pageInfo.pageNumber}: orphan product page (no current product key)`);
    return;
  }

  // Page-level product accumulator. Skipped when bannerIsSection — those
  // pages only contribute via sub-banner attribution.
  let acc = null;
  if (key) {
    acc = productsByKey.get(key);
    if (!acc) {
      acc = {
        key,
        name: canonicalProductName(usableBanner) || state.currentProductKey,
        categoryName: state.currentCategory,
        designer: fields.designer || null,
        year: fields.year || null,
        description: fields.description || null,
        important: fields.important || null,
        impossibilities: new Set(fields.impossibilities || []),
        modelCode: fields.modelCode || null,
        pages: new Set([pageInfo.pageNumber]),
        heroImageFile: null,
        variants: [],
        variantRefs: new Set(),
        variantNameKeys: new Set(),
      };
      productsByKey.set(key, acc);
    } else {
      if (!acc.designer && fields.designer) acc.designer = fields.designer;
      if (acc.year == null && fields.year != null) acc.year = fields.year;
      if (!acc.description && fields.description) acc.description = fields.description;
      if (!acc.important && fields.important) acc.important = fields.important;
      if (!acc.modelCode && fields.modelCode) acc.modelCode = fields.modelCode;
      for (const x of fields.impossibilities || []) acc.impossibilities.add(x);
      acc.pages.add(pageInfo.pageNumber);
    }
  }

  // Variants. Two table flavours:
  //  - upholstered grid (Name/Dim/Yardage/Reference/Currency/A..Z prices)
  //  - cabinetry table (row-per-variant with Name|Dim|Colors|Reference|USD)
  let tables = [];
  try {
    if (classified.kind === 'cabinetry') {
      const t = extractCabinetryTable(pageInfo.items);
      if (t.variants.length) tables = [t];
    } else {
      tables = extractAllVariantTables(pageInfo.items);
    }
  } catch (err) {
    warnings.push(`p${pageInfo.pageNumber}: variant-table extraction failed: ${err.message}`);
  }
  for (const table of tables) {
    for (const v of table.variants) {
      const ref = v.reference ? normalizeRef(v.reference) : '';

      // Sub-banner attribution: when this page's main banner is a section
      // name, the real product is whatever sub-banner sits closest above
      // this variant's row. Fall back to acc if no sub-banner is found.
      let targetAcc = acc;
      if (bannerIsSection) {
        if (!v.subBanner) {
          // No sub-banner: orphan variant on a section-banner cabinetry page.
          continue;
        }
        const subKey = normalizeKey(canonicalProductName(v.subBanner));
        // If the sub-banner ITSELF is a known section name, skip.
        if (sectionBanners.has(subKey)) continue;
        targetAcc = productsByKey.get(subKey);
        if (!targetAcc) {
          // Create a new product accumulator on demand. Sub-banner blocks
          // typically print a short descriptive paragraph next to the
          // sub-banner — we copy it onto the product so the variant
          // serialiser can denormalise it onto every variant.
          targetAcc = {
            key: subKey,
            name: canonicalProductName(v.subBanner),
            categoryName: state.currentCategory,
            designer: null,
            year: null,
            description: v.subBannerDescription || null,
            important: null,
            impossibilities: new Set(),
            modelCode: null,
            pages: new Set([pageInfo.pageNumber]),
            heroImageFile: null,
            variants: [],
            variantRefs: new Set(),
            variantNameKeys: new Set(),
          };
          productsByKey.set(subKey, targetAcc);
        } else {
          targetAcc.pages.add(pageInfo.pageNumber);
          if (!targetAcc.description && v.subBannerDescription) {
            targetAcc.description = v.subBannerDescription;
          }
        }
      }
      if (!targetAcc) continue;

      const dedupeKey = ref ? ref : '__name:' + normalizeKey(v.name);
      if (ref && targetAcc.variantRefs.has(ref)) continue;
      if (!ref && targetAcc.variantNameKeys.has(dedupeKey)) continue;
      // Cross-product dedupe: a ref already claimed by another product page
      // (shared accessories — LED kits, cushion SKUs, glass shelves) is
      // skipped on this product. First page wins.
      if (ref && seenRefs.has(ref)) continue;

      const hasPrice = Object.keys(v.priceByGrade || {}).length > 0 || v.priceFixed != null;
      if (!hasPrice) {
        warnings.push(`p${pageInfo.pageNumber}: price-less variant on product "${targetAcc.name}" (ref=${v.reference || '∅'})`);
      }
      const seed = v.reference ? normalizeRef(v.reference) : (targetAcc.key + '|' + normalizeKey(v.name) + '|' + targetAcc.variants.length);
      const variantEntry = {
        id: shortId(seed),
        name: v.name,
        reference: v.reference || null,
        dimensions: v.dimensions || null,
        yardage: v.yardage || null,
        material: v.material || null,
        priceByGrade: { ...(v.priceByGrade || {}) },
        priceFixed: v.priceFixed == null ? null : v.priceFixed,
        sortOrder: targetAcc.variants.length,
        imageFile: null,
      };
      targetAcc.variants.push(variantEntry);
      if (ref) {
        targetAcc.variantRefs.add(ref);
        seenRefs.add(ref);
      } else {
        targetAcc.variantNameKeys.add(dedupeKey);
      }
    }
  }

  // The image pass works off product.pages directly — no need to queue here.
  void imageJobs;
}

function handleMaterialPage(pageInfo, classified, state, materialsByKey, warnings) {
  // Re-key the kind based on current section, since classify can't know it.
  let kind = classified.kind === 'leather-list' ? 'leather'
           : classified.kind === 'outdoor-list' ? 'outdoor-fabric'
           : 'fabric';
  if (state.currentMaterialKind) kind = state.currentMaterialKind;

  if (classified.hints?.legacyTable) {
    const rows = parseLegacyMaterialPage(pageInfo.items, { kind });
    for (const m of rows) {
      const key = `${kind}::${normalizeKey(m.name)}`;
      const existing = materialsByKey.get(key);
      if (existing) {
        existing.pages.add(pageInfo.pageNumber);
        for (const c of m.colors) {
          if (!existing.colors.some((x) => x.code === c.code)) existing.colors.push(c);
        }
        continue;
      }
      materialsByKey.set(key, {
        key,
        kind,
        name: m.name,
        grade: m.grade || null,
        composition: m.composition || null,
        width: m.width || null,
        wear: m.wear || null,
        martindale: m.martindale || null,
        pricePerUnit: m.pricePerUnit ?? null,
        colors: [...m.colors],
        pages: new Set([pageInfo.pageNumber]),
      });
    }
    return;
  }

  const mat = parseSingleFabricPage(pageInfo.items, { kind });
  if (!mat) {
    warnings.push(`p${pageInfo.pageNumber}: material page with no parseable banner`);
    return;
  }
  const key = `${kind}::${normalizeKey(mat.name)}`;
  const existing = materialsByKey.get(key);
  if (existing) {
    existing.pages.add(pageInfo.pageNumber);
    for (const c of mat.colors) {
      if (!existing.colors.some((x) => x.code === c.code)) existing.colors.push(c);
    }
    return;
  }
  materialsByKey.set(key, {
    key,
    kind,
    name: mat.name,
    grade: null,
    composition: null,
    width: null,
    wear: null,
    martindale: null,
    pricePerUnit: null,
    colors: [...mat.colors],
    pages: new Set([pageInfo.pageNumber]),
  });
}

// -- image rendering ---------------------------------------------------------

// Image-extraction pass. For each product, walk its pages and extract the
// LARGEST embedded raster image found. Writes images/<productId>.jpg and
// sets product.heroImageFile. Variants inherit the path at serialization.
// Concurrency = 4.
async function imageExtractionPass(pdf, productsByKey, imagesDir, warnings) {
  const queue = [...productsByKey.values()];
  const workers = new Array(4).fill(null).map(() => worker());
  await Promise.all(workers);

  async function worker() {
    while (queue.length) {
      const product = queue.shift();
      if (!product) return;
      // Try pages in order; collect the largest image across all of them.
      let best = null;
      for (const pageNumber of [...product.pages].sort((a, b) => a - b)) {
        try {
          const page = await pdf.getPage(pageNumber);
          const imgs = await extractPageImages(page);
          for (const img of imgs) {
            const area = img.width * img.height;
            if (!best || area > best.width * best.height) best = img;
          }
        } catch (err) {
          warnings.push(`p${pageNumber}: image scan failed: ${err.message}`);
        }
      }
      if (!best) continue;
      try {
        const productId = shortId(product.key);
        const filename = `${productId}.jpg`;
        const jpg = await rawToJpeg(best, { maxW: 800, maxH: 800, quality: 82 });
        await writeFile(join(imagesDir, filename), jpg);
        product.heroImageFile = `images/${filename}`;
      } catch (err) {
        warnings.push(`product ${product.name}: image encode failed: ${err.message}`);
      }
    }
  }
}

// -- serialisation -----------------------------------------------------------

// Best dimension we can attach to a variant whose own row had none — pick
// from a sibling with the same material first, else from any sibling, else
// fall back to the product's category (which is never empty).
function pickFallbackDimensions(variants, variant) {
  const sameMat = variants.find((v) => v !== variant && v.dimensions && v.material === variant.material);
  if (sameMat) return sameMat.dimensions;
  const any = variants.find((v) => v !== variant && v.dimensions);
  if (any) return any.dimensions;
  return null;
}

// Build a fallback dimensions string for a variant whose own row didn't
// capture H/W/D. Cascade: same-material sibling → any sibling → "—".
function fillDimensions(variants, variant) {
  if (variant.dimensions) return variant.dimensions;
  const sameMat = variants.find((v) => v !== variant && v.dimensions && v.material === variant.material);
  if (sameMat) return sameMat.dimensions;
  const any = variants.find((v) => v !== variant && v.dimensions);
  if (any) return any.dimensions;
  return '—';
}

// Synthesise a reference for a variant whose own row didn't carry one.
// We rely on a stable seed (product key + variant insert order + name)
// so the same input PDF always produces the same synthetic refs.
function fillReference(variant, productKey, index) {
  if (variant.reference) return variant.reference;
  return `${productKey.toUpperCase().replace(/[^A-Z0-9]+/g, '')}-V${index + 1}`;
}

// Per-category fallback hero image. The category-level placeholder ensures
// the variant has a non-empty image path even when its product page has
// no embedded raster. The placeholder file may or may not exist on disk —
// the path is deterministic from the category name.
function fillImageFile(acc, categoryFallbacks) {
  if (acc.heroImageFile) return acc.heroImageFile;
  const cat = (acc.categoryName || 'UNCATEGORIZED').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const fallback = categoryFallbacks.get(cat);
  return fallback || `images/_${cat || 'unknown'}.jpg`;
}

// Cascade for description: product own → important section → category name
// → product name. Never empty.
function fillDescription(acc) {
  if (acc.description) return acc.description;
  if (acc.important) return acc.important;
  const cat = acc.categoryName ? ` (${acc.categoryName})` : '';
  return `${acc.name}${cat}`;
}

function serializeProduct(acc, ctx) {
  const description = fillDescription(acc);
  const imageFile = fillImageFile(acc, ctx.categoryFallbacks);
  const ordered = acc.variants
    .slice()
    .sort((a, b) => {
      const ra = a.reference || '';
      const rb = b.reference || '';
      if (ra && rb) return ra.localeCompare(rb);
      if (ra) return -1;
      if (rb) return 1;
      return a.sortOrder - b.sortOrder;
    });
  const variants = ordered.map((v, i) => {
    const reference = fillReference(v, acc.key, i);
    const dimensions = fillDimensions(ordered, v);
    const seed = v.id || shortId(`${acc.key}|${reference}|${i}`);
    return {
      id: v.id || seed,
      name: v.name,
      reference,
      dimensions,
      yardage: v.yardage,
      material: v.material || null,
      priceByGrade: v.priceByGrade,
      priceFixed: v.priceFixed,
      sortOrder: i,
      description,
      imageFile,
    };
  });
  return {
    id: shortId(acc.key),
    name: (acc.name || '').toString(),
    categoryName: acc.categoryName || null,
    designer: acc.designer || null,
    year: acc.year ?? null,
    description,
    important: acc.important || null,
    impossibilities: [...acc.impossibilities].sort(),
    modelCode: acc.modelCode || null,
    pages: [...acc.pages].sort((a, b) => a - b),
    heroImageFile: acc.heroImageFile || null,
    variants,
  };
}

function serializeMaterial(acc) {
  return {
    id: shortId(acc.key),
    kind: acc.kind,
    name: acc.name,
    grade: acc.grade ?? null,
    composition: acc.composition ?? null,
    width: acc.width ?? null,
    wear: acc.wear ?? null,
    martindale: acc.martindale ?? null,
    pricePerUnit: acc.pricePerUnit ?? null,
    pages: [...acc.pages].sort((a, b) => a - b),
    colors: acc.colors
      .slice()
      .sort((a, b) => (a.code || '').localeCompare(b.code || ''))
      .map((c) => ({ name: c.name, code: c.code, swatchFile: c.swatchFile ?? null })),
  };
}

function countVariants(products) {
  return products.reduce((n, p) => n + p.variants.length, 0);
}

// Stable JSON: keys sorted, 2-space indent, LF line endings.
function stableStringify(value) {
  const seen = new WeakSet();
  const walk = (x) => {
    if (x === null || typeof x !== 'object') return x;
    if (seen.has(x)) throw new Error('cycle');
    seen.add(x);
    if (Array.isArray(x)) return x.map(walk);
    const out = {};
    for (const k of Object.keys(x).sort()) out[k] = walk(x[k]);
    return out;
  };
  return JSON.stringify(walk(value), null, 2);
}

// -- report ------------------------------------------------------------------

class Report {
  constructor() { this.lines = []; }
  add(line) { this.lines.push(line); }
  toString() { return this.lines.join('\n') + '\n'; }
}

async function flushReport(outDir, report, products, materials, warnings, kindCounts, numPages) {
  report.add('');
  report.add('Classified:');
  for (const [k, v] of Object.entries(kindCounts).sort()) report.add(`  ${k}: ${v}`);
  const productPagesUsed = products.reduce((n, p) => n + p.pages.length, 0);
  report.add('');
  report.add(`Products: ${products.length} (deduped from ${productPagesUsed} product pages)`);
  const variantCount = products.reduce((n, p) => n + p.variants.length, 0);
  const refs = new Set();
  let withRef = 0;
  for (const p of products) for (const v of p.variants) {
    if (v.reference) {
      refs.add(v.reference);
      withRef += 1;
    }
  }
  report.add(`Variants: ${variantCount}; with reference: ${withRef}; unique refs: ${refs.size} (${withRef === refs.size ? 'good' : 'COLLISIONS'})`);
  const matByKind = {};
  for (const m of materials) matByKind[m.kind] = (matByKind[m.kind] || 0) + 1;
  report.add(`Materials: ${Object.entries(matByKind).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`);
  report.add('');
  report.add(`Warnings: ${warnings.length}`);
  for (const w of warnings.slice(0, 200)) report.add('  ' + w);
  if (warnings.length > 200) report.add(`  ... +${warnings.length - 200} more`);
  await writeFile(join(outDir, 'report.txt'), report.toString(), 'utf8');
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith('parser/index.js') || process.argv[1]?.endsWith('parser\\index.js')) {
  main().catch((err) => {
    console.error('FATAL:', err?.stack || err);
    process.exit(1);
  });
}
