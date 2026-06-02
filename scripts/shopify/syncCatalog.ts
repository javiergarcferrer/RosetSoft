/**
 * RosetSoft → Shopify catalog sync (the repeatable "structure").
 *
 * Reads the same Ligne Roset price-list CSV the dealer already uploads in the
 * Catálogo admin page, groups its SKUs into MODELS, and upserts each model into
 * the connected Shopify store as a DRAFT product (one variant per fabric grade),
 * optionally filing them into a collection (default "Lookbook"). Re-running is
 * idempotent: products are matched by a stable handle (`lr-<root>`), so prices
 * and variants are refreshed in place instead of duplicated.
 *
 * It reuses the repo's pure libraries (priceListCsv + catalog + shopifyCatalog)
 * so the mapping never drifts from how the app itself reads the catalog. The
 * ONLY I/O here is reading the file and calling the Shopify Admin GraphQL API.
 *
 *   Setup (one time):
 *     1. Shopify admin → Settings → Apps and sales channels → Develop apps →
 *        Create an app → Admin API access scopes: write_products,
 *        read_products, write_publications. Install it, reveal the Admin API
 *        access token.
 *     2. export SHOPIFY_STORE_DOMAIN="alcover.myshopify.com"
 *        export SHOPIFY_ADMIN_TOKEN="shpat_…"
 *
 *   Run:
 *     node --import tsx scripts/shopify/syncCatalog.ts <pricelist.csv> [flags]
 *
 *   Flags:
 *     --collection "Lookbook"   collection to file products into ("" to skip)
 *     --category   "Sofás"      only models in this catalog category
 *     --name       "togo"       only models whose name contains this (ci)
 *     --limit      8            cap the number of models synced
 *     --status     draft|active initial product status (default draft)
 *     --lookbook                also tag each product `lookbook`
 *     --dry-run                 print what WOULD happen; touch nothing
 *
 * Nothing this script creates is ever live until you publish it in Shopify.
 */
import { readFileSync } from 'node:fs';
import { parsePriceList, dedupeBySku, unifySplitNames } from '../../src/lib/priceListCsv.js';
import { catalogToShopifyProducts, type ShopifyProductInput } from '../../src/lib/shopifyCatalog.js';

/* --------------------------------- args ---------------------------------- */

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { args, positional };
}

const { args, positional } = parseArgs(process.argv.slice(2));
const csvPath = positional[0];
const COLLECTION = args.collection === undefined ? 'Lookbook' : String(args.collection || '');
const CATEGORY = args.category ? String(args.category).toLowerCase() : null;
const NAME = args.name ? String(args.name).toLowerCase() : null;
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const STATUS: 'DRAFT' | 'ACTIVE' = String(args.status || 'draft').toLowerCase() === 'active' ? 'ACTIVE' : 'DRAFT';
const LOOKBOOK = !!args.lookbook;
const DRY_RUN = !!args['dry-run'];

const DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || '';
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || '';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

function die(msg: string): never {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

if (!csvPath) die('Usage: node --import tsx scripts/shopify/syncCatalog.ts <pricelist.csv> [flags]');
if (!DRY_RUN && (!DOMAIN || !TOKEN)) {
  die('Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN (or pass --dry-run to preview).');
}

/* ------------------------------ shopify client --------------------------- */

async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://${DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

/** Find an existing product id by its stable handle (idempotency key). */
async function findProductId(handle: string): Promise<string | null> {
  const data = await gql<{ products: { edges: { node: { id: string } }[] } }>(
    `query($q: String!) { products(first: 1, query: $q) { edges { node { id } } } }`,
    { q: `handle:${handle}` },
  );
  return data.products.edges[0]?.node?.id ?? null;
}

/** Ensure a custom collection with this title exists; return its id. */
async function ensureCollection(title: string): Promise<string> {
  const found = await gql<{ collections: { edges: { node: { id: string } }[] } }>(
    `query($q: String!) { collections(first: 1, query: $q) { edges { node { id } } } }`,
    { q: `title:${JSON.stringify(title)}` },
  );
  const existing = found.collections.edges[0]?.node?.id;
  if (existing) return existing;
  const created = await gql<{ collectionCreate: { collection: { id: string }; userErrors: { message: string }[] } }>(
    `mutation($input: CollectionInput!) {
      collectionCreate(input: $input) { collection { id } userErrors { message } }
    }`,
    { input: { title } },
  );
  const errs = created.collectionCreate.userErrors;
  if (errs.length) throw new Error(`collectionCreate: ${errs.map((e) => e.message).join('; ')}`);
  return created.collectionCreate.collection.id;
}

/** Upsert one model via productSet (declarative: sets options + variants too). */
async function upsertProduct(p: ShopifyProductInput): Promise<string> {
  const id = await findProductId(p.handle);
  // Every productSet variant needs a non-null optionValues; an ungraded model
  // maps to Shopify's implicit single option ("Title" → "Default Title").
  const optionName = p.optionName || 'Title';
  const optionValueFor = (grade: string | null) =>
    p.optionName && grade != null ? grade : 'Default Title';
  const input: Record<string, unknown> = {
    handle: p.handle,
    title: p.title,
    descriptionHtml: p.descriptionHtml,
    vendor: p.vendor,
    productType: p.productType,
    status: p.status,
    tags: p.tags,
    productOptions: [{
      name: optionName,
      values: p.optionName
        ? p.variants.filter((v) => v.grade != null).map((v) => ({ name: v.grade as string }))
        : [{ name: 'Default Title' }],
    }],
    variants: p.variants.map((v) => ({
      sku: v.sku,
      price: v.price,
      optionValues: [{ optionName, name: optionValueFor(v.grade) }],
    })),
  };
  if (id) input.id = id;
  const data = await gql<{ productSet: { product: { id: string }; userErrors: { field: string[]; message: string }[] } }>(
    `mutation($input: ProductSetInput!) {
      productSet(input: $input, synchronous: true) {
        product { id }
        userErrors { field message }
      }
    }`,
    { input },
  );
  const errs = data.productSet.userErrors;
  if (errs.length) throw new Error(`productSet ${p.handle}: ${errs.map((e) => `${e.field?.join('.')}: ${e.message}`).join('; ')}`);
  return data.productSet.product.id;
}

/** File the synced products into the collection (async job; fire once). */
async function addToCollection(collectionId: string, productIds: string[]): Promise<void> {
  if (!productIds.length) return;
  const data = await gql<{ collectionAddProductsV2: { userErrors: { message: string }[] } }>(
    `mutation($id: ID!, $ids: [ID!]!) {
      collectionAddProductsV2(id: $id, productIds: $ids) { userErrors { message } }
    }`,
    { id: collectionId, ids: productIds },
  );
  const errs = data.collectionAddProductsV2.userErrors;
  if (errs.length) throw new Error(`collectionAddProductsV2: ${errs.map((e) => e.message).join('; ')}`);
}

/* ---------------------------------- main --------------------------------- */

async function main() {
  const csv = readFileSync(csvPath, 'utf8');
  const parsed = unifySplitNames(dedupeBySku(parsePriceList(csv)));
  if (!parsed.length) die('No products parsed — is this the Ligne Roset price-list CSV?');

  let models = catalogToShopifyProducts(parsed, {
    status: STATUS,
    extraTags: LOOKBOOK ? ['Lookbook'] : [],
  });

  if (CATEGORY) models = models.filter((m) => m.productType.toLowerCase() === CATEGORY);
  if (NAME) models = models.filter((m) => m.title.toLowerCase().includes(NAME));
  if (Number.isFinite(LIMIT)) models = models.slice(0, LIMIT);

  console.log(`Parsed ${parsed.length} SKUs → ${models.length} model(s) to sync` +
    `${CATEGORY ? ` · category=${CATEGORY}` : ''}${NAME ? ` · name~${NAME}` : ''}` +
    ` · status=${STATUS}${COLLECTION ? ` · collection=${COLLECTION}` : ''}${DRY_RUN ? ' · DRY RUN' : ''}`);

  if (DRY_RUN) {
    for (const m of models.slice(0, 20)) {
      console.log(`  · ${m.handle.padEnd(16)} ${m.title}  [${m.variants.length} variant(s), $${m.priceMin}–$${m.priceMax}]`);
    }
    if (models.length > 20) console.log(`  … and ${models.length - 20} more`);
    return;
  }

  const collectionId = COLLECTION ? await ensureCollection(COLLECTION) : null;

  const ids: string[] = [];
  let ok = 0;
  for (const m of models) {
    try {
      ids.push(await upsertProduct(m));
      ok++;
      process.stdout.write(`\r  synced ${ok}/${models.length}…`);
    } catch (e) {
      console.error(`\n  ✖ ${m.handle}: ${(e as Error).message}`);
    }
  }
  process.stdout.write('\n');

  if (collectionId) {
    await addToCollection(collectionId, ids);
    console.log(`  filed ${ids.length} product(s) into "${COLLECTION}"`);
  }
  console.log(`\n✔ Done. ${ok}/${models.length} model(s) upserted as ${STATUS}.` +
    `${STATUS === 'DRAFT' ? ' Review and publish them in Shopify when ready.' : ''}`);
}

main().catch((e) => die((e as Error).message));
