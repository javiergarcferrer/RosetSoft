// PURE routing + auth rules for shopify-sync — no Deno, no Supabase, no fetch.
// Node-importable so tests/shopifySync.test.js can pin every rule (same
// pattern as catalogImport.ts / quote-share/pick.ts).
//
// THE map (one direction per store):
//   'alcover'         — alcover.do (alcoversdq.myshopify.com). The inventory
//                       mirror: the default mode PUBLISHES in-stock pieces.
//   'lifestylegarden' — lifestylegarden.do (alcoversrl.myshopify.com). The
//                       brand catalog: importCatalog PULLS active products.
// The store ids double as shopify_config.store keys; the Vite side keeps its
// own copies in lib/shopifySync.js (code never crosses the Deno↔Vite wall).

export const STORE_ALCOVER = 'alcover';
export const STORE_LSG = 'lifestylegarden';

export interface SyncRequest {
  itemIds?: string[];
  test?: boolean;
  importCatalog?: boolean;
  store?: string;
}

/**
 * Which store a request talks to. The catalog import is hard-wired to the
 * LifestyleGarden store; `test` checks whichever store the caller names; the
 * inventory mirror (default mode) is hard-wired to Alcover.
 */
export function storeForRequest(body: SyncRequest | null | undefined): string {
  if (body?.importCatalog === true) return STORE_LSG;
  return body?.store === STORE_LSG ? STORE_LSG : STORE_ALCOVER;
}

/**
 * The scopes a store's app installation must carry, per direction:
 * the catalog pull only READS; the inventory mirror also writes products +
 * quantities and resolves the location.
 */
export function requiredScopes(store: string): string[] {
  return store === STORE_LSG
    ? ['read_products', 'read_inventory']
    : ['read_products', 'write_products', 'read_locations', 'read_inventory', 'write_inventory'];
}

/** Refresh ahead of the deadline so a token can't die mid-sync. */
export const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** Is the cached client-credentials token still usable at `nowMs`? */
export function isTokenCacheValid(
  accessToken: string | null | undefined,
  expiresAtIso: string | null | undefined,
  nowMs: number,
): boolean {
  if (!accessToken || !expiresAtIso) return false;
  const t = Date.parse(expiresAtIso);
  return Number.isFinite(t) && t - nowMs > TOKEN_EXPIRY_SKEW_MS;
}

/** Cache stamp for a freshly minted token (Shopify says 86399s = 24h). */
export function tokenCacheExpiryIso(expiresInSecs: unknown, nowMs: number): string {
  return new Date(nowMs + (Number(expiresInSecs) || 86399) * 1000).toISOString();
}

/**
 * Parse the client-credentials grant response (PURE — pinned by tests).
 * Shopify's OAuth endpoint answers in several shapes: a token grant
 * ({access_token, expires_in}), an OAuth error ({error, error_description}),
 * a legacy error ({errors: string | object}), or non-JSON (HTML error page).
 * `reason` carries the most specific message available for the failure path —
 * e.g. shop_not_permitted, which means the app and store aren't in the same
 * Dev Dashboard organization or the app isn't installed on the store.
 */
export function parseGrantResponse(rawBody: string): {
  accessToken: string | null;
  expiresIn: number | null;
  reason: string;
} {
  let b: Record<string, unknown> | null = null;
  try { b = JSON.parse(rawBody); } catch { /* non-JSON body */ }
  if (b && typeof b === 'object') {
    if (typeof b.access_token === 'string' && b.access_token) {
      return { accessToken: b.access_token, expiresIn: Number(b.expires_in) || null, reason: '' };
    }
    const detail = [b.error, b.error_description].filter((v) => typeof v === 'string' && v).join(': ');
    if (detail) return { accessToken: null, expiresIn: null, reason: detail };
    if (b.errors != null) {
      return { accessToken: null, expiresIn: null, reason: typeof b.errors === 'string' ? b.errors : JSON.stringify(b.errors) };
    }
  }
  const snippet = String(rawBody || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return { accessToken: null, expiresIn: null, reason: snippet };
}

/** Stable Shopify handle for an inventory item — the idempotent upsert key.
 *  MIRRORS src/lib/inventoryShopify.ts:pieceHandle across the Deno↔Vite wall;
 *  tests/shopifySync.test.js pins the two equivalent. */
export function pieceHandle(id: string): string {
  const slug = String(id || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `inv-${slug || 'item'}`;
}
