// rnc-lookup — resolves a Dominican taxpayer's name from their RNC (empresa, 9
// digits) or cédula (persona física, 11 digits) against the public DGII-mirror
// registry, so the app can auto-fill the fiscal name on suppliers/customers
// (clean 606/607 reporting).
//
// Why a function (not a direct browser fetch): the upstream
// (rnc.megaplus.com.do) sends no `Access-Control-Allow-Origin`, so a browser
// cross-origin fetch is blocked. This fetches server-side (no CORS in Deno) and
// re-serves a normalized JSON with permissive CORS.
//
// Locked to that one endpoint and to a sanitized numeric rnc/cédula — it can
// only ever query that registry, never an arbitrary URL (no SSRF, not an open
// proxy), mirroring swatch-proxy's safety reasoning.
//
// Auth: a signed-in team member only. The lookup backs the suppliers/customers
// editors (never a public surface), so we verify the caller's JWT IN-CODE
// (auth.getUser on the Authorization header — same as lr-catalog / ecf-send /
// bpd-rate) and reject anonymous callers, so the registry can't be driven by
// anonymous internet traffic. Gateway verify_jwt stays off so the browser's
// CORS preflight (which carries no Authorization header) isn't rejected.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

const REGISTRY_BASE = 'https://rnc.megaplus.com.do/api/consulta';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  // Require a real signed-in dealer (the anon key is itself a valid JWT, so the
  // gateway's verify_jwt wouldn't be enough even if on) before driving the
  // registry. Verified in-code on the caller's Authorization header.
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authorization header required' }, 401);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json({ error: 'server not configured' }, 500);
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'Invalid or expired session' }, 401);

  // Accept the rnc from a POST JSON body (supabase.functions.invoke) or a query
  // param (?rnc=). Strip everything but digits.
  let raw = '';
  if (req.method === 'POST') {
    try {
      const b = await req.json();
      raw = (b && (b.rnc ?? b.cedula)) || '';
    } catch { /* fall through to query */ }
  }
  if (!raw) raw = new URL(req.url).searchParams.get('rnc') || '';
  const rnc = String(raw).replace(/\D/g, '');

  // RNC = 9 digits, cédula = 11. Reject anything else so a crafted value can't
  // smuggle a path/host into the upstream URL.
  if (rnc.length !== 9 && rnc.length !== 11) {
    return json({ found: false, rnc, message: 'RNC (9 dígitos) o cédula (11 dígitos) inválido.' }, 400);
  }

  try {
    const upstream = await fetch(`${REGISTRY_BASE}?rnc=${rnc}`, {
      headers: { accept: 'application/json' },
    });
    const text = await upstream.text();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch {
      return json({ found: false, rnc, message: 'Respuesta no válida del registro.' }, 502);
    }

    // Not inscribed / error from the registry → a clean "not found".
    if (data.error === true || data.codigo_http === 404 || !data.nombre_razon_social) {
      return json({
        found: false,
        rnc,
        message: typeof data.mensaje === 'string' ? data.mensaje : 'No se encontró el contribuyente.',
      });
    }

    return json({
      found: true,
      rnc,
      kind: rnc.length === 11 ? 'fisica' : 'juridica',
      name: data.nombre_razon_social || '',
      commercialName: data.nombre_comercial || '',
      status: data.estado || '',
      regime: data.regimen_de_pagos || '',
      activity: data.actividad_economica || '',
      localOffice: data.administracion_local || '',
      eInvoicer: data.facturador_electronico === 'SI',
    });
  } catch (e) {
    return json({ found: false, rnc, message: `Error consultando el registro: ${e}` }, 502);
  }
});
