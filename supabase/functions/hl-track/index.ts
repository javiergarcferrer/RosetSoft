// hl-track — proxies Hapag-Lloyd's DCSA Track & Trace API (v2.2.4) so a
// dealer can look up a container's events by its container number.
//
// Why a function (not a direct browser call):
//   - The API keys (HL_CLIENT_ID / HL_CLIENT_SECRET) are function secrets
//     and must never reach the browser bundle.
//   - Hapag-Lloyd's gateway won't serve a cross-origin browser request, so
//     this proxy adds the key headers and forwards the call server-side.
//
// Called from a logged-in dealer's browser via `supabase.functions.invoke`
// with { containerNo }. The container number is the DCSA `equipmentReference`
// (a GET filter on /events). We verify the caller's JWT here because
// verify_jwt is off at the gateway (so the CORS preflight, which carries no
// Authorization header, isn't rejected).
//
// The base URL is hardcoded to the production gateway — there is NO env
// override — so a stray secret can never point the function elsewhere.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // Must list every header the caller sends or the browser blocks the
  // request at the CORS preflight. `supabase.functions.invoke()` adds
  // x-client-info + x-supabase-api-version on top of the usual set.
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

// DCSA Track & Trace v2.2.4 production gateway (api.hlag.com). Hardcoded on
// purpose — NO env override — so the function always talks to production.
const TNT_BASE = 'https://api.hlag.com/hlag/external/v2/events';

// Resilience for the upstream call: a hard attempt cap (never an infinite
// loop), bounded exponential backoff, and a per-attempt timeout so a hung
// gateway can't stall the function.
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;        // backoff: 500ms, 1000ms
const REQUEST_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// fetch with a per-attempt timeout, retrying ONLY transient failures:
// network errors / timeouts, HTTP 429 (rate limit), and 5xx. Client errors
// (4xx other than 429) return immediately — retrying a 401/403 just burns
// the daily quota. Honours Retry-After on 429.
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
        console.warn(`[hl-track] ${label}: HTTP ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}) — backoff ${delay}ms`);
        await sleep(delay);
        continue;
      }
      console.log(`[hl-track] ${label}: HTTP ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS})`);
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const aborted = (e as Error)?.name === 'AbortError';
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`[hl-track] ${label}: ${aborted ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : String((e as Error)?.message || e)} (attempt ${attempt}/${MAX_ATTEMPTS})${attempt < MAX_ATTEMPTS ? ` — backoff ${delay}ms` : ''}`);
      if (attempt < MAX_ATTEMPTS) await sleep(delay);
    }
  }
  throw lastErr ?? new Error(`${label}: failed after ${MAX_ATTEMPTS} attempts`);
}

// Controlled, differentiated message per upstream status.
function upstreamMessage(status: number): string {
  if (status === 401) return 'Hapag-Lloyd: 401 no autorizado (credenciales inválidas o app no suscrita a Track & Trace)';
  if (status === 403) return 'Hapag-Lloyd: 403 prohibido (sin acceso a este envío)';
  if (status === 404) return 'Hapag-Lloyd: 404 sin eventos para este contenedor';
  if (status === 429) return 'Hapag-Lloyd: 429 límite de solicitudes alcanzado';
  if (status >= 500) return `Hapag-Lloyd: ${status} error del servidor`;
  return `Hapag-Lloyd: ${status}`;
}

// An equipment reference is ISO 6346 (4 letters + 7 digits), but HL also
// documents non-ISO refs, so we only enforce a sane charset/length and let
// the gateway validate the rest. Keeps obvious junk out of the upstream call.
function sanitizeReference(raw: unknown): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const CLIENT_ID = Deno.env.get('HL_CLIENT_ID')?.trim();
  const CLIENT_SECRET = Deno.env.get('HL_CLIENT_SECRET')?.trim();
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return json({ error: 'Server misconfigured: faltan HL_CLIENT_ID / HL_CLIENT_SECRET' }, 500);
  }

  // Require a logged-in dealer so the daily quota can't be drained by
  // anonymous traffic. verify_jwt is off at the gateway (so the CORS
  // preflight passes); we verify the token here instead.
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

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body tolerated */ }
  const equipmentReference = sanitizeReference(body?.containerNo ?? body?.equipmentReference);
  if (!equipmentReference) {
    return json({ error: 'containerNo requerido' }, 400);
  }

  try {
    console.log('[hl-track] start', { equipmentReference, clientId: CLIENT_ID });
    const url = `${TNT_BASE}/?equipmentReference=${encodeURIComponent(equipmentReference)}&limit=100`;
    const res = await fetchWithRetry('events', url, {
      headers: {
        'X-IBM-Client-Id': CLIENT_ID,
        'X-IBM-Client-Secret': CLIENT_SECRET,
        Accept: 'application/json',
      },
    });

    // 204 = no events yet for this container (a valid, empty result).
    if (res.status === 204) {
      return json({ ok: true, equipmentReference, events: [], fetchedAt: new Date().toISOString() });
    }
    const text = await res.text();
    if (!res.ok) {
      return json({ error: upstreamMessage(res.status), status: res.status, detail: text.slice(0, 500) }, 502);
    }
    const parsed = safeJson(text);
    const events = Array.isArray(parsed) ? parsed : [];
    console.log('[hl-track] ok', { equipmentReference, events: events.length });
    return json({ ok: true, equipmentReference, events, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return json({ error: 'Error contactando Hapag-Lloyd', detail: String((e as Error)?.message || e) }, 502);
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
