/**
 * Pure mapping: an in-stock inventory item → the Shopify catalog listing it
 * becomes — or a signal to REMOVE it when it sells out.
 *
 * The store catalog mirrors inventory. Every in-stock item is one Shopify
 * product (identical pieces already collapse into one item carrying a stock
 * count, via the (profile_id, sku) unique key). The price is the PERMANENT
 * price set on the Alcover purchase order (`sellingPrice`) — never recomputed.
 * The photo is the one uploaded at receiving (`imageId`), resolved to a public
 * URL by the caller (kept out of here so this stays pure). When on-hand qty
 * reaches 0 the piece has sold and must leave the catalog.
 *
 * Pure: no Supabase, no Shopify SDK, no URL building. Unit-tested. The Edge
 * Function that talks to Shopify is the only thing that does I/O.
 */
import type { InventoryItem } from '../types/domain';

export interface ShopifyPiece {
  /** Stable handle from the item id — the idempotent upsert key. */
  handle: string;
  title: string;
  sku: string;
  /** Decimal money string, e.g. "3420.00". */
  price: string;
  /** On-hand units to stock in Shopify. */
  quantity: number;
  imageUrl: string | null;
}

/** What should happen to an item's Shopify listing on the next sync. */
export type PieceSync =
  | { action: 'upsert'; piece: ShopifyPiece }
  | { action: 'remove'; reason: 'out_of_stock' | 'no_price' };

function money(n: unknown): string {
  const v = Number(n);
  return (Number.isFinite(v) ? v : 0).toFixed(2);
}

/** Stable Shopify handle for an inventory item (id-based → never collides). */
export function pieceHandle(item: Pick<InventoryItem, 'id'>): string {
  const slug = String(item.id || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `inv-${slug || 'item'}`;
}

/**
 * Decide what should happen to an item's Shopify listing.
 *
 * @param item     the inventory item (with its resolved qtyOnHand + sellingPrice)
 * @param imageUrl public URL for `item.imageId`, or null — the caller builds it
 *                 from the Storage path so this function stays pure.
 */
export function resolvePieceSync(
  item: InventoryItem,
  imageUrl: string | null = null,
): PieceSync {
  const qty = Number(item.qtyOnHand) || 0;
  const price = Number(item.sellingPrice) || 0;
  // Catalog is in-stock only: sold out → leave the catalog.
  if (qty <= 0) return { action: 'remove', reason: 'out_of_stock' };
  // No permanent price yet (PO not priced) → not sellable, keep it off the store.
  if (price <= 0) return { action: 'remove', reason: 'no_price' };
  return {
    action: 'upsert',
    piece: {
      handle: pieceHandle(item),
      title: (item.name || item.sku || 'Artículo').trim(),
      sku: (item.sku || '').trim(),
      price: money(price),
      quantity: Math.floor(qty),   // qty > 0 here (guarded above) → no Math.max needed
      imageUrl: imageUrl || null,
    },
  };
}
