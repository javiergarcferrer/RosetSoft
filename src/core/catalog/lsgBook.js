// ViewModels for the LifestyleGarden catalog surfaces — the MODEL grouping the
// admin browser renders (pages/admin/CatalogLifestyleGarden.jsx) and the
// client-facing catalog book the PDF prints (src/pdf/catalog). Pure: product
// rows in, projection out — no React, no db.
//
// A MODEL is one Shopify product: the import (shopify-sync/catalogImport.ts)
// writes one `products` row per VARIANT and keys siblings together by
// `familyCode` (the product handle), with the variant axis alone in `subtype`.

/**
 * The Shopify-product title behind a row — the row's `name` minus the
 * " · variant" suffix the import appends (subtype carries the variant alone),
 * so a multi-variant product folds back into ONE model header.
 */
export function lsgModelTitle(p) {
  const name = p.name || p.reference || '—';
  const v = p.subtype || '';
  return v && name.endsWith(` · ${v}`) ? name.slice(0, name.length - v.length - 3) : name;
}

/**
 * Group LSG rows into MODELS — one per Shopify product (familyCode = handle).
 * Members sorted cheap→dear, models alphabetized.
 */
export function groupLsgModels(products) {
  const byHandle = new Map();
  for (const p of products || []) {
    const key = p.familyCode || p.id;
    const m = byHandle.get(key);
    if (m) m.members.push(p);
    else byHandle.set(key, { key, name: lsgModelTitle(p), members: [p] });
  }
  const models = [...byHandle.values()];
  for (const m of models) {
    m.members.sort((a, b) => (Number(a.priceUsd) || 0) - (Number(b.priceUsd) || 0));
  }
  return models.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
}

// Empty categories sort last (the "Sin colección" bucket).
function sortCat(a, b) {
  if (!a && b) return 1;
  if (a && !b) return -1;
  return (a || '').localeCompare(b || '', 'es', { sensitivity: 'base' });
}

/**
 * The catalog BOOK the client PDF prints: ONLY pieces in stock (stockQty > 0),
 * grouped by collection, one card per model with its in-stock variants.
 *
 * `hasStockData` guards the pre-stock state: rows imported before the
 * stock_qty column ship null everywhere — rendering "everything is sold out"
 * would be a lie, so the caller must ask for a fresh Shopify sync instead.
 * Once any row carries a real figure, the > 0 filter is exact: out-of-stock
 * variants drop from their model and stockless models drop entirely.
 *
 * Each model carries the lead (cheapest in-stock) member's photo pointers,
 * `stockQty` (the sum over its in-stock members), a `priceMin`/`priceMax` USD
 * range, and the store URL its card links to.
 */
export function resolveLsgCatalogBook(products) {
  const rows = (products || []).filter((p) => p && p.active !== false);
  const hasStockData = rows.some((p) => p.stockQty != null);
  const inStock = hasStockData ? rows.filter((p) => Number(p.stockQty) > 0) : [];

  const byCategory = new Map();
  for (const p of inStock) {
    const key = (p.category || '').trim();
    const bucket = byCategory.get(key);
    if (bucket) bucket.push(p);
    else byCategory.set(key, [p]);
  }

  let skus = 0;
  let modelCount = 0;
  const sections = [...byCategory.entries()]
    .map(([category, items]) => {
      const models = groupLsgModels(items).map((m) => {
        const lead = m.members[0] || {};
        const prices = m.members.map((x) => Number(x.priceUsd) || 0).filter((n) => n > 0);
        return {
          ...m,
          family: lead.family || '',
          storeUrl: lead.familyCode ? `https://www.lifestylegarden.do/products/${lead.familyCode}` : null,
          imageId: lead.imageId || null,
          imageSrc: lead.imageSrc || '',
          stockQty: m.members.reduce((n, x) => n + (Number(x.stockQty) || 0), 0),
          priceMin: prices.length ? Math.min(...prices) : null,
          priceMax: prices.length ? Math.max(...prices) : null,
        };
      });
      skus += items.length;
      modelCount += models.length;
      return { category, models };
    })
    .sort((a, b) => sortCat(a.category, b.category));

  return { hasStockData, sections, models: modelCount, skus };
}
