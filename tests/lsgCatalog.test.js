/**
 * Tests for supabase/functions/shopify-sync/catalogImport.ts — the pure
 * mapping from the team's Shopify store (www.lifestylegarden.do) to
 * `products` rows, brand 'lifestylegarden'. Pins the data-integrity rules the
 * import must keep: the inventory-mirror products this same function PUBLISHES
 * never feed back in, only ACTIVE products import, references stay unique, and
 * category/family come from the range collection named in the title.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mapShopifyCatalog, rangeOf, imageSrcOf, galleryOf, GALLERY_MAX, LSG_BRAND } from '../supabase/functions/shopify-sync/catalogImport.ts';

const CTX = { profileId: 'team', nowIso: '2026-06-11T12:00:00.000Z' };

const collections = (...titles) => ({ nodes: titles.map((title) => ({ title })) });

function product(over = {}) {
  return {
    id: 'gid://shopify/Product/7278853587046',
    title: 'Garnet Lounge Chair - Copen Blue',
    handle: 'garnet-lounge-chair-copen-blue',
    productType: '',
    status: 'ACTIVE',
    collections: collections('Garnet', 'Plazas', 'Sets'),
    variants: { nodes: [defaultVariant()] },
    ...over,
  };
}

function defaultVariant(over = {}) {
  return {
    id: 'gid://shopify/ProductVariant/41476206493798',
    title: 'Default Title',
    sku: '7166540001, 8104379000',
    price: '988.20',
    inventoryQuantity: 4,
    inventoryItem: { unitCost: null },
    ...over,
  };
}

/* --------------------------------- mapping --------------------------------- */

test('maps an active default-variant product to one catalog row', () => {
  const { rows, summary } = mapShopifyCatalog([product()], CTX);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: 'lsg-41476206493798',
    profile_id: 'team',
    brand: LSG_BRAND,
    reference: '7166540001, 8104379000',
    name: 'Garnet Lounge Chair - Copen Blue',
    subtype: '',
    dimensions: '',
    family: 'Garnet',
    family_code: 'garnet-lounge-chair-copen-blue',
    category: 'Garnet',
    price_usd: 988.2,
    cost: null,
    stock_qty: 4,
    image_src: '',
    image_srcs: [],
    active: true,
    updated_at: CTX.nowIso,
  });
  assert.equal(summary.products, 1);
});

/* ---------------------------------- photos ---------------------------------- */

const media = (url) => ({ nodes: [{ preview: { image: { url } } }] });

test('a variant’s own photo wins; the product featured one is the fallback', () => {
  const featured = { preview: { image: { url: 'https://cdn.shopify.com/p/featured.jpg' } } };
  // Variant carries its own media → that photo.
  assert.equal(
    imageSrcOf({ featuredMedia: featured }, { media: media('https://cdn.shopify.com/v/own.jpg') }),
    'https://cdn.shopify.com/v/own.jpg',
  );
  // No variant media → the product's featured photo.
  assert.equal(imageSrcOf({ featuredMedia: featured }, { media: { nodes: [] } }), 'https://cdn.shopify.com/p/featured.jpg');
  // No photos anywhere → empty (the card shows the placeholder).
  assert.equal(imageSrcOf({ featuredMedia: null }, {}), '');
});

test('mapped rows carry image_src(s) but NEVER pointer ids (the pointer pass owns them)', () => {
  const { rows } = mapShopifyCatalog([product({
    featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/p/garnet.jpg' } } },
  })], CTX);
  assert.equal(rows[0].image_src, 'https://cdn.shopify.com/p/garnet.jpg');
  assert.deepEqual(rows[0].image_srcs, ['https://cdn.shopify.com/p/garnet.jpg']);
  // An upsert with these present would clobber the CDN pointers.
  assert.ok(!('image_id' in rows[0]));
  assert.ok(!('extra_image_ids' in rows[0]));
});

test('galleryOf: the variant cover leads, the product media follow, deduped', () => {
  const p = {
    featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/p/1.jpg' } } },
    media: { nodes: [
      { preview: { image: { url: 'https://cdn.shopify.com/p/1.jpg' } } },   // featured repeats in media
      { preview: { image: { url: 'https://cdn.shopify.com/p/2.jpg' } } },
      { preview: { image: { url: 'https://cdn.shopify.com/v/own.jpg' } } }, // the variant's shot, again
      { preview: { image: { url: '' } } },                                  // empty url drops
    ] },
  };
  assert.deepEqual(galleryOf(p, { media: media('https://cdn.shopify.com/v/own.jpg') }), [
    'https://cdn.shopify.com/v/own.jpg',
    'https://cdn.shopify.com/p/1.jpg',
    'https://cdn.shopify.com/p/2.jpg',
  ]);
  // No variant shot → the featured one leads (= image_src parity).
  assert.deepEqual(galleryOf(p, { media: { nodes: [] } }), [
    'https://cdn.shopify.com/p/1.jpg',
    'https://cdn.shopify.com/p/2.jpg',
    'https://cdn.shopify.com/v/own.jpg',
  ]);
  // No photos at all → empty gallery (the card shows the placeholder).
  assert.deepEqual(galleryOf({ featuredMedia: null, media: null }, {}), []);
});

test('galleryOf caps at GALLERY_MAX so a 40-shot product can’t bloat the row', () => {
  const nodes = Array.from({ length: GALLERY_MAX + 5 }, (_, i) => (
    { preview: { image: { url: `https://cdn.shopify.com/p/${i}.jpg` } } }
  ));
  const out = galleryOf({ featuredMedia: null, media: { nodes } }, {});
  assert.equal(out.length, GALLERY_MAX);
  assert.equal(out[0], 'https://cdn.shopify.com/p/0.jpg');
});

test('mapped rows: image_src is always image_srcs[0]', () => {
  const { rows } = mapShopifyCatalog([product({
    featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/p/cover.jpg' } } },
    media: { nodes: [{ preview: { image: { url: 'https://cdn.shopify.com/p/extra.jpg' } } }] },
  })], CTX);
  assert.equal(rows[0].image_src, rows[0].image_srcs[0]);
  assert.deepEqual(rows[0].image_srcs, [
    'https://cdn.shopify.com/p/cover.jpg',
    'https://cdn.shopify.com/p/extra.jpg',
  ]);
});

test('a real variant joins the name and fills the subtype slot', () => {
  const { rows } = mapShopifyCatalog([product({
    variants: { nodes: [
      defaultVariant({ id: 'gid://shopify/ProductVariant/1', title: 'Teak', sku: 'A-1' }),
      defaultVariant({ id: 'gid://shopify/ProductVariant/2', title: 'White', sku: 'A-2', price: '1000' }),
    ] },
  })], CTX);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Garnet Lounge Chair - Copen Blue · Teak');
  assert.equal(rows[0].subtype, 'Teak');
  assert.equal(rows[1].id, 'lsg-2');
  assert.equal(rows[1].price_usd, 1000);
  // Both variants share the product's handle → one model in the catalog page.
  assert.equal(rows[0].family_code, rows[1].family_code);
});

test('parses the wholesale cost when Shopify carries one', () => {
  const { rows } = mapShopifyCatalog([product({
    variants: { nodes: [defaultVariant({ inventoryItem: { unitCost: { amount: '512.34' } } })] },
  })], CTX);
  assert.equal(rows[0].cost, 512.34);
});

test('stock_qty carries the variant inventory; missing/invalid → null', () => {
  const pick = (inventoryQuantity) => mapShopifyCatalog([product({
    variants: { nodes: [defaultVariant({ inventoryQuantity })] },
  })], CTX).rows[0].stock_qty;
  assert.equal(pick(12), 12);
  assert.equal(pick('3'), 3);
  assert.equal(pick(0), 0);
  assert.equal(pick(-2), -2); // oversold stays a real (non-positive) figure
  assert.equal(pick(undefined), null);
  assert.equal(pick(null), null);
  assert.equal(pick('x'), null);
});

test('a missing SKU falls back to a stable variant-id reference', () => {
  const { rows } = mapShopifyCatalog([product({
    variants: { nodes: [defaultVariant({ sku: '  ' })] },
  })], CTX);
  assert.equal(rows[0].reference, 'LSG-41476206493798');
});

test('squishes whitespace runs like the LR CSV import does', () => {
  const { rows } = mapShopifyCatalog([product({
    title: '  Garnet   Lounge  Chair ',
    collections: collections('Garnet'),
    variants: { nodes: [defaultVariant({ sku: ' 7166540001,  8104379000 ' })] },
  })], CTX);
  assert.equal(rows[0].name, 'Garnet Lounge Chair');
  assert.equal(rows[0].reference, '7166540001, 8104379000');
});

/* ----------------------------- exclusion rules ----------------------------- */

test('NEVER imports the inventory-mirror products the sync publishes (inv-*)', () => {
  const { rows, summary } = mapShopifyCatalog([
    product({ handle: 'inv-abc123', title: 'Togo Fireside Chair' }),
    product(),
  ], CTX);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].family_code, 'garnet-lounge-chair-copen-blue');
  assert.equal(summary.skippedInventory, 1);
});

test('only ACTIVE products import — drafts are out-of-assortment', () => {
  const { rows, summary } = mapShopifyCatalog([
    product({ status: 'DRAFT' }),
    product({ status: 'ARCHIVED' }),
    product(),
  ], CTX);
  assert.equal(rows.length, 1);
  assert.equal(summary.skippedInactive, 2);
  assert.equal(summary.products, 1);
});

test('duplicate references keep the FIRST row (unique per profile with LR SKUs)', () => {
  const { rows, summary } = mapShopifyCatalog([
    product(),
    product({ id: 'gid://shopify/Product/2', handle: 'other', variants: { nodes: [defaultVariant({ id: 'gid://shopify/ProductVariant/99', price: '1.00' })] } }),
  ], CTX);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'lsg-41476206493798');
  assert.equal(summary.duplicateRefs, 1);
});

/* ------------------------------ range / category ------------------------------ */

test('rangeOf picks the LONGEST collection title found in the product title', () => {
  assert.equal(rangeOf({
    title: 'Panama Dark Corner Sofa',
    collections: collections('Sofas', 'Panama', 'Panama Dark'),
  }), 'Panama Dark');
});

test('type-only collections (not in the title) are not a range', () => {
  assert.equal(rangeOf({ title: 'Folding Tray', collections: collections('Mesas', 'Otros') }), '');
});

test('category falls back: range → productType → first collection → empty', () => {
  const base = { variants: { nodes: [defaultVariant()] } };
  const pick = (p) => mapShopifyCatalog([product({ ...base, ...p })], CTX).rows[0];
  // No range match, productType present → productType.
  assert.equal(
    pick({ title: 'Folding Tray', productType: 'Accesorios', collections: collections('Otros') }).category,
    'Accesorios',
  );
  // No range, no productType → first collection.
  assert.equal(
    pick({ title: 'Folding Tray', collections: collections('Otros', 'Mesas') }).category,
    'Otros',
  );
  // Nothing at all → empty ("Sin colección" bucket), family empty too.
  const bare = pick({ title: 'Folding Tray', collections: { nodes: [] } });
  assert.equal(bare.category, '');
  assert.equal(bare.family, '');
});
