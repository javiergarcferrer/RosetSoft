/**
 * Parser for the Ligne Roset price-list CSV (the supplier's
 * "LigneRosetPriceList_Profits" export). Pure (only a SKU-splitting helper
 * import) so it can be unit-tested and run client-side when the dealer uploads
 * the file in the Catálogo admin page.
 *
 * Header (case-insensitive, matched by name so column order can shift):
 *   SKU, Description 1, Description 2, Sales Code, Sales Code Description,
 *   Sales Code Divisor, Retail, Cost, Category Code, Category Description, …
 *
 * Retail = list price (USD). Cost = real wholesale cost (USD, = Retail ÷
 * divisor). Description 2 holds the finish plus an H()/D()/S()/W() dimension
 * tail we split apart.
 */
import { splitSkuGrade } from './catalog.js';

export interface ParsedProduct {
  reference: string;
  name: string;
  subtype: string;
  dimensions: string;
  family: string;
  familyCode: string;
  category: string;
  priceUsd: number;
  cost: number;
}

/**
 * RFC-4180 CSV → rows of string cells. Handles quoted fields, embedded commas
 * and newlines, "" escaped quotes, a leading BOM, and CRLF/LF line endings.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Strip a leading UTF-8 BOM if present.
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  // Flush the trailing field/row (file may not end in a newline).
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function num(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Collapse internal whitespace runs to a single space and trim. The Roset list
 * stores model names with double spaces (e.g. `TOGO  FIRESIDE CHAIR`); without
 * this a dealer can only find them by typing the double space, since catalog
 * search is a single-space substring/ilike match.
 */
const squish = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Split a "Description 2" value into the finish/subtype prefix and the
 * dimensions tail. The tail begins at the first dimension token — letters
 * directly followed by "(" and a number, e.g. `H(33)`, `THK(3.25)`. Returns
 * both trimmed; an empty dims string when no token is found.
 */
export function splitDimensions(desc2: string): { subtype: string; dimensions: string } {
  const text = (desc2 || '').trim();
  const m = text.match(/[A-Za-z]+\([\d.]/);
  if (!m || m.index == null) return { subtype: text, dimensions: '' };
  return {
    subtype: text.slice(0, m.index).trim().replace(/[-,\s]+$/, ''),
    dimensions: text.slice(m.index).trim(),
  };
}

/** Build a header→index lookup, lower-cased and trimmed. */
function headerIndex(header: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  header.forEach((h, i) => { map[h.trim().toLowerCase()] = i; });
  return map;
}

/**
 * Parse the full price-list CSV into product rows. Rows without a SKU are
 * skipped. Unknown/missing columns degrade gracefully to empty/0.
 */
export function parsePriceList(text: string): ParsedProduct[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const idx = headerIndex(rows[0]);
  const col = (...names: string[]): number => {
    for (const n of names) {
      const i = idx[n.toLowerCase()];
      if (i != null) return i;
    }
    return -1;
  };
  const cSku = col('sku');
  const cName = col('description 1', 'description1');
  const cDesc2 = col('description 2', 'description2');
  const cFamCode = col('sales code');
  const cFam = col('sales code description');
  const cCat = col('category description');
  const cRetail = col('retail');
  const cCost = col('cost');

  const get = (r: string[], i: number): string => (i >= 0 ? (r[i] || '').trim() : '');

  const out: ParsedProduct[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const reference = get(r, cSku);
    if (!reference) continue;
    const { subtype, dimensions } = splitDimensions(get(r, cDesc2));
    out.push({
      reference,
      name: squish(get(r, cName)),
      subtype: squish(subtype),
      dimensions,
      family: squish(get(r, cFam)),
      familyCode: get(r, cFamCode),
      category: squish(get(r, cCat)),
      priceUsd: num(get(r, cRetail)),
      cost: num(get(r, cCost)),
    });
  }
  return out;
}

/**
 * Collapse rows that share a SKU into one product. The Roset list repeats SKUs
 * (~5500 of 32940 rows): usually byte-identical, sometimes the same article
 * under several layout names at one price, and — for ~95 SKUs — a stale price
 * left over from an earlier list revision (same SKU, two retails, e.g. MOEL
 * ARMCHAIR 10000552H at 6410 once and 7455 twice).
 *
 * A single upsert batch can't touch the same primary key twice, so this dedupe
 * is required before import. The price-conflict case makes "keep the last row"
 * wrong for a pricing tool: it picks an arbitrary (possibly stale, lower)
 * price. Instead, choose the most-frequently-listed price per SKU — the
 * canonical current price — tie-broken to the HIGHEST so a 1-row revision wins
 * and we never quote a stale lower price. Deterministic: the same file always
 * yields the same rows. Returns the chosen occurrence (carrying the matching
 * cost / name / dimensions).
 */
export function dedupeBySku(products: ParsedProduct[]): ParsedProduct[] {
  const groups = new Map<string, ParsedProduct[]>();
  for (const p of products) {
    if (!p.reference) continue;
    const g = groups.get(p.reference);
    if (g) g.push(p);
    else groups.set(p.reference, [p]);
  }
  const out: ParsedProduct[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) { out.push(group[0]); continue; }
    const freq = new Map<number, number>();
    for (const p of group) freq.set(p.priceUsd, (freq.get(p.priceUsd) || 0) + 1);
    let bestPrice = group[0].priceUsd;
    let bestCount = -1;
    for (const [price, count] of freq) {
      if (count > bestCount || (count === bestCount && price > bestPrice)) {
        bestPrice = price;
        bestCount = count;
      }
    }
    out.push(group.find((p) => p.priceUsd === bestPrice) as ParsedProduct);
  }
  return out;
}

/** Longest common leading run of space-delimited words shared by every name. */
function commonPrefixWords(names: string[]): string {
  if (names.length === 0) return '';
  const parts = names.map((n) => n.split(' '));
  const first = parts[0];
  let i = 0;
  while (i < first.length && parts.every((p) => p[i] === first[i])) i++;
  return first.slice(0, i).join(' ');
}

/** Most frequent value; ties broken alphabetically so the result is stable. */
function mostCommon(values: string[]): string {
  const freq = new Map<string, number>();
  for (const v of values) freq.set(v, (freq.get(v) || 0) + 1);
  let best = '';
  let bestN = -1;
  for (const [v, n] of [...freq].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n > bestN) { best = v; bestN = n; }
  }
  return best;
}

/**
 * One name for a split root: the shared COLLECTION (longest common leading
 * words of its parent names) + the accessory DESCRIPTOR (its most-common
 * Description 2 / subtype). Either part may be empty; returns '' only when both
 * are, so the caller then leaves the names as they were.
 */
function unifiedName(names: string[], subtypes: string[]): string {
  const collection = commonPrefixWords(names).trim();
  const descriptor = mostCommon(subtypes.filter(Boolean)).trim();
  const parts: string[] = [];
  if (collection) parts.push(collection);
  if (descriptor && !collection.includes(descriptor)) parts.push(descriptor);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Heal the per-grade NAME drift on accessory SKUs. Ligne Roset stamps a graded
 * add-on (bolster / cushion / base — ~48 SKU roots in the May-2026 list) with
 * whichever PARENT model each grade row was listed against, so one root's grade
 * rows carry several different "Description 1" names — e.g. PRADO's "S/2
 * BOLSTERS" (root 11370022) spreads its 23 grades across PRADO SOFA / SQUARE
 * SETTEE / MEDIUM SOFA. Catalog grouping is by SKU root, so the grades still
 * merge into one model, but `searchProducts` matches on name: a "PRADO SOFA"
 * search surfaces only the 5 rows named that, making the model look like it has
 * 5 grades instead of 23 — and the merged model inherits an arbitrary parent
 * name.
 *
 * Give every grade row of such a root ONE derived name (collection + accessory
 * descriptor) so the model stays whole under any name search and reads as the
 * add-on it is. Roots whose grade rows already agree on a name — every normal
 * upholstered model — are untouched. Pure; meant to run after `dedupeBySku`.
 */
export function unifySplitNames(products: ParsedProduct[]): ParsedProduct[] {
  // Bucket graded SKUs by root (ungraded SKUs are their own root and can't split).
  const byRoot = new Map<string, ParsedProduct[]>();
  for (const p of products) {
    const { root, grade } = splitSkuGrade(p.reference);
    if (!grade) continue;
    const g = byRoot.get(root);
    if (g) g.push(p);
    else byRoot.set(root, [p]);
  }

  // A root needs healing only when its grade rows disagree on the name.
  const rename = new Map<string, string>();
  for (const [root, rows] of byRoot) {
    const names = [...new Set(rows.map((r) => r.name).filter(Boolean))];
    if (names.length <= 1) continue;
    const unified = unifiedName(names, rows.map((r) => r.subtype));
    if (unified) rename.set(root, unified);
  }
  if (rename.size === 0) return products;

  return products.map((p) => {
    const { root, grade } = splitSkuGrade(p.reference);
    const name = grade ? rename.get(root) : undefined;
    return name ? { ...p, name } : p;
  });
}
