// Shopify Admin API client for ONE store connection — all the auth machinery
// in one place so the mode handlers only ever see a `gql` function.
//
// Auth is the Dev Dashboard client-credentials grant (per shopify.dev):
//   • the minted token lives 24h → CACHED on the shopify_config row
//     (access_token/token_expires_at, written only here, never client-readable)
//     and refreshed TOKEN_EXPIRY_SKEW_MS before expiry;
//   • a 401/403 on a cached token gets ONE re-mint + retry — the cache may
//     simply be a token revoked by a secret rotation.

import { accessDeniedField, accessDeniedMessage, isTokenCacheValid, parseGrantResponse, tokenCacheExpiryIso } from './stores.ts';

// Latest stable Admin API version (2026-04 GA'd April 2026).
const API_VERSION = '2026-04';

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
  | { configured: true; domain: string; gql: Gql };

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
    await admin.from('shopify_config')
      .update({ access_token: grant.accessToken, token_expires_at: tokenCacheExpiryIso(grant.expiresIn, Date.now()) })
      .eq('profile_id', team).eq('store', store);
    return grant.accessToken;
  }

  // Setup mistakes become their OWN messages instead of a generic failure: a
  // wrong domain (404/HTML — credentials may be fine) vs rejected auth
  // (401/403 on the right store, after the one re-mint).
  async function call<T>(query: string, variables: Record<string, unknown>, retried: boolean): Promise<T> {
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
    let b: { errors?: unknown; data?: T };
    try { b = await r.json(); } catch {
      throw new Error(`respuesta inesperada de ${domain} (HTTP ${r.status}) — ¿es el dominio .myshopify.com correcto?`);
    }
    if (b.errors) {
      // ACCESS_DENIED rides an HTTP-200 body, so the 401/403 re-mint above
      // never fires for it. A token cached BEFORE the dealer granted the scope
      // can't see it — re-mint ONCE so a freshly-granted scope/approval takes
      // effect on the very next call (no 24h wait for the cache to lapse).
      const denied = accessDeniedField(b.errors);
      if (denied !== null && !retried) {
        token = await mintToken();
        return call(query, variables, true);
      }
      // Re-mint didn't help → the scope genuinely isn't on the app. Say exactly
      // what to enable instead of leaking the raw GraphQL array.
      if (denied !== null) throw new Error(accessDeniedMessage(domain, denied));
      throw new Error(JSON.stringify(b.errors));
    }
    return b.data as T;
  }

  const gql: Gql = (query, variables = {}) => call(query, variables, false);
  return { configured: true, domain, gql };
}
