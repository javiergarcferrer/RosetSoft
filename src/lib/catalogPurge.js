import { supabase, IMAGES_BUCKET } from '../db/supabaseClient.js';
import { db } from '../db/database.js';

// Image kinds that belong to the catalog. Logo + per-line quote swatches
// are NOT catalog data and must survive a purge.
const CATALOG_IMAGE_KINDS = new Set([
  'product-hero',
  'product-vector',
  'variant',
  'swatch',
]);

/**
 * Wipe every catalog row + every catalog image (both the `images` table row
 * and the underlying Storage object). Customers, quotes, containers,
 * settings, profile and per-line quote swatches are preserved.
 *
 * Schema FKs do most of the work for us:
 *   - products    → on delete cascade   → variants follow
 *   - materials   → on delete cascade   → material_colors follow
 *   - categories  → set null            → products' categoryId nulled (no-op
 *                                          here since products are gone)
 *   - quote_lines.{productVariantId, materialId, colorId}
 *                 → set null            → quote lines survive with dangling
 *                                          refs (rendered as "(missing)" in
 *                                          the builder)
 *
 * Storage objects are removed in batches of 100 (Supabase Storage hard limit
 * per `remove` call).
 */
export async function purgeCatalog() {
  const counts = {
    products: 0,
    variants: 0,
    materials: 0,
    materialColors: 0,
    categories: 0,
    imageRows: 0,
    storageObjects: 0,
  };

  // 1. Inventory the catalog images BEFORE the rows go away, so we still
  //    know which storage paths to delete.
  const allImages = await db.images.toArray();
  const catalogImages = allImages.filter((img) => CATALOG_IMAGE_KINDS.has(img.kind));
  const storagePaths = catalogImages.map((img) => img.storagePath).filter(Boolean);

  // 2. Delete the actual storage objects in chunks of 100.
  for (let i = 0; i < storagePaths.length; i += 100) {
    const chunk = storagePaths.slice(i, i + 100);
    const { error } = await supabase.storage.from(IMAGES_BUCKET).remove(chunk);
    if (error) {
      // Don't abort the whole purge — log and keep going. Worst case we
      // leak some storage objects; the rows are about to go regardless.
      console.warn('[purgeCatalog] storage.remove failed for chunk:', error);
    } else {
      counts.storageObjects += chunk.length;
    }
  }

  // 3. Delete the catalog image rows.
  if (catalogImages.length) {
    await db.images.bulkDelete(catalogImages.map((i) => i.id));
    counts.imageRows = catalogImages.length;
  }

  // 4. Delete the catalog tables. Cascades handle variants + colors.
  const products = await db.products.toArray();
  const variants = await db.productVariants.toArray();
  const materials = await db.materials.toArray();
  const materialColors = await db.materialColors.toArray();
  const categories = await db.categories.toArray();

  counts.products = products.length;
  counts.variants = variants.length;
  counts.materials = materials.length;
  counts.materialColors = materialColors.length;
  counts.categories = categories.length;

  if (products.length) await db.products.bulkDelete(products.map((p) => p.id));
  if (materials.length) await db.materials.bulkDelete(materials.map((m) => m.id));
  if (categories.length) await db.categories.bulkDelete(categories.map((c) => c.id));

  // Variants + colors should already be gone via cascade, but issue an
  // explicit delete in case a future migration relaxes the FK rule.
  const remainingVariants = await db.productVariants.toArray();
  if (remainingVariants.length) {
    await db.productVariants.bulkDelete(remainingVariants.map((v) => v.id));
  }
  const remainingColors = await db.materialColors.toArray();
  if (remainingColors.length) {
    await db.materialColors.bulkDelete(remainingColors.map((c) => c.id));
  }

  return counts;
}

export const CATALOG_PURGE_PHRASE = 'delete catalog';
