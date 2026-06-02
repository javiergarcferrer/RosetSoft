# RosetSoft → Shopify catalog sync

The repeatable "structure" that pushes the Ligne Roset furniture catalog into
the ALCOVER Shopify store. It reuses the app's own price-list parsers and model
grouping (`src/lib/priceListCsv.ts`, `src/lib/catalog.ts`,
`src/lib/shopifyCatalog.ts`) so the products it creates match how the catalog
reads everywhere else.

## What it does

- Reads the **same price-list CSV** you upload in **Catálogo** (`Importar CSV`).
- Groups the ~27k SKUs into **models** (an 8-digit root + its fabric-grade
  variants → one product, one variant per grade).
- **Upserts** each model into Shopify as a **DRAFT** product, idempotently:
  re-running matches by the stable handle `lr-<root>` and refreshes prices in
  place — it never duplicates.
- Optionally files them into a **collection** (default `Lookbook`), which the
  storefront "Lookbook" tab renders.

Nothing it creates is ever live until you publish it in Shopify.

## One-time setup

1. Shopify admin → **Settings → Apps and sales channels → Develop apps →
   Create an app**.
2. **Admin API access scopes:** `write_products`, `read_products`,
   `write_publications`. Install the app, then reveal the **Admin API access
   token** (`shpat_…`).
3. Export the credentials in your shell:

   ```sh
   export SHOPIFY_STORE_DOMAIN="alcover.myshopify.com"
   export SHOPIFY_ADMIN_TOKEN="shpat_xxxxxxxxxxxxxxxxxxxxxxxx"
   ```

The token lives only in your shell — it is **not** committed and **not** stored
in the app. (This is the one credential cross-service sync needs; the rest of
RosetSoft still ships purely by pushing `main`.)

## Run

```sh
# Preview without touching anything (no token required):
node --import tsx scripts/shopify/syncCatalog.ts ./LigneRosetPriceList.csv --dry-run

# Sync just the Togo models into the Lookbook collection, as drafts:
node --import tsx scripts/shopify/syncCatalog.ts ./LigneRosetPriceList.csv --name togo --lookbook

# Sync an entire category:
node --import tsx scripts/shopify/syncCatalog.ts ./LigneRosetPriceList.csv --category "Sofás"
```

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--collection "Lookbook"` | `Lookbook` | Collection to file products into (`""` to skip). |
| `--category "Sofás"` | — | Only models in this catalog category. |
| `--name "togo"` | — | Only models whose name contains this (case-insensitive). |
| `--limit 8` | — | Cap the number of models synced. |
| `--status draft\|active` | `draft` | Initial product status. |
| `--lookbook` | off | Also tag each product `lookbook`. |
| `--dry-run` | off | Print what would happen; touch nothing. |

## Images (important)

The price-list catalog carries **no product photos** — only references, names,
families, prices and dimensions. So synced products arrive **image-less** and
should stay DRAFT until you add photography. The image-rich pieces in the
Lookbook tab (Togo, Ploum, …) were seeded with curated images; treat the bulk
sync as the "long tail" you publish selectively once it has imagery.

A natural next step is an `images` column on `products` (fed from the LR site or
your own shoots) — the mapper would then attach them automatically.
