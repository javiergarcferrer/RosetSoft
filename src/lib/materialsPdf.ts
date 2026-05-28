/**
 * Ligne Roset materials PRICE-LIST PDF parser (pure).
 *
 * The price-list PDFs carry exactly what the website lacks — grade, wear rating,
 * Martindale double-rubs, width, per-yard PRICE, composition — laid out as a
 * table. We parse that into materials; the website sync supplies colors/swatches
 * (the compound strategy). Colors/notes on the PDF are ignored (the site owns
 * them), which removes the only genuinely ambiguous part (color-name boundaries).
 *
 * Input is normalized text items `{ x, y, str, bold, page }` — the shape both
 * pdfjs (browser) and our test fixture produce — so this module is pure and
 * unit-tested without a PDF engine.
 *
 * Quirks handled:
 *  - The embedded font ships no ToUnicode map; some extractors return glyph
 *    codes shifted by a constant (e.g. ")$%5,&6" = "FABRICS", +29). We
 *    auto-detect the shift from known header words, so a pre-decoded or a
 *    raw-shifted stream both parse.
 *  - Each fabric is anchored by its BOLD name; the wear rating sits a few points
 *    ABOVE the name and the Martindale count a few points BELOW — so we gather a
 *    fabric's fields from a small vertical window around the name, binned by
 *    column x. PRICE is the bold token in the price column.
 *  - Widths can carry a ½ glyph (54½").
 */
import type { Material, MaterialCategory } from '../types/domain';
import { normalizeName } from './lrCatalog';

export interface PdfTextItem {
  x: number;
  y: number;
  str: string;
  bold: boolean;
  /** 0-based page; used to scope section tracking. Defaults to 0. */
  page?: number;
}

export interface ParsedPdfMaterial {
  name: string;
  category: MaterialCategory;
  grade: string | null;
  wearRating: string | null;
  wearDoubleRubs: number | null;
  measure: number | null;
  measureUnit: 'in' | 'mm';
  price: number | null;
  priceUnit: 'yard' | 'sm';
  composition: string | null;
}

// Column x-bands for the LR price-list table (points). Stable for this format;
// re-tune if Ligne Roset changes the layout.
const COL = {
  name: [78, 145],
  grade: [146, 167],
  wear: [167, 205],
  width: [205, 231],
  price: [231, 284],
  comp: 285, // composition is everything from here rightward
} as const;

const Y_WINDOW = 6;     // vertical reach around a name to collect its row fields
const SECTION = new Set(['FABRICS', 'LEATHER', 'OUTDOOR']);
const SECTION_CAT: Record<string, MaterialCategory> = { FABRICS: 'fabric', LEATHER: 'leather', OUTDOOR: 'outdoor' };
const GRADE_RE = /^(COM|[A-R]|S)$/;
const RATING_RE = /^(\d[A-Z]\d?|[A-Z])$/;   // "3C", "2B", "A"
const RUBS_RE = /^\d{3,6}$/;                 // Martindale, e.g. 50000
const NAME_RE = /^[A-Z][A-Z0-9][A-Z0-9 ./-]*$/;
const NAME_STOP = new Set(['USD', 'USA', 'AMERICAN', 'EUROPEAN', 'NAME', 'GRADE', 'WEAR', 'WIDTH', 'PRICE', 'COMPOSITION']);

function inBand(x: number, band: readonly [number, number]): boolean {
  return x >= band[0] && x <= band[1];
}

/** Apply the constant glyph shift `k` (0 = none, 29 = the LR font cipher). */
function applyShift(s: string, k: number): string {
  if (!k) return s;
  let out = '';
  for (const ch of s) {
    const o = ch.charCodeAt(0);
    if (o <= 126) out += String.fromCharCode(o + k);
    else if (o >= 0xf0 && o <= 0xf3) out += '½';
    // other rare high glyphs (stray markers) are dropped
  }
  return out;
}

/** Pick the shift (0 or 29) under which known header words appear. */
function detectShift(items: PdfTextItem[]): number {
  for (const k of [0, 29]) {
    let hits = 0;
    for (const it of items) {
      const s = applyShift(it.str, k).trim();
      if (SECTION.has(s) || s === 'Composition' || s === 'Grade') {
        if (++hits >= 2) return k;
      }
    }
  }
  return 0;
}

/** Parse a width token like "54", "54½" → inches (54, 54.5). */
function parseWidth(s: string): number | null {
  const m = s.match(/^(\d+)/);
  if (!m) return null;
  return Number(m[1]) + (/½/.test(s) ? 0.5 : 0);
}

/**
 * Parse normalized PDF text items into price-list materials. One entry per
 * fabric; matched/merged into the catalog by `mergePriceList`.
 */
export function parseMaterialsPdf(rawItems: PdfTextItem[]): ParsedPdfMaterial[] {
  const k = detectShift(rawItems);
  const items: PdfTextItem[] = rawItems.map((it) => ({
    ...it,
    page: it.page ?? 0,
    str: applyShift(it.str, k).trim(),
  })).filter((it) => it.str);

  // Section headers (FABRICS/LEATHER/OUTDOOR) sit at the far left; a fabric's
  // category is the nearest header at or above it on the same page.
  const headers = items
    .filter((it) => it.x < 45 && SECTION.has(it.str))
    .map((it) => ({ page: it.page!, y: it.y, cat: SECTION_CAT[it.str] }));
  const categoryFor = (page: number, y: number): MaterialCategory => {
    let cat: MaterialCategory = 'fabric';
    for (const h of headers) if (h.page === page && h.y <= y + 2) cat = h.cat;
    return cat;
  };

  // Each fabric row is anchored by its GRADE cell — a single grade token in a
  // tight column. This needs no font-weight info (pdfjs doesn't expose it
  // cleanly) and colors never land a single A–S token in the grade column.
  const gradeAnchors = items
    .filter((it) => inBand(it.x, COL.grade) && GRADE_RE.test(it.str))
    .sort((a, b) => (a.page! - b.page!) || (a.y - b.y));

  const out: ParsedPdfMaterial[] = [];
  const byName = new Map<string, number>(); // normalized name → index in out

  gradeAnchors.forEach((g, gi) => {
    const page = g.page!;
    const near = items.filter((it) => it.page === page && Math.abs(it.y - g.y) <= Y_WINDOW);

    // Name shares the grade's line; join any split spans left→right.
    const name = items
      .filter((it) => it.page === page && Math.abs(it.y - g.y) <= 2 &&
        inBand(it.x, COL.name) && NAME_RE.test(it.str) && !NAME_STOP.has(it.str))
      .sort((a, b) => a.x - b.x)
      .map((it) => it.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!name) return; // a stray grade-like token with no name → not a fabric

    const wearTokens = near.filter((it) => inBand(it.x, COL.wear));
    const wearRating = wearTokens.find((it) => RATING_RE.test(it.str))?.str ?? null;
    const rubsTok = wearTokens.find((it) => RUBS_RE.test(it.str))?.str;
    const wearDoubleRubs = rubsTok ? Number(rubsTok) : null;

    const widthTok = near.find((it) => inBand(it.x, COL.width) && /^\d/.test(it.str))?.str;
    const measure = widthTok ? parseWidth(widthTok) : null;

    const priceTok = near.find((it) => inBand(it.x, COL.price) && /^\d/.test(it.str))?.str;
    const price = priceTok ? Number(priceTok.match(/^(\d+)/)![1]) : null;

    // Composition: the right column on the row, plus any wrap lines (x ≥ comp)
    // down to the next fabric on this page.
    // The next fabric's composition baseline sits a hair ABOVE its grade, so
    // stop a couple of points short of the next grade to avoid swallowing it.
    const nextY = gradeAnchors[gi + 1]?.page === page ? gradeAnchors[gi + 1].y : Infinity;
    const composition =
      items
        .filter((it) => it.page === page && it.x >= COL.comp && it.y >= g.y - 2 && it.y < nextY - 2)
        .sort((p, q) => (p.y - q.y) || (p.x - q.x))
        .map((it) => it.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim() || null;

    const category = categoryFor(page, g.y);
    const rec: ParsedPdfMaterial = {
      name,
      category,
      grade: g.str,
      wearRating,
      wearDoubleRubs,
      measure,
      measureUnit: category === 'leather' ? 'mm' : 'in',
      price,
      priceUnit: category === 'leather' ? 'sm' : 'yard',
      composition,
    };

    // A fabric can recur across sections (e.g. fabric + outdoor) — last,
    // more-specific section wins.
    const key = normalizeName(rec.name);
    const seenAt = byName.get(key);
    if (seenAt != null) out[seenAt] = rec;
    else { byName.set(key, out.length); out.push(rec); }
  });

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Merge price-list materials into the catalog                               */
/* -------------------------------------------------------------------------- */

export interface PriceListSummary {
  newMaterials: number;
  updatedMaterials: number;
  unchangedMaterials: number;
  flaggedMissing: number;
  restored: number;
}

export interface PriceListMergeContext {
  profileId: string;
  now: number;
  newId: () => string;
  /**
   * True when `parsed` represents the COMPLETE price list (all PDFs uploaded
   * together), so existing materials absent from it can be flagged
   * `notInPricelistAt`. False for a single-file import.
   */
  complete?: boolean;
}

const PDF_FIELDS = [
  'grade', 'wearRating', 'wearDoubleRubs', 'measure', 'measureUnit', 'price', 'priceUnit', 'composition',
] as const;

/**
 * Merge parsed price-list materials into the catalog. The price list is the
 * source of truth for commercial spec — name, category, grade, wear, Martindale,
 * width, price, composition — and OWNS those fields. It preserves everything the
 * website owns: colors (and their uploaded photos), care notes, and the
 * website's `discontinuedAt` flag. Nothing is deleted; on a complete import,
 * materials not in the price list are flagged `notInPricelistAt` (and un-flagged
 * if they return). Pure + idempotent.
 */
export function mergePriceList(
  existing: Material[],
  parsed: ParsedPdfMaterial[],
  { profileId, now, newId, complete = false }: PriceListMergeContext,
): { rows: Material[]; summary: PriceListSummary } {
  const byName = new Map<string, Material>();
  for (const m of existing) byName.set(normalizeName(m.name), m);

  const rows: Material[] = [];
  const seen = new Set<string>();
  const summary: PriceListSummary = {
    newMaterials: 0, updatedMaterials: 0, unchangedMaterials: 0, flaggedMissing: 0, restored: 0,
  };

  for (const p of parsed) {
    const key = normalizeName(p.name);
    if (!key) continue;
    seen.add(key);
    const current = byName.get(key);

    if (!current) {
      rows.push({
        id: newId(),
        profileId,
        category: p.category,
        name: p.name,
        grade: p.grade,
        wearRating: p.wearRating,
        wearDoubleRubs: p.wearDoubleRubs,
        measure: p.measure,
        measureUnit: p.measureUnit,
        price: p.price,
        priceUnit: p.priceUnit,
        composition: p.composition,
        colors: [],
        notes: null,
        discontinuedAt: null,
        notInPricelistAt: null,
        createdAt: now,
        updatedAt: now,
      });
      summary.newMaterials += 1;
      continue;
    }

    const wasFlagged = current.notInPricelistAt != null;
    const changed =
      (current.name ?? '') !== p.name ||
      current.category !== p.category ||
      PDF_FIELDS.some((f) => (current[f] ?? null) !== (p[f] ?? null)) ||
      wasFlagged;

    if (changed) {
      rows.push({
        ...current,
        name: p.name,
        category: p.category,
        grade: p.grade,
        wearRating: p.wearRating,
        wearDoubleRubs: p.wearDoubleRubs,
        measure: p.measure,
        measureUnit: p.measureUnit,
        price: p.price,
        priceUnit: p.priceUnit,
        composition: p.composition,
        notInPricelistAt: null,
        updatedAt: now,
      });
      summary.updatedMaterials += 1;
      if (wasFlagged) summary.restored += 1;
    } else {
      summary.unchangedMaterials += 1;
    }
  }

  if (complete) {
    for (const m of existing) {
      if (seen.has(normalizeName(m.name))) continue;
      if (m.notInPricelistAt == null) {
        rows.push({ ...m, notInPricelistAt: now, updatedAt: now });
        summary.flaggedMissing += 1;
      } else {
        summary.unchangedMaterials += 1;
      }
    }
  }

  return { rows, summary };
}
