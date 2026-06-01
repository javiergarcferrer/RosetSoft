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
