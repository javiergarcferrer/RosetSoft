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
// dealer's browser: automatically on the first app load at/after 08:00 AST
// each day (see AppContext / shouldPullDailyRate) and on demand from the
// Settings or quote-workspace refresh button. Both carry the user's JWT,
// verified here — no cron, no extra secrets, no manual setup.
//
// Endpoints come from the API spec, pinned to the production gateway
// (apipublico.bpd.com.do). The base is hardcoded below — there is NO
// BPD_API_BASE env override — so a stray secret can never point the
// function at the wrong environment.

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

// Production gateway for BPDConsultaTasa 2.2.0 (apipublico.bpd.com.do).
// Hardcoded on purpose — NO env override — so the whole function always
// talks to production and nothing can silently send the credentials to a
// sandbox gateway (or vice-versa).
//   token = `${BASE}/bpd/Authentication/oauth2/token`
//   tasa  = `${BASE}/consultatasa/consultaTasa`
const BASE = 'https://apipublico.bpd.com.do/bpd/bpd-publico';

// BPD's production gateway presents a leaf signed by "DigiCert EV RSA CA G2"
// but does NOT send that intermediate in the TLS handshake, so Deno can't
// build the chain to the trusted root and fetch fails with "invalid peer
// certificate: UnknownIssuer". (Browsers hide this by fetching the missing
// intermediate via AIA; the sandbox gateway served a complete chain, which is
// why this only appears in production — the request code never changed.) We
// bundle the intermediate + its DigiCert Global Root G2 and verify against
// them on every BPD request via a dedicated HTTP client.
const BPD_CA_CHAIN = [
  // DigiCert EV RSA CA G2 (intermediate that signs apipublico.bpd.com.do)
  `-----BEGIN CERTIFICATE-----
MIIFPDCCBCSgAwIBAgIQAWePH++IIlXYsKcOa3uyIDANBgkqhkiG9w0BAQsFADBh
MQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSAwHgYDVQQDExdEaWdpQ2VydCBHbG9iYWwgUm9vdCBH
MjAeFw0yMDA3MDIxMjQyNTBaFw0zMDA3MDIxMjQyNTBaMEQxCzAJBgNVBAYTAlVT
MRUwEwYDVQQKEwxEaWdpQ2VydCBJbmMxHjAcBgNVBAMTFURpZ2lDZXJ0IEVWIFJT
QSBDQSBHMjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAK0eZsx/neTr
f4MXJz0R2fJTIDfN8AwUAu7hy4gI0vp7O8LAAHx2h3bbf8wl+pGMSxaJK9ffDDCD
63FqqFBqE9eTmo3RkgQhlu55a04LsXRLcK6crkBOO0djdonybmhrfGrtBqYvbRat
xenkv0Sg4frhRl4wYh4dnW0LOVRGhbt1G5Q19zm9CqMlq7LlUdAE+6d3a5++ppfG
cnWLmbEVEcLHPAnbl+/iKauQpQlU1Mi+wEBnjE5tK8Q778naXnF+DsedQJ7NEi+b
QoonTHEz9ryeEcUHuQTv7nApa/zCqes5lXn1pMs4LZJ3SVgbkTLj+RbBov/uiwTX
tkBEWawvZH8CAwEAAaOCAgswggIHMB0GA1UdDgQWBBRqTlC/mGidW3sgddRZAXlI
ZpIyBjAfBgNVHSMEGDAWgBROIlQgGJXm427mD/r6uRLtBhePOTAOBgNVHQ8BAf8E
BAMCAYYwHQYDVR0lBBYwFAYIKwYBBQUHAwEGCCsGAQUFBwMCMBIGA1UdEwEB/wQI
MAYBAf8CAQAwNAYIKwYBBQUHAQEEKDAmMCQGCCsGAQUFBzABhhhodHRwOi8vb2Nz
cC5kaWdpY2VydC5jb20wewYDVR0fBHQwcjA3oDWgM4YxaHR0cDovL2NybDMuZGln
aWNlcnQuY29tL0RpZ2lDZXJ0R2xvYmFsUm9vdEcyLmNybDA3oDWgM4YxaHR0cDov
L2NybDQuZGlnaWNlcnQuY29tL0RpZ2lDZXJ0R2xvYmFsUm9vdEcyLmNybDCBzgYD
VR0gBIHGMIHDMIHABgRVHSAAMIG3MCgGCCsGAQUFBwIBFhxodHRwczovL3d3dy5k
aWdpY2VydC5jb20vQ1BTMIGKBggrBgEFBQcCAjB+DHxBbnkgdXNlIG9mIHRoaXMg
Q2VydGlmaWNhdGUgY29uc3RpdHV0ZXMgYWNjZXB0YW5jZSBvZiB0aGUgUmVseWlu
ZyBQYXJ0eSBBZ3JlZW1lbnQgbG9jYXRlZCBhdCBodHRwczovL3d3dy5kaWdpY2Vy
dC5jb20vcnBhLXVhMA0GCSqGSIb3DQEBCwUAA4IBAQBSMgrCdY2+O9spnYNvwHiG
+9lCJbyELR0UsoLwpzGpSdkHD7pVDDFJm3//B8Es+17T1o5Hat+HRDsvRr7d3MEy
o9iXkkxLhKEgApA2Ft2eZfPrTolc95PwSWnn3FZ8BhdGO4brTA4+zkPSKoMXi/X+
WLBNN29Z/nbCS7H/qLGt7gViEvTIdU8x+H4l/XigZMUDaVmJ+B5d7cwSK7yOoQdf
oIBGmA5Mp4LhMzo52rf//kXPfE3wYIZVHqVuxxlnTkFYmffCX9/Lon7SWaGdg6Rc
k4RHhHLWtmz2lTZ5CEo2ljDsGzCFGJP7oT4q6Q8oFC38irvdKIJ95cUxYzj4tnOI
-----END CERTIFICATE-----`,
  // DigiCert Global Root G2 (root)
  `-----BEGIN CERTIFICATE-----
MIIDjjCCAnagAwIBAgIQAzrx5qcRqaC7KGSxHQn65TANBgkqhkiG9w0BAQsFADBh
MQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSAwHgYDVQQDExdEaWdpQ2VydCBHbG9iYWwgUm9vdCBH
MjAeFw0xMzA4MDExMjAwMDBaFw0zODAxMTUxMjAwMDBaMGExCzAJBgNVBAYTAlVT
MRUwEwYDVQQKEwxEaWdpQ2VydCBJbmMxGTAXBgNVBAsTEHd3dy5kaWdpY2VydC5j
b20xIDAeBgNVBAMTF0RpZ2lDZXJ0IEdsb2JhbCBSb290IEcyMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuzfNNNx7a8myaJCtSnX/RrohCgiN9RlUyfuI
2/Ou8jqJkTx65qsGGmvPrC3oXgkkRLpimn7Wo6h+4FR1IAWsULecYxpsMNzaHxmx
1x7e/dfgy5SDN67sH0NO3Xss0r0upS/kqbitOtSZpLYl6ZtrAGCSYP9PIUkY92eQ
q2EGnI/yuum06ZIya7XzV+hdG82MHauVBJVJ8zUtluNJbd134/tJS7SsVQepj5Wz
tCO7TG1F8PapspUwtP1MVYwnSlcUfIKdzXOS0xZKBgyMUNGPHgm+F6HmIcr9g+UQ
vIOlCsRnKPZzFBQ9RnbDhxSJITRNrw9FDKZJobq7nMWxM4MphQIDAQABo0IwQDAP
BgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNVHQ4EFgQUTiJUIBiV
5uNu5g/6+rkS7QYXjzkwDQYJKoZIhvcNAQELBQADggEBAGBnKJRvDkhj6zHd6mcY
1Yl9PMWLSn/pvtsrF9+wX3N3KjITOYFnQoQj8kVnNeyIv/iPsGEMNKSuIEyExtv4
NeF22d+mQrvHRAiGfzZ0JFrabA0UWTW98kndth/Jsw1HKj2ZL7tcu7XUIOGZX1NG
Fdtom/DzMNU+MeKNhJ7jitralj41E6Vf8PlwUHBHQRFXGU7Aj64GxJUTFy8bJZ91
8rGOmaFvE7FBcf6IKshPECBV1/MUReXgRPTqh5Uykw7+U0b6LJ3/iyK5S9kJRaTe
pLiaWN0bfVKfjllDiIGknibVb63dDcY3fe0Dkhvld1927jyNxF1WW6LZZm6zNTfl
MrY=
-----END CERTIFICATE-----`,
];

// Defensive: if the runtime lacks Deno.createHttpClient we fall back to the
// default client (the BPD call would then fail with the original TLS error,
// but the function still loads and logs why instead of dying at import).
let bpdHttpClient: Deno.HttpClient | undefined;
try {
  bpdHttpClient = Deno.createHttpClient({ caCerts: BPD_CA_CHAIN });
} catch (e) {
  console.error('[bpd-rate] Deno.createHttpClient unavailable:', (e as Error)?.message || e);
}

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
      const res = await fetch(url, { ...init, client: bpdHttpClient, signal: ctrl.signal });
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
  const CLIENT_ID = Deno.env.get('BPD_CLIENT_ID')?.trim();
  const CLIENT_SECRET = Deno.env.get('BPD_CLIENT_SECRET')?.trim();
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return json({ error: 'Server misconfigured' }, 500);
  }

  // Optional JSON body. The browser invokes us with no body (user path); the
  // pg_cron schedule (migration *_bpd_rate_cron) posts `{cron:true}`. Tolerate
  // an empty/absent/invalid body — it just means the user path.
  let body: { cron?: boolean } = {};
  try {
    if (req.method === 'POST') body = (await req.json()) ?? {};
  } catch { /* no/!JSON body — user path */ }

  // Two callers, two auth modes (verify_jwt is off at the gateway — so the CORS
  // preflight, which carries no Authorization, passes — and we authenticate
  // here instead):
  //   • cron: the scheduled job, identified by the service-role key as Bearer.
  //     Checked first, because the service key is NOT a user JWT.
  //   • user: a logged-in dealer, whose JWT we verify — so the bank's quota
  //     can't be drained by anonymous traffic.
  const authHeader = req.headers.get('Authorization') || '';
  const isCron = body?.cron === true;
  if (isCron) {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'Server misconfigured' }, 500);
    if (authHeader !== `Bearer ${SERVICE_ROLE_KEY}`) return json({ error: 'forbidden' }, 403);
  } else {
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
  }

  try {
    console.log('[bpd-rate] start', { version: 'tls-ca-fix-2', base: BASE, clientId: CLIENT_ID, secretLen: CLIENT_SECRET.length, tlsClient: bpdHttpClient ? 'custom-ca' : 'default' });

    // 1. OAuth client-credentials token. The portal doesn't reveal HOW it
    // authenticates the client at the token endpoint, so try the two standard
    // ways and let the gateway pick: HTTP Basic auth (the IBM/OAuth2 default
    // for confidential clients) first, then form-body credentials. The app is
    // always identified by X-IBM-Client-Id (as the official rate call shows).
    // If BOTH return 401, the cause is the credential VALUES or the
    // subscription — not the request shape.
    const tokenUrl = `${BASE}/bpd/Authentication/oauth2/token`;
    const requestToken = (mode: 'basic' | 'body') => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-IBM-Client-Id': CLIENT_ID,
        Accept: 'application/json',
      };
      const form: Record<string, string> = { grant_type: 'client_credentials', scope: 'scope_1' };
      if (mode === 'basic') {
        const basic = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
        headers.Authorization = `Basic ${basic}`;
      } else {
        form.client_id = CLIENT_ID;
        form.client_secret = CLIENT_SECRET;
      }
      return fetchWithRetry(`token(${mode})`, tokenUrl, { method: 'POST', headers, body: new URLSearchParams(form) });
    };

    let tokenRes = await requestToken('basic');
    let tokenText = await tokenRes.text();
    if (!tokenRes.ok && (tokenRes.status === 400 || tokenRes.status === 401)) {
      console.warn(`[bpd-rate] token via Basic auth → HTTP ${tokenRes.status}; retrying with form-body credentials`);
      tokenRes = await requestToken('body');
      tokenText = await tokenRes.text();
    }
    if (!tokenRes.ok) {
      return json({ error: upstreamMessage('OAuth token', tokenRes.status), status: tokenRes.status, detail: tokenText.slice(0, 500) }, 502);
    }
    const accessToken = safeJson(tokenText)?.access_token;
    if (!accessToken) {
      return json({ error: 'No access_token in token response', detail: tokenText.slice(0, 500) }, 502);
    }

    // 2. Fetch the published rates. Per BPD's official production request,
    // the rate call carries ONLY X-IBM-Client-Id + the Bearer we just
    // minted — NO client-secret header (the secret is only for the token).
    const rateRes = await fetchWithRetry('consultaTasa', `${BASE}/consultatasa/consultaTasa`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-IBM-Client-Id': CLIENT_ID,
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

      // Self-heal the daily schedule: (re)register the pg_cron job that posts
      // `{cron:true}` back here through the business morning (migration
      // *_bpd_rate_cron). Idempotent, and driven off the function's own URL +
      // service key, so the schedule survives a project restore/reset without
      // anyone wiring it up — the next successful pull (browser OR cron) re-arms
      // it. Fire-and-forget: a registration hiccup must never fail the rate.
      const { error: cronErr } = await admin.rpc('ensure_bpd_rate_cron', {
        p_url: `${SUPABASE_URL}/functions/v1/bpd-rate`,
        p_secret: SERVICE_ROLE_KEY,
      });
      if (cronErr) console.error('bpd-rate: failed to register cron:', cronErr.message);
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
