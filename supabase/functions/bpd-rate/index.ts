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
// settings row (settings.exchange_rate — the single source of truth) with
// the service-role key, so the number the whole app quotes on is the bank's
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

// Resilience for the upstream BPD calls (BPD cert C.7 + C.10): a hard
// attempt cap (never an infinite loop), bounded exponential backoff, and
// a per-attempt timeout so a hung gateway can't stall the function.
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;        // backoff: 500ms, 1000ms
const REQUEST_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// fetch with a per-attempt timeout, retrying ONLY transient failures:
// network errors / timeouts, HTTP 429 (rate limit), and 5xx. Client
// errors (4xx other than 429) return immediately — retrying a 401/403
// would just hammer the bank. Honours Retry-After on 429. Emits a trace
// per attempt (status only, never secrets) for the cert evidence.
async function fetchWithRetry(label: string, url: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : BASE_DELAY_MS * 2 ** (attempt - 1);
        console.warn(`[bpd-rate] ${label}: HTTP ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}) — backoff ${delay}ms`);
        await sleep(delay);
        continue;
      }
      console.log(`[bpd-rate] ${label}: HTTP ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS})`);
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const aborted = (e as Error)?.name === 'AbortError';
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`[bpd-rate] ${label}: ${aborted ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : String((e as Error)?.message || e)} (attempt ${attempt}/${MAX_ATTEMPTS})${attempt < MAX_ATTEMPTS ? ` — backoff ${delay}ms` : ''}`);
      if (attempt < MAX_ATTEMPTS) await sleep(delay);
    }
  }
  throw lastErr ?? new Error(`${label}: failed after ${MAX_ATTEMPTS} attempts`);
}

// Controlled, differentiated message per upstream status (cert C.3/C.4/C.6).
function upstreamMessage(kind: string, status: number): string {
  if (status === 401) return `${kind}: 401 no autorizado (credenciales inválidas o app no suscrita)`;
  if (status === 403) return `${kind}: 403 prohibido (permisos o scope insuficientes)`;
  if (status === 404) return `${kind}: 404 recurso no encontrado`;
  if (status === 429) return `${kind}: 429 límite de solicitudes del banco alcanzado`;
  if (status >= 500) return `${kind}: ${status} error del servidor del banco`;
  return `${kind}: ${status}`;
}

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
    console.log('[bpd-rate] start', { base: BASE });
    // 1. OAuth client-credentials token.
    //
    // IBM API Connect identifies the confidential app at the gateway via
    // BOTH the X-IBM-Client-Id AND X-IBM-Client-Secret *headers* (per
    // BPD's "probar tus APIs" guide — "agrega los encabezados … client-id
    // y client-secret"). Sending the secret only in the OAuth body is not
    // enough: without the header the gateway can't authorize the app and
    // returns `unauthorized_client` / "Invalid client ID or secret, or
    // client not subscribed to this API" with an empty plan/product.
    const tokenRes = await fetchWithRetry('token', `${BASE}/bpd/Authentication/oauth2/token`, {
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
      return json({ error: upstreamMessage('OAuth token', tokenRes.status), status: tokenRes.status, detail: tokenText.slice(0, 500) }, 502);
    }
    const accessToken = safeJson(tokenText)?.access_token;
    if (!accessToken) {
      return json({ error: 'No access_token in token response', detail: tokenText.slice(0, 500) }, 502);
    }

    // 2. Fetch the published rates. Same gateway app-identification
    // headers as the token call, plus the Bearer we just minted.
    const rateRes = await fetchWithRetry('consultaTasa', `${BASE}/consultatasa/consultaTasa`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-IBM-Client-Id': CLIENT_ID,
        'X-IBM-Client-Secret': CLIENT_SECRET,
        Accept: 'application/json',
      },
    });
    const rateText = await rateRes.text();
    if (!rateRes.ok) {
      return json({ error: upstreamMessage('consultaTasa', rateRes.status), status: rateRes.status, detail: rateText.slice(0, 500) }, 502);
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

    // Persist to the shared team settings row — the SINGLE source of
    // truth for the rate. effectiveDopRate() reads settings.exchange_rate
    // (sell), and everything else (quote snapshots, PDF, totals) derives
    // from it, so we write only that column. Service-role client bypasses
    // RLS. We quote on venta (sell). `updatedAt` is ms to match the app's
    // jsonb writes. Realtime (migration 20260520140000) propagates this to
    // open sessions.
    let persisted = false;
    if (SUPABASE_URL && SERVICE_ROLE_KEY) {
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: upErr } = await admin
        .from('settings')
        .update({
          exchange_rate: { buy: rates.USD.compra, sell: rates.USD.venta, updatedAt: Date.now() },
        })
        .eq('profile_id', 'team');
      if (upErr) {
        console.error('bpd-rate: failed to persist rate to settings:', upErr.message);
      } else {
        persisted = true;
      }
    }

    console.log('[bpd-rate] ok', { usd: rates.USD, eur: rates.EUR ?? null, persisted });
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
