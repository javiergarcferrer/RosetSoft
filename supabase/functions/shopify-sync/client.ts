// Shopify Admin API client for ONE store connection — all the auth machinery
// in one place so the mode handlers only ever see a `gql` function.
//
// Auth is the Dev Dashboard client-credentials grant (per shopify.dev):
//   • the minted token lives 24h → CACHED on the shopify_config row
//     (access_token/token_expires_at, written only here, never client-readable)
//     and refreshed TOKEN_EXPIRY_SKEW_MS before expiry;
//   • a 401/403 on a cached token gets ONE re-mint + retry — the cache may
//     simply be a token revoked by a secret rotation.

import { accessDeniedField, isTokenCacheValid, parseGrantResponse, ShopifyAccessDeniedError, tokenCacheExpiryIso } from './stores.ts';

// Latest stable Admin API version (2026-04 GA'd April 2026).
const API_VERSION = '2026-04';

// GraphQL Admin uses a calculated-cost leaky bucket; an over-budget call comes
// back as an HTTP-200 body carrying `errors:[{extensions:{code:'THROTTLED'}}]`
// plus `extensions.cost.throttleStatus`. A big catalog pull / inventory mirror
// would otherwise throw raw THROTTLED and abort mid-sweep — so we wait for the
// bucket to refill (deficit ÷ restoreRate, per shopify.dev) and retry, bounded.
const MAX_THROTTLE_RETRIES = 5;
const THROTTLE_WAIT_CAP_MS = 10_000;

interface ThrottleStatus { maximumAvailable?: number; currentlyAvailable?: number; restoreRate?: number }
interface GqlCost { requestedQueryCost?: number; throttleStatus?: ThrottleStatus }

/** True when a GraphQL error array carries a THROTTLED code. */
function isThrottled(errors: unknown): boolean {
  return Array.isArray(errors) && errors.some((e) => {
    const code = (e as { extensions?: { code?: string } })?.extensions?.code;
    return code === 'THROTTLED';
  });
}

/** How long to wait before retrying a throttled call: the cost deficit divided
 *  by the bucket's restore rate (capped), falling back to a fixed step. */
function throttleWaitMs(cost: GqlCost | undefined, attempt: number): number {
  const ts = cost?.throttleStatus;
  const need = Number(cost?.requestedQueryCost) || 0;
  const have = Number(ts?.currentlyAvailable) || 0;
  const rate = Number(ts?.restoreRate) || 0;
  const ms = rate > 0 ? ((Math.max(need, 1) - have) / rate) * 1000 : (attempt + 1) * 1000;
  return Math.min(THROTTLE_WAIT_CAP_MS, Math.max(250, Math.ceil(ms)));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface ConfigRow {
  domain?: string;
  access_token?: string | null;
  token_expires_at?: string | null;
  client_id?: string;
  client_secret?: string;
}

export type Gql = <T = unknown>(query: string, variables?: Record<string, unknown>) => Promise<T>;

export type Connection =
  | { configured: false }
  | { configured: true; domain: string; gql: Gql; verifyScopes: () => Promise<string[]> };

/**
 * Load `store`'s connection row and build its authenticated GraphQL caller.
 * `configured: false` when the store was never connected. Auth problems are
 * NOT eagerly checked here — they surface as descriptive errors from the
 * first `gql` call, which every mode handler already catches.
 */
// deno-lint-ignore no-explicit-any
export async function connectShopify(admin: any, team: string, store: string): Promise<Connection> {
  const { data } = await admin
    .from('shopify_config')
    .select('domain, access_token, token_expires_at, client_id, client_secret')
    .eq('profile_id', team).eq('store', store).maybeSingle();
  const c = data as ConfigRow | null;
  const domain = c?.domain;
  if (!domain || !c?.client_id || !c?.client_secret) return { configured: false };

  let token = isTokenCacheValid(c.access_token, c.token_expires_at, Date.now())
    ? (c.access_token as string)
    : '';
  // The scopes the LAST mint reported on the token's own `scope` field — the
  // authoritative, lag-free granted set (verifyScopes reads it). Empty until a
  // mint happens this request (a cached token never carried it here).
  let mintedScopes: string[] = [];

  /** Mint a fresh 24h token and persist it as the row's cache (best-effort —
   *  a failed cache write only costs a re-mint next call). */
  async function mintToken(): Promise<string> {
    const r = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: c!.client_id as string,
        client_secret: c!.client_secret as string,
      }),
    });
    const raw = await r.text().catch(() => '');
    const grant = parseGrantResponse(raw);
    if (!r.ok || !grant.accessToken) {
      const reason = grant.reason || `HTTP ${r.status}`;
      throw new Error(`Shopify rechazó las credenciales de la app para ${domain} (HTTP ${r.status}): ${reason}. Verifica que la app del Dev Dashboard esté en la MISMA organización que la tienda, que esté INSTALADA en ella, y que el secret no se haya rotado después de copiarlo.`);
    }
    mintedScopes = grant.grantedScopes;
    await admin.from('shopify_config')
      .update({ access_token: grant.accessToken, token_expires_at: tokenCacheExpiryIso(grant.expiresIn, Date.now()) })
      .eq('profile_id', team).eq('store', store);
    return grant.accessToken;
  }

  // Setup mistakes become their OWN messages instead of a generic failure: a
  // wrong domain (404/HTML — credentials may be fine) vs rejected auth
  // (401/403 on the right store, after the one re-mint).
  async function call<T>(query: string, variables: Record<string, unknown>, retried: boolean, throttleTry = 0): Promise<T> {
    if (!token) token = await mintToken();
    const r = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    if (r.status === 401 || r.status === 403) {
      await r.body?.cancel();
      if (!retried) {
        token = await mintToken(); // throws the descriptive credential error
        return call(query, variables, true);
      }
      throw new Error(`la app no tiene acceso a ${domain} (HTTP ${r.status}). Revisa los permisos (scopes) de la app del Dev Dashboard y que esté instalada en ESA tienda.`);
    }
    if (r.status === 404) {
      await r.body?.cancel();
      throw new Error(`no existe una tienda Shopify en ${domain}. Usa el dominio .myshopify.com exacto (Shopify → Configuración → Dominios).`);
    }
    let b: { errors?: unknown; data?: T; extensions?: { cost?: GqlCost } };
    try { b = await r.json(); } catch {
      throw new Error(`respuesta inesperada de ${domain} (HTTP ${r.status}) — ¿es el dominio .myshopify.com correcto?`);
    }
    if (b.errors) {
      // THROTTLED rides an HTTP-200 body. Wait for the leaky bucket to refill
      // and retry (bounded) instead of aborting the whole sync — a large
      // catalog pull / inventory mirror routinely drains the bucket.
      if (isThrottled(b.errors) && throttleTry < MAX_THROTTLE_RETRIES) {
        await sleep(throttleWaitMs(b.extensions?.cost, throttleTry));
        return call(query, variables, retried, throttleTry + 1);
      }
      // ACCESS_DENIED rides an HTTP-200 body, so the 401/403 re-mint above
      // never fires for it. A token cached BEFORE the dealer granted the scope
      // can't see it — re-mint ONCE so a freshly-granted scope/approval takes
      // effect on the very next call (no 24h wait for the cache to lapse).
      const denied = accessDeniedField(b.errors);
      if (denied !== null && !retried) {
        token = await mintToken();
        return call(query, variables, true);
      }
      // Re-mint didn't help → the scope genuinely isn't on the app. Raise a
      // TYPED error (carries the dealer-facing message) so a caller can react to
      // the specific denied field — e.g. the LSG write-back drops a gated
      // location field and degrades — without leaking the raw GraphQL array.
      if (denied !== null) throw new ShopifyAccessDeniedError(domain, denied);
      throw new Error(JSON.stringify(b.errors));
    }
    return b.data as T;
  }

  const gql: Gql = (query, variables = {}) => call(query, variables, false);

  /**
   * The scopes the connection's token ACTUALLY carries, for the connection
   * test. Force a fresh mint so the answer reflects the app's CURRENT released
   * config (the client-credentials token's own `scope` field) — NOT a cached
   * token and NOT `currentAppInstallation.accessScopes`, which reports the
   * per-installation granted set and lags the released config (so a dealer who
   * just added write_inventory/read_locations sees them as "missing"). Falls
   * back to the installation grant only if the mint response carried no scope.
   */
  async function verifyScopes(): Promise<string[]> {
    // Ensure a mint happened THIS request so mintedScopes reflects the live
    // token (a cached token never carried its scope here); reuse it if the
    // first gql call already minted, so the test doesn't mint twice.
    if (!mintedScopes.length) token = await mintToken();
    if (mintedScopes.length) return mintedScopes;
    try {
      const r = await call<{ currentAppInstallation: { accessScopes: { handle: string }[] } }>(
        `{ currentAppInstallation { accessScopes { handle } } }`, {}, false,
      );
      return r.currentAppInstallation.accessScopes.map((s) => s.handle);
    } catch { return []; }
  }

  return { configured: true, domain, gql, verifyScopes };
}
