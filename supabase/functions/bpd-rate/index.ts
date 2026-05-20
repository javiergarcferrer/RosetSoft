// bpd-rate — fetches the latest USD / EUR buy (compra) and sell (venta)
// DOP rates from Banco Popular Dominicano's "BPDConsultaTasa" API and
// returns them to the app.
//
// Why a function (not a direct browser call):
//   - The OAuth client_id / client_secret are function secrets
//     (BPD_CLIENT_ID / BPD_CLIENT_SECRET) and must never reach the
//     browser bundle.
//   - The bank's API needs a client-credentials token exchange before
//     the rate call, and its gateway won't serve a cross-origin browser
//     request anyway. This proxy does both server-side.
//
// On every successful fetch it also writes the rate to the team
// settings row (settings.bsc + settings.currency_rates) with the
// service-role key, so the number the whole app quotes on is the bank's
// published rate — nobody types it in. It's called from a logged-in
// dealer's browser: automatically on the first app load of each day (see
// AppContext / shouldPullDailyRate) and on demand from Settings'
// "Actualizar ahora" button. Both carry the user's JWT, verified here —
// no cron, no extra secrets, no manual setup.
//
// Endpoints come from the API spec (sandbox by default). Set a
// BPD_API_BASE secret to point at production without a code change.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // Must list every header the caller sends, or the browser blocks the
  // request at the CORS preflight. Unlike invite-user/delete-user (called
  // via a raw fetch with a fixed header set), bpd-rate is called through
  // `supabase.functions.invoke()`, which adds `x-client-info` and
  // `x-supabase-api-version`. Omitting them is what produced the
  // "Failed to send a request to the Edge Function" error.
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

// Sandbox base from BPDConsultaTasa 2.6.1. Token + rate paths hang off it.
const DEFAULT_BASE =
  'https://api.us-east-a.apiconnect.ibmappdomain.cloud/apiportalpopular/bpdsandbox';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const CLIENT_ID = Deno.env.get('BPD_CLIENT_ID');
  const CLIENT_SECRET = Deno.env.get('BPD_CLIENT_SECRET');
  const BASE = (Deno.env.get('BPD_API_BASE') || DEFAULT_BASE).replace(/\/+$/, '');
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return json({ error: 'Server misconfigured' }, 500);
  }

  // Require a logged-in dealer so the bank's quota can't be drained by
  // anonymous traffic. verify_jwt is off at the gateway (so the CORS
  // preflight passes — browsers don't send Authorization on OPTIONS); we
  // verify the token here instead.
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Authorization header required' }, 401);
  }
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await caller.auth.getUser();
    if (error || !data?.user) return json({ error: 'Invalid or expired session' }, 401);
  }

  try {
    // 1. OAuth client-credentials token.
    //
    // IBM API Connect identifies the confidential app at the gateway via
    // BOTH the X-IBM-Client-Id AND X-IBM-Client-Secret *headers* (per
    // BPD's "probar tus APIs" guide — "agrega los encabezados … client-id
    // y client-secret"). Sending the secret only in the OAuth body is not
    // enough: without the header the gateway can't authorize the app and
    // returns `unauthorized_client` / "Invalid client ID or secret, or
    // client not subscribed to this API" with an empty plan/product.
    const tokenRes = await fetch(`${BASE}/bpd/Authentication/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-IBM-Client-Id': CLIENT_ID,
        'X-IBM-Client-Secret': CLIENT_SECRET,
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: 'scope_1',
      }),
    });
    const tokenText = await tokenRes.text();
    if (!tokenRes.ok) {
      return json({ error: 'OAuth token request failed', status: tokenRes.status, detail: tokenText.slice(0, 500) }, 502);
    }
    const accessToken = safeJson(tokenText)?.access_token;
    if (!accessToken) {
      return json({ error: 'No access_token in token response', detail: tokenText.slice(0, 500) }, 502);
    }

    // 2. Fetch the published rates. Same gateway app-identification
    // headers as the token call, plus the Bearer we just minted.
    const rateRes = await fetch(`${BASE}/consultatasa/consultaTasa`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-IBM-Client-Id': CLIENT_ID,
        'X-IBM-Client-Secret': CLIENT_SECRET,
        Accept: 'application/json',
      },
    });
    const rateText = await rateRes.text();
    if (!rateRes.ok) {
      return json({ error: 'consultaTasa request failed', status: rateRes.status, detail: rateText.slice(0, 500) }, 502);
    }
    const payload = safeJson(rateText);

    // 3. Normalise monedas.moneda[] -> { USD: {compra, venta}, EUR: {...} }.
    const raw = payload?.monedas?.moneda ?? [];
    const list = Array.isArray(raw) ? raw : [raw];
    const rates: Record<string, { compra: number; venta: number }> = {};
    for (const m of list) {
      const code = String(m?.descripcion || '').toUpperCase().trim();
      if (!code) continue;
      rates[code] = { compra: Number(m?.compra) || 0, venta: Number(m?.venta) || 0 };
    }
    if (!rates.USD || (!rates.USD.compra && !rates.USD.venta)) {
      return json({ error: 'USD rate not found in response', raw: payload }, 502);
    }

    // Persist to the shared team settings row so the rate the whole app
    // quotes on (effectiveDopRate → settings.bsc) is the bank's published
    // number, refreshed without anyone touching it. Service-role client
    // bypasses RLS. `currency_rates.DOP` is kept in lockstep so new-quote
    // rate snapshots (QuoteBuilder) don't go stale. We quote on venta
    // (sell). `updatedAt` is ms to match the app's own jsonb writes.
    let persisted = false;
    if (SUPABASE_URL && SERVICE_ROLE_KEY) {
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: upErr } = await admin
        .from('settings')
        .update({
          bsc: { buy: rates.USD.compra, sell: rates.USD.venta, updatedAt: Date.now() },
          currency_rates: { USD: 1, DOP: rates.USD.venta },
        })
        .eq('profile_id', 'team');
      if (upErr) {
        console.error('bpd-rate: failed to persist rate to settings:', upErr.message);
      } else {
        persisted = true;
      }
    }

    return json({
      ok: true,
      usd: rates.USD,
      eur: rates.EUR ?? null,
      rates,
      persisted,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return json({ error: 'Upstream error contacting BPD', detail: String((e as Error)?.message || e) }, 502);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
