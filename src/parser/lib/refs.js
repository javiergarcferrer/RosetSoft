// 8-character SKU references found across the catalog.
//
//   11370720  — pure digit (seats, tables, lighting, …)
//   0XFGPC10  — alphanumeric (cabinetry)
//   00F0HA30  — alphanumeric (cabinetry)
//
// We exclude generic uppercase tokens by requiring a leading digit.

export const REF_RE = /\b(?:\d{8}|0[0-9A-Z]{7})\b/g;
export const REF_FULLMATCH = /^(?:\d{8}|0[0-9A-Z]{7})$/;
export const YEAR_RE = /^[12]\d{3}$/;

/** Walk a product's page range, collect every ref in source order, dedupe. */
export async function harvestRefs(doc, product) {
  const refs = [];
  const seen = new Set();
  for (let pno = product.page_start; pno <= Math.min(product.page_end, doc.numPages); pno++) {
    const page = await doc.getPage(pno);
    const tc = await page.getTextContent({ includeMarkedContent: false });
    const text = tc.items.map((it) => it.str).join(' ');
    let m;
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(text)) !== null) {
      const r = m[0];
      if (!seen.has(r)) {
        seen.add(r);
        refs.push(r);
      }
    }
  }
  return refs;
}
