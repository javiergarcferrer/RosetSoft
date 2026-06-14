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
  /** Register the LSG stock-refresh cron (admin-gated). */
  ensureCron?: boolean;
  /** Cron tick: re-pull the LSG catalog (Bearer service key only). */
  cron?: boolean;
  /** LSG inventory write-back: decrement Shopify when sold in ALCOVER. */
  lsgAdjust?: Array<{ productId?: string; variantId?: string; delta: number }>;
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
 * The scopes a store's app installation must carry, per direction. The
 * LifestyleGarden link is TWO-WAY: it PULLS the catalog (read_products,
 * read_inventory) AND pushes inventory decrements back when an LSG product is
 * sold inside ALCOVER (write_inventory + read_locations to resolve the
 * location). The Alcover mirror writes products + quantities. Surfacing the
 * full list makes the Settings connection test flag any re-auth the dealer
 * must do in the Shopify Dev Dashboard for the scopes to work.
 */
export function requiredScopes(store: string): string[] {
  return store === STORE_LSG
    ? ['read_products', 'read_inventory', 'read_locations', 'write_inventory']
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

/**
 * Scan a GraphQL `errors` array for an ACCESS_DENIED failure — a missing scope
 * or un-granted protected-data access, NOT an auth/token failure (those arrive
 * as HTTP 401/403). Returns the denied field path joined with '.' (e.g.
 * 'orders'), '' when denied without a path, or null when there is no
 * ACCESS_DENIED error. PURE — pinned by tests/shopifySync.test.js.
 *
 * Why it earns a helper: ACCESS_DENIED rides an HTTP-200 body, so client.ts's
 * 401/403 re-mint never fires for it. A token cached BEFORE the dealer granted
 * the scope keeps failing for up to 24h. Detecting it lets the client bust the
 * cache, re-mint, and pick the new scope up on the very next call.
 */
export function accessDeniedField(errors: unknown): string | null {
  if (!Array.isArray(errors)) return null;
  for (const e of errors) {
    if (!e || typeof e !== 'object') continue;
    const code = (e as { extensions?: { code?: unknown } }).extensions?.code;
    if (code !== 'ACCESS_DENIED') continue;
    const path = (e as { path?: unknown }).path;
    return Array.isArray(path) ? path.map(String).join('.') : '';
  }
  return null;
}

/**
 * The dealer-facing explanation for an ACCESS_DENIED that survives a token
 * re-mint: the scope genuinely isn't on the app. Names the denied field so the
 * dealer knows which permission to enable in the Dev Dashboard. PURE.
 */
export function accessDeniedMessage(domain: string, field: string): string {
  const f = field || 'este recurso';
  return `La app de Shopify para ${domain} no tiene permiso para «${f}» (ACCESS_DENIED). En el Dev Dashboard de Shopify, en la configuración de la app, habilita el scope que falta. Una vez concedido, el siguiente intento renueva el token y toma el permiso automáticamente.`;
}

/** Stable Shopify handle for an inventory item — the idempotent upsert key.
 *  MIRRORS src/lib/inventoryShopify.ts:pieceHandle across the Deno↔Vite wall;
 *  tests/shopifySync.test.js pins the two equivalent. */
export function pieceHandle(id: string): string {
  const slug = String(id || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `inv-${slug || 'item'}`;
}
