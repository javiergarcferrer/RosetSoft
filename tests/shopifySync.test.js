// shopify-sync routing + auth rules (supabase/functions/shopify-sync/stores.ts)
// — the PURE half of the Edge Function, importable from Node like
// catalogImport.ts / quote-share/pick.ts.
//
// Pins:
//   • mode → store routing: the catalog import is hard-wired to the
//     LifestyleGarden store, the inventory mirror to Alcover; only `test` can
//     name a store. A wrong route would point a direction at the WRONG store —
//     the exact bug family behind the June-2026 domain saga.
//   • per-store required scopes: the pull is read-only; the mirror writes.
//   • token cache validity + grant-response parsing (the client-credentials
//     flow per shopify.dev: 24h tokens, refresh before expiry).
//   • inv-handle PARITY across the Deno↔Vite wall with
//     src/lib/inventoryShopify.ts (deliberate copies that must not drift).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORE_ALCOVER,
  STORE_LSG,
  storeForRequest,
  requiredScopes,
  isTokenCacheValid,
  tokenCacheExpiryIso,
  parseGrantResponse,
  accessDeniedField,
  accessDeniedMessage,
  TOKEN_EXPIRY_SKEW_MS,
  pieceHandle as denoPieceHandle,
} from '../supabase/functions/shopify-sync/stores.ts';
import { pieceHandle as vitePieceHandle } from '../src/lib/inventoryShopify.ts';

test('storeForRequest: importCatalog is hard-wired to the LifestyleGarden store', () => {
  assert.equal(storeForRequest({ importCatalog: true }), STORE_LSG);
  // Even a contradictory store param can't point the import at Alcover.
  assert.equal(storeForRequest({ importCatalog: true, store: STORE_ALCOVER }), STORE_LSG);
});

test('storeForRequest: the inventory mirror (default mode) is hard-wired to Alcover', () => {
  assert.equal(storeForRequest({}), STORE_ALCOVER);
  assert.equal(storeForRequest(null), STORE_ALCOVER);
  assert.equal(storeForRequest({ itemIds: ['a', 'b'] }), STORE_ALCOVER);
  // Unknown store strings fall back to Alcover, never to LSG.
  assert.equal(storeForRequest({ store: 'whatever' }), STORE_ALCOVER);
});

test('storeForRequest: test mode checks whichever store the caller names', () => {
  assert.equal(storeForRequest({ test: true }), STORE_ALCOVER);
  assert.equal(storeForRequest({ test: true, store: STORE_LSG }), STORE_LSG);
});

test('requiredScopes: the LSG link is two-way (read + write_inventory); the mirror writes inventory only', () => {
  // LSG PULLS the catalog AND pushes inventory decrements back when an LSG
  // product is sold in ALCOVER, so it needs write_inventory + read_locations on
  // top of the read scopes — this is what makes the connection test flag the
  // one-time Shopify re-auth.
  assert.deepEqual(
    requiredScopes(STORE_LSG).sort(),
    ['read_inventory', 'read_locations', 'read_products', 'write_inventory'],
  );
  const mirror = requiredScopes(STORE_ALCOVER);
  for (const s of ['read_products', 'write_products', 'read_locations', 'read_inventory', 'write_inventory']) {
    assert.ok(mirror.includes(s), `mirror needs ${s}`);
  }
  // The orders control center is gone — the mirror must NOT demand order scopes
  // (which gate behind protected-customer-data approval and tripped the test).
  assert.ok(!mirror.includes('read_orders'), 'mirror must not need read_orders');
  assert.ok(!mirror.includes('write_fulfillments'), 'mirror must not need write_fulfillments');
});

test('isTokenCacheValid: usable only beyond the refresh skew', () => {
  const now = Date.parse('2026-06-11T12:00:00Z');
  const at = (ms) => new Date(now + ms).toISOString();
  assert.equal(isTokenCacheValid('tok', at(TOKEN_EXPIRY_SKEW_MS + 60_000), now), true);
  // Inside the skew window → treat as expired (refresh ahead of the deadline).
  assert.equal(isTokenCacheValid('tok', at(TOKEN_EXPIRY_SKEW_MS - 1), now), false);
  assert.equal(isTokenCacheValid('tok', at(-1), now), false);
  assert.equal(isTokenCacheValid('', at(86_399_000), now), false);
  assert.equal(isTokenCacheValid('tok', null, now), false);
  assert.equal(isTokenCacheValid('tok', 'not-a-date', now), false);
});

test('tokenCacheExpiryIso: stamps expires_in seconds, defaulting to 24h', () => {
  const now = Date.parse('2026-06-11T12:00:00Z');
  assert.equal(tokenCacheExpiryIso(3600, now), new Date(now + 3_600_000).toISOString());
  // Shopify's documented value (86399) is the fallback for a missing field.
  assert.equal(tokenCacheExpiryIso(undefined, now), new Date(now + 86_399_000).toISOString());
  assert.equal(tokenCacheExpiryIso('bogus', now), new Date(now + 86_399_000).toISOString());
});

test('parseGrantResponse: token grant', () => {
  const g = parseGrantResponse(JSON.stringify({ access_token: 'shpat_x', scope: 'read_products', expires_in: 86399 }));
  assert.equal(g.accessToken, 'shpat_x');
  assert.equal(g.expiresIn, 86399);
  assert.equal(g.reason, '');
});

test('parseGrantResponse: surfaces every error shape Shopify answers with', () => {
  // OAuth-spec shape.
  assert.equal(
    parseGrantResponse(JSON.stringify({ error: 'shop_not_permitted', error_description: 'Client credentials cannot be performed on this shop' })).reason,
    'shop_not_permitted: Client credentials cannot be performed on this shop',
  );
  // Legacy {errors: string} shape (the one a bare HTTP-400 report was hiding).
  assert.equal(parseGrantResponse(JSON.stringify({ errors: 'invalid_client' })).reason, 'invalid_client');
  // {errors: object} shape.
  assert.equal(parseGrantResponse(JSON.stringify({ errors: { base: ['bad'] } })).reason, '{"base":["bad"]}');
  // Non-JSON (HTML error page) → a readable snippet, never an empty reason
  // for a non-empty body.
  const html = parseGrantResponse('<html>\n  <body>Something   went wrong</body></html>');
  assert.ok(html.reason.includes('Something went wrong'));
  assert.equal(parseGrantResponse('').reason, '');
});

test('accessDeniedField: detects ACCESS_DENIED on an HTTP-200 body (the orders trap)', () => {
  // The exact shape Shopify returns when a granted-but-not-yet-on-the-token
  // scope hits the orders connection — the error the dealer pasted.
  const ordersDenied = [{
    message: 'Access denied for orders field.',
    locations: [{ line: 2, column: 9 }],
    extensions: { code: 'ACCESS_DENIED', documentation: 'https://shopify.dev/api/usage/access-scopes' },
    path: ['orders'],
  }];
  assert.equal(accessDeniedField(ordersDenied), 'orders');
  // A nested path joins with '.', so the message can name the exact field.
  assert.equal(
    accessDeniedField([{ extensions: { code: 'ACCESS_DENIED' }, path: ['order', 'customer', 'firstName'] }]),
    'order.customer.firstName',
  );
  // Denied without a path → '' (still a denial, not null).
  assert.equal(accessDeniedField([{ extensions: { code: 'ACCESS_DENIED' } }]), '');
  // A NON-access error must stay null so the client surfaces it verbatim and
  // does NOT pointlessly re-mint the token.
  assert.equal(accessDeniedField([{ message: 'Field x does not exist', extensions: { code: 'undefinedField' } }]), null);
  assert.equal(accessDeniedField([]), null);
  assert.equal(accessDeniedField(null), null);
  assert.equal(accessDeniedField('nope'), null);
  // First ACCESS_DENIED wins even when mixed with other errors.
  assert.equal(
    accessDeniedField([{ extensions: { code: 'THROTTLED' } }, { extensions: { code: 'ACCESS_DENIED' }, path: ['orders'] }]),
    'orders',
  );
});

test('accessDeniedMessage: names the domain + denied field and points to the Dev Dashboard', () => {
  const m = accessDeniedMessage('alcoversrl.myshopify.com', 'inventoryLevel');
  assert.ok(m.includes('alcoversrl.myshopify.com'));
  assert.ok(m.includes('«inventoryLevel»'));
  assert.ok(/Dev Dashboard/i.test(m));
  assert.ok(/ACCESS_DENIED/.test(m));
  // Empty field still yields a sensible, non-broken sentence.
  assert.ok(accessDeniedMessage('x.myshopify.com', '').includes('este recurso'));
});

test('pieceHandle: Deno and Vite copies cannot drift (cross-wall parity)', () => {
  const ids = ['Item 42', 'AB c_12', '--x--', '', 'ñandú #9', 'a'.repeat(40), 'UPPER-case.id'];
  for (const id of ids) {
    assert.equal(denoPieceHandle(id), vitePieceHandle({ id }), `handle parity for ${JSON.stringify(id)}`);
  }
  // The rule itself, at its edges: slug is lowercased, non-alphanumerics
  // collapse to single dashes, and an empty slug falls back to 'item'.
  assert.equal(denoPieceHandle('Item 42'), 'inv-item-42');
  assert.equal(denoPieceHandle(''), 'inv-item');
  assert.equal(denoPieceHandle('--x--'), 'inv-x');
});
