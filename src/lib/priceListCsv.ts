/**
 * Parser for the Ligne Roset price-list CSV (the supplier's
 * "LigneRosetPriceList_Profits" export). Pure + dependency-free so it can be
 * unit-tested and run client-side when the dealer uploads the file in the
 * Catálogo admin page.
 *
 * Header (case-insensitive, matched by name so column order can shift):
 *   SKU, Description 1, Description 2, Sales Code, Sales Code Description,
 *   Sales Code Divisor, Retail, Cost, Category Code, Category Description, …
 *
 * Retail = list price (USD). Cost = real wholesale cost (USD, = Retail ÷
 * divisor). Description 2 holds the finish plus an H()/D()/S()/W() dimension
 * tail we split apart.
 */

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
      name: get(r, cName),
      subtype,
      dimensions,
      family: get(r, cFam),
      familyCode: get(r, cFamCode),
      category: get(r, cCat),
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
