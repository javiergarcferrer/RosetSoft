/**
 * Ligne Roset materials PRICE-LIST PDF parser (pure).
 *
 * The price-list PDFs carry exactly what the website lacks — grade, wear rating,
 * Martindale double-rubs, width, PRICE, composition — laid out as a table. We
 * parse that into materials; the website sync supplies colors/swatches (the
 * compound strategy). Colors/notes on the PDF are ignored (the site owns them),
 * which removes the only genuinely ambiguous part (color-name boundaries).
 *
 * Input is normalized text items `{ x, y, str, page }` — the shape both pdfjs
 * (browser) and our test fixtures produce — so this module is pure and
 * unit-tested without a PDF engine.
 *
 * Quirks handled:
 *  - The embedded font ships no ToUnicode map; some extractors return glyph
 *    codes shifted by a constant (e.g. ")$%5,&6" = "FABRICS", +29). We
 *    auto-detect the shift from known header words, so a pre-decoded or a
 *    raw-shifted stream both parse.
 *  - The table shifts horizontally page to page, and leather/outdoor pages use
 *    different labels (Thickness, Price per SM, "OUTDOOR FABRICS"). So columns
 *    are resolved PER PAGE from that page's header row, not hard-coded.
 *  - Each row is anchored by its GRADE cell; the wear rating sits a few points
 *    above the row and the Martindale count below, so a fabric's fields are
 *    gathered from a small vertical window, binned into the page's columns.
 *  - Widths can carry a fraction glyph (54½"). The "/FR" (fire-retardant)
 *    suffix some names carry is dropped.
 */
import type { Material, MaterialCategory, MaterialColor } from '../types/domain';
import { normalizeName } from './lrCatalog';

export interface PdfTextItem {
  x: number;
  y: number;
  str: string;
  /** 0-based page; columns + section are resolved per page. Defaults to 0. */
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

const Y_ROW = 3;     // name shares the grade's visual line
const Y_FIELD = 6;   // wear rating sits a few pt above the row, Martindale below
const GRADE_RE = /^(COM|[A-SU-X])$/;        // alpha A-S, leather U-X, + COM (no T/Y/Z)
const RATING_RE = /^(\d[A-Z]\d?|[A-Z])$/;   // "3C", "2B", "A"
const RUBS_RE = /^\d{3,6}$/;                 // Martindale, e.g. 50000
// Header words present on every table page — used both to detect the cipher
// shift and to resolve the per-page column geometry.
const HEADER_WORDS = ['Composition', 'Grade', 'Name', 'Width', 'Wear'];

/** Apply the constant glyph shift `k` (0 = none, 29 = the LR font cipher). */
function applyShift(s: string, k: number): string {
  if (!k) return s;
  let out = '';
  for (const ch of s) {
    const o = ch.charCodeAt(0);
    // Shift the ASCII range; leave high glyphs (fraction marks, accents) as-is
    // — width parsing only needs to see *some* trailing non-digit.
    out += o <= 126 ? String.fromCharCode(o + k) : ch;
  }
  return out;
}

/** Pick the shift (0 or 29) under which the table's header words appear. */
function detectShift(items: PdfTextItem[]): number {
  for (const k of [0, 29]) {
    let hits = 0;
    for (const it of items) {
      if (HEADER_WORDS.includes(applyShift(it.str, k).trim()) && ++hits >= 2) return k;
    }
  }
  return 0;
}

/** Width/thickness token -> number; any trailing fraction glyph counts as ½. */
function parseMeasure(s: string): number | null {
  const m = s.match(/^(\d+)/);
  if (!m) return null;
  return Number(m[1]) + (s.length > m[1].length ? 0.5 : 0);
}

/** Drop the "/FR" (fire-retardant) suffix the price list appends to some names. */
function cleanName(s: string): string {
  return s.replace(/\s*\/FR\s*$/i, '').replace(/\s+/g, ' ').trim();
}

interface PageColumns {
  category: MaterialCategory;
  nameLeft: number; gradeL: number; gradeR: number;
  wearR: number; widthR: number; priceR: number;
}

/**
 * The section a page belongs to. The label is a full-page sidebar that can sit
 * far left or far right and reads "OUTDOOR FABRICS" / "LEATHER" / "FABRICS".
 */
function pageCategory(pageItems: PdfTextItem[]): MaterialCategory {
  for (const it of pageItems) {
    const u = it.str.toUpperCase();
    if (u.includes('OUTDOOR')) return 'outdoor';
    if (u.includes('LEATHER')) return 'leather';
  }
  return 'fabric';
}

/**
 * Resolve the table's six column x-positions from a page's header row. The
 * layout shifts horizontally from page to page, so we anchor on the header row
 * (Name / Grade / Wear / Width-or-Thickness / Price... / Composition) and take
 * column boundaries as the midpoints between header centers. Returns null for a
 * page with no recognizable header row (cover / notes pages).
 */
function pageColumns(pageItems: PdfTextItem[]): PageColumns | null {
  // Resolve each header by its TOP-MOST matching token. The header band spans a
  // few y (e.g. "Price per yard" rides a line higher than the rest), so we
  // can't pin them to one row; data rows sit well below, so top-most is safe.
  const xOf = (pred: (s: string) => boolean): number | undefined => {
    let best: PdfTextItem | undefined;
    for (const it of pageItems) if (pred(it.str) && (!best || it.y < best.y)) best = it;
    return best?.x;
  };
  const name = xOf((s) => s === 'Name');
  if (name == null) return null;
  const grade = xOf((s) => s === 'Grade');
  const wear = xOf((s) => s === 'Wear');
  const width = xOf((s) => s === 'Width' || s === 'Thickness'); // leather lists Thickness
  const price = xOf((s) => /^Price/.test(s));                   // "Price per yard" / "...SM"
  const comp = xOf((s) => s === 'Composition');
  if (grade == null || wear == null || width == null || price == null || comp == null) return null;
  return {
    category: pageCategory(pageItems),
    nameLeft: name - 22,                  // names start a touch left of the header
    gradeL: (name + grade) / 2,
    gradeR: (grade + wear) / 2,
    wearR: (wear + width) / 2,
    widthR: (width + price) / 2,
    priceR: (price + comp) / 2,
  };
}

/**
 * Parse normalized PDF text items into price-list materials — one entry per
 * fabric / leather / outdoor row. Matched/merged into the catalog by
 * `mergePriceList`.
 */
export function parseMaterialsPdf(rawItems: PdfTextItem[]): ParsedPdfMaterial[] {
  const k = detectShift(rawItems);
  const items: PdfTextItem[] = rawItems
    .map((it) => ({ ...it, page: it.page ?? 0, str: applyShift(it.str, k).trim() }))
    .filter((it) => it.str);

  const pages = new Map<number, PdfTextItem[]>();
  for (const it of items) {
    const arr = pages.get(it.page!);
    if (arr) arr.push(it); else pages.set(it.page!, [it]);
  }

  const out: ParsedPdfMaterial[] = [];
  const byKey = new Map<string, number>(); // (category, normalized name) -> index in out

  for (const pageItems of pages.values()) {
    const col = pageColumns(pageItems);
    if (!col) continue; // no header row => no table on this page

    // Each row is anchored by its GRADE cell — a single grade token in the
    // (per-page) grade column. Colors / Martindale never land a lone A-X there.
    const anchors = pageItems
      .filter((it) => it.x >= col.gradeL && it.x <= col.gradeR && GRADE_RE.test(it.str))
      .sort((a, b) => a.y - b.y);

    anchors.forEach((g, gi) => {
      // Name = the token(s) left of the grade on the grade's own line. Colors
      // live on later lines; the section sidebar sits left of nameLeft.
      const name = cleanName(
        pageItems
          .filter((it) => Math.abs(it.y - g.y) <= Y_ROW && it.x >= col.nameLeft && it.x < col.gradeL)
          .sort((a, b) => a.x - b.x)
          .map((it) => it.str)
          .join(' '),
      );
      if (!name) return; // a stray grade-like token with no name -> not a material

      const near = pageItems.filter((it) => Math.abs(it.y - g.y) <= Y_FIELD);
      const wear = near.filter((it) => it.x > col.gradeR && it.x <= col.wearR);
      const wearRating = wear.find((it) => RATING_RE.test(it.str))?.str ?? null;
      const rubsTok = wear.find((it) => RUBS_RE.test(it.str))?.str;
      const widthTok = near.find((it) => it.x > col.wearR && it.x <= col.widthR && /^\d/.test(it.str))?.str;
      const priceTok = near.find((it) => it.x > col.widthR && it.x <= col.priceR && /^\d/.test(it.str))?.str;

      // Composition: the right column on the row + any wrap lines down to (just
      // short of) the next row's grade.
      const nextY = anchors[gi + 1]?.y ?? Infinity;
      const composition =
        pageItems
          .filter((it) => it.x >= col.priceR && it.y >= g.y - 2 && it.y < nextY - 2)
          .sort((a, b) => (a.y - b.y) || (a.x - b.x))
          .map((it) => it.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim() || null;

      const rec: ParsedPdfMaterial = {
        name,
        category: col.category,
        grade: g.str,
        wearRating,
        wearDoubleRubs: rubsTok ? Number(rubsTok) : null,
        measure: widthTok ? parseMeasure(widthTok) : null,
        measureUnit: col.category === 'leather' ? 'mm' : 'in',
        price: priceTok ? Number(priceTok.match(/^(\d+)/)![1]) : null,
        priceUnit: col.category === 'leather' ? 'sm' : 'yard',
        composition,
      };

      // Identity is (category, name) — the catalog's unique key — so the same
      // name appearing in two sections (e.g. ROMA as both a fabric and an
      // outdoor sling) is kept as two materials; a real repeat within one
      // category takes the last reading.
      const key = `${rec.category} ${normalizeName(rec.name)}`;
      const at = byKey.get(key);
      if (at != null) out[at] = rec;
      else { byKey.set(key, out.length); out.push(rec); }
    });
  }

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
  /** Stale /FR-vs-clean duplicates folded into one row and removed. */
  consolidated: number;
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
 * The catalog's identity key — the SAME shape as the
 * `(profile_id, category, lower(name))` unique index. Keying the merge off this
 * (not name alone) is what lets a name that legitimately exists in two
 * categories coexist, and guarantees the merge never emits two rows that
 * collide on the index.
 */
function materialKey(category: string, name: string): string {
  return `${category} ${normalizeName(name)}`;
}

/** Union a group of duplicate materials' colors by code, keeping any photo. */
function mergeColors(group: Material[]): MaterialColor[] {
  const byCode = new Map<string, MaterialColor>();
  const noCode: MaterialColor[] = [];
  for (const m of group) {
    for (const c of m.colors || []) {
      const code = (c.code || '').trim();
      if (!code) { noCode.push({ ...c }); continue; }
      const ex = byCode.get(code);
      if (!ex) byCode.set(code, { ...c });
      else if (!ex.imageId && c.imageId) byCode.set(code, { ...c }); // prefer the one with a photo
    }
  }
  return [...byCode.values(), ...noCode];
}

/**
 * Merge parsed price-list materials into the catalog. The price list is the
 * source of truth for commercial spec — name, category, grade, wear, Martindale,
 * width, price, composition — and OWNS those fields. It preserves everything the
 * website owns: colors (and their uploaded photos) and care notes. A material
 * the list carries is a current product, so its "no en sitio" (`discontinuedAt`)
 * flag is cleared. Nothing is deleted (stale /FR duplicates are consolidated);
 * on a complete import, materials not in the price list are flagged
 * `notInPricelistAt` (and un-flagged if they return). Pure + idempotent.
 */
export function mergePriceList(
  existing: Material[],
  parsed: ParsedPdfMaterial[],
  { profileId, now, newId, complete = false }: PriceListMergeContext,
): { rows: Material[]; deleteIds: string[]; summary: PriceListSummary } {
  // Group existing materials by (category, /FR-insensitive name). The catalog
  // can carry stale duplicates of one material (a website-clean "APPA" plus an
  // older PDF-made "APPA/FR"); grouping lets us consolidate them into one row.
  const groups = new Map<string, Material[]>();
  for (const m of existing) {
    const k = materialKey(m.category, m.name);
    const g = groups.get(k);
    if (g) g.push(m); else groups.set(k, [m]);
  }

  const rows: Material[] = [];
  const deleteIds: string[] = [];
  const matched = new Set<string>(); // existing ids the price list accounts for
  const summary: PriceListSummary = {
    newMaterials: 0, updatedMaterials: 0, unchangedMaterials: 0,
    flaggedMissing: 0, restored: 0, consolidated: 0,
  };

  for (const p of parsed) {
    if (!normalizeName(p.name)) continue;
    const group = groups.get(materialKey(p.category, p.name));

    if (!group || !group.length) {
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

    // The row to keep: an exact name match if present (avoids a needless
    // rename), else the richest (most colors/photos). Anything else in the
    // group is a stale duplicate to fold in and delete.
    const primary =
      group.find((m) => m.name === p.name) ??
      group.slice().sort((a, b) => (b.colors?.length || 0) - (a.colors?.length || 0))[0];
    for (const m of group) matched.add(m.id);
    const redundant = group.filter((m) => m.id !== primary.id);

    const wasFlagged = primary.notInPricelistAt != null;
    const colors = redundant.length ? mergeColors(group) : (primary.colors || []);
    const next: Material = {
      ...primary,
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
      colors,
      notInPricelistAt: null,
      // In the price list ⇒ a current product, so it can't be "no en sitio".
      discontinuedAt: null,
      updatedAt: now,
    };
    const changed =
      redundant.length > 0 ||
      wasFlagged ||
      primary.discontinuedAt != null ||
      (primary.name ?? '') !== p.name ||
      primary.category !== p.category ||
      PDF_FIELDS.some((f) => (primary[f] ?? null) !== (p[f] ?? null));

    if (changed) {
      rows.push(next);
      summary.updatedMaterials += 1;
      if (wasFlagged) summary.restored += 1;
    } else {
      summary.unchangedMaterials += 1;
    }
    for (const r of redundant) { deleteIds.push(r.id); summary.consolidated += 1; }
  }

  if (complete) {
    for (const m of existing) {
      if (matched.has(m.id)) continue;
      if (m.notInPricelistAt == null) {
        rows.push({ ...m, notInPricelistAt: now, updatedAt: now });
        summary.flaggedMissing += 1;
      } else {
        summary.unchangedMaterials += 1;
      }
    }
  }

  return { rows, deleteIds, summary };
}
