// Build (category, product) lists from the PDF's ToC plus the printed index.
//
// The Python parser combines two signals:
//   1. The PDF's built-in outline (`doc.get_toc(simple=False)`) gives the
//      structural tree: level 1 = category, level 2 = product, with page
//      numbers. Some entries come back with page=0/1 when the destination
//      is a multi-product summary page.
//   2. The catalog's printed index on pages 3-12 lists every product with
//      its real start page, in document order. We use it as a cursor to
//      repair the broken page=0 entries.
//
// The result: `{ categories, products }` arrays. Categories carry a
// page_start/end range covering all their products; products carry a
// page_start/end range covering their own spread (intro pages + tables).

import { readPageSpans, getTocFromOutline } from './readSpans.js';
import { replacePlaceholders, slugify } from './nameFixes.js';

const INDEX_PATTERN = /^([A-Z0-9 /\-&_À-ſ?.]+?)\s*\.{2,}\s*(\d{2,3})\s*$/;

/**
 * Scan the printed index pages for "NAME....PAGE" lines.
 * Default scan range matches the Python parser's (pages 3-12 inclusive).
 */
export async function readIndexEntries(doc, { from = 3, to = 12 } = {}) {
  const entries = [];
  const total = doc.numPages;
  const end = Math.min(to, total);
  for (let pno = from; pno <= end; pno++) {
    const page = await doc.getPage(pno);
    const tc = await page.getTextContent({ includeMarkedContent: false });
    // The index lines wrap "NAME" + dots + "PAGE" across multiple text items
    // depending on the font. Collapse the page's content into a single big
    // string with rough line breaks and then regex over the lines.
    //
    // pdf.js doesn't emit \n between items; we use `hasEOL` when present, else
    // group by similar y-coordinate.
    const viewport = page.getViewport({ scale: 1.0 });
    const items = tc.items.map((it) => ({
      str: it.str || '',
      eol: !!it.hasEOL,
      y: Math.round((viewport.height - it.transform[5]) * 10) / 10,
    }));

    // Group items into lines.
    const lines = [];
    let cur = { y: null, parts: [] };
    for (const it of items) {
      if (cur.y == null) cur.y = it.y;
      const newLine = it.eol || Math.abs(it.y - cur.y) > 4;
      if (newLine && cur.parts.length) {
        lines.push(cur.parts.join('').trim());
        cur = { y: it.y, parts: [it.str] };
      } else {
        cur.parts.push(it.str);
      }
    }
    if (cur.parts.length) lines.push(cur.parts.join('').trim());

    for (const ln of lines) {
      const m = INDEX_PATTERN.exec(ln);
      if (!m) continue;
      const name = m[1].trim();
      if (!/[A-Z]/.test(name) || name.length > 60) continue;
      entries.push({ name, page: Number(m[2]) });
    }
  }
  return entries;
}

/**
 * Combine the outline + index to produce (categories, products), each with
 * a page_start / page_end range.
 */
export async function loadCategoriesAndProducts(doc) {
  const toc = await getTocFromOutline(doc);
  const indexEntries = await readIndexEntries(doc);

  // Repair page=0/1 entries by walking the index in order.
  let cursor = 0;
  function advanceTo(name) {
    for (let i = cursor; i < indexEntries.length; i++) {
      if (indexEntries[i].name === name) {
        cursor = i + 1;
        return indexEntries[i].page;
      }
    }
    return null;
  }

  const flat = [];
  for (const entry of toc) {
    let page = entry.page;
    if (page <= 1) {
      const recovered = advanceTo(entry.title);
      if (recovered != null) page = recovered;
    } else {
      // Keep cursor synced when an entry's page already matches an index row.
      for (let i = cursor; i < indexEntries.length; i++) {
        if (indexEntries[i].name === entry.title && indexEntries[i].page === page) {
          cursor = i + 1;
          break;
        }
      }
    }
    flat.push({ level: entry.level, title: entry.title, page_start: page });
  }

  // Compute page_end: the page just before the next entry at the same or
  // shallower level (or doc end).
  const totalPages = doc.numPages;
  for (let i = 0; i < flat.length; i++) {
    const e = flat[i];
    let end = totalPages;
    for (let j = i + 1; j < flat.length; j++) {
      if (flat[j].level <= e.level) {
        end = flat[j].page_start - 1;
        break;
      }
    }
    if (end < e.page_start) end = e.page_start;
    e.page_end = end;
  }

  // Materialise categories + products.
  const categories = [];
  const products = [];
  let catId = 0;
  let prodId = 0;
  let currentCat = null;
  for (const e of flat) {
    if (e.level === 1) {
      catId++;
      currentCat = {
        id: catId,
        name: replacePlaceholders(e.title),
        page_start: e.page_start,
        page_end: e.page_end,
      };
      categories.push(currentCat);
    } else if (e.level === 2 && currentCat) {
      prodId++;
      const nameClean = replacePlaceholders(e.title);
      products.push({
        id: prodId,
        category_id: currentCat.id,
        name_raw: e.title,
        name: nameClean,
        slug: slugify(nameClean),
        page_start: e.page_start,
        page_end: e.page_end,
        designer: null,
        year: null,
        code: null,
        important: null,
        description: null,
        technical_notes: null,
        compatible_materials: [],
        references: [],
      });
    }
  }
  return { categories, products };
}
