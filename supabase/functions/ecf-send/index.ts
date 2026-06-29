// ecf-send — signs an e-CF and transmits it to the DGII, and (op:'status')
// asks the DGII what became of a transmitted document by trackId.
//
// The browser builds the e-CF payload (pure `buildEcfPayload`, on the Vite side)
// and POSTs it here; this function (Deno, server-side) reads the team's .p12 from
// the write-only `ecf_credentials` table via the SERVICE ROLE, then runs the
// dgii-ecf flow: authenticate (semilla → token), json2xml, XAdES signXml, send.
// Only DATA crosses the Deno↔Vite wall — never code.
//
// Auth: the gateway's verify_jwt=true is NOT enough — the public anon key is
// itself a valid JWT and passes it. Signing with the company's fiscal
// certificate must be reserved to a signed-in team member, so the function
// additionally resolves the caller's user from the Authorization header and
// rejects anonymous callers.
//
// NOTE: this must be validated against DGII's TesteCF/CerteCF with the real
// certificate; exact dgii-ecf method names/return shapes can vary by version and
// may need a small tweak once tested. Failures return { ok:false, error } so the
// app degrades gracefully (the e-NCF is already assigned + stored).
import { createClient } from 'npm:@supabase/supabase-js@2';
// deno-lint-ignore no-explicit-any
import * as dgii from 'npm:dgii-ecf';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** First 6 chars of the XML's SignatureValue — the DGII "código de seguridad"
 *  printed on the invoice and carried in the consulta-timbre QR. */
function securityCodeFrom(signedXml: string): string {
  const m = /<(?:\w+:)?SignatureValue[^>]*>([\s\S]*?)<\//.exec(signedXml || '');
  return (m?.[1] || '').replace(/\s+/g, '').slice(0, 6);
}

/** Signature date in DR local time, dd-mm-yyyy HH:mm:ss (QR `fechafirma`). */
function fechaFirmaNow(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Santo_Domingo',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  return `${get('day')}-${get('month')}-${get('year')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * Harvest the REAL reason out of an error the dgii-ecf/axios stack throws. The
 * library usually re-wraps the axios error and DROPS `.response`, so a bare
 * `e.message` ("Request failed with status code 400") tells the dealer nothing.
 * Walk the cause chain and pull, from whichever link still carries it, the HTTP
 * status, the DGII response body (the actual validation message), and WHICH
 * endpoint failed (authenticate semilla/token vs transmit) — never headers, so
 * the bearer token can't leak into the message or the function logs.
 */
function describeError(e: any): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: any = e;
  for (let depth = 0; cur && typeof cur === 'object' && !seen.has(cur) && depth < 6; depth++) {
    seen.add(cur);
    const status = cur?.response?.status ?? cur?.status;
    if (status) parts.push(`HTTP ${status}`);
    const data = cur?.response?.data;
    if (data != null) {
      let body = '';
      try { body = typeof data === 'string' ? data : JSON.stringify(data); } catch { body = String(data); }
      body = body.trim();
      if (body && body !== '""' && body !== '{}' && body !== 'null') parts.push(body);
    }
    const url = cur?.config?.url || cur?.request?.path;
    if (url) {
      const method = cur?.config?.method ? `${String(cur.config.method).toUpperCase()} ` : '';
      parts.push(`@ ${method}${url}`);
    }
    if (cur?.code) parts.push(String(cur.code));
    cur = cur.cause;
  }
  // The chain often repeats the same crumb at each link — de-dupe, keep order.
  return [...new Set(parts)].join(' · ');
}

const ENV_MAP: Record<string, unknown> = {
  // dgii-ecf's ENVIRONMENT enum: DEV (TesteCF), CERT (CerteCF), PROD (eCF).
  dev: (dgii as any).ENVIRONMENT?.DEV,
  cert: (dgii as any).ENVIRONMENT?.CERT,
  prod: (dgii as any).ENVIRONMENT?.PROD,
};

// dgii-ecf funnels EVERY DGII call (semilla, validar-semilla, recepción) through
// one shared axios instance it exports as `restClient`. Tap its error channel
// ONCE so we capture the raw rejection — HTTP status, the endpoint that failed
// (so we know authenticate vs transmit), and the DGII response body (the real
// validation message) — straight from the wire, before the library can re-wrap
// the error and drop `.response`. The bearer token lives in request headers,
// which we never read, so it can't leak. `lastHttpError` is reset per request.
let lastHttpError = '';
(function installHttpTap() {
  try {
    const rc = (dgii as any).restClient;
    if (rc?.interceptors?.response?.use && !rc.__ecfTap) {
      rc.__ecfTap = true;
      rc.interceptors.response.use(
        (r: any) => r,
        (err: any) => {
          const status = err?.response?.status ?? err?.status;
          const url = err?.config?.url || err?.request?.path || '';
          const data = err?.response?.data;
          let bodyStr = '';
          try { bodyStr = data == null ? '' : (typeof data === 'string' ? data : JSON.stringify(data)); } catch { bodyStr = String(data); }
          const crumbs = [status ? `HTTP ${status}` : '', url ? `@ ${url}` : '', bodyStr ? bodyStr.slice(0, 1500) : ''].filter(Boolean);
          if (crumbs.length) lastHttpError = crumbs.join(' · ');
          return Promise.reject(err);
        },
      );
    }
  } catch { /* tap is best-effort diagnostics — never block a transmission */ }
})();

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  // The anon key passes the gateway's verify_jwt — require a real signed-in
  // user before touching the signing certificate.
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const authClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') || '', {
    global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
  });
  const { data: auth } = await authClient.auth.getUser();
  if (!auth?.user) return json({ ok: false, error: 'No autorizado.' }, 401);

  lastHttpError = ''; // fresh capture per request (isolate is reused across calls)
  let body: { op?: string; payload?: any; eNcf?: string; trackId?: string; profileId?: string; xml?: string } = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid body' }, 400); }

  const op = body.op || 'send';
  const payload = body.payload;
  const eNcf = String(body.eNcf || '');
  const trackIdIn = String(body.trackId || '');
  if ((op === 'send' || op === 'approve' || op === 'sign') && (!payload || !eNcf)) return json({ ok: false, error: 'payload + eNcf required' }, 400);
  if (op === 'status' && !trackIdIn) return json({ ok: false, error: 'trackId required' }, 400);

  const profileId = body.profileId || 'team';
  const ecfType = String(payload?.ECF?.Encabezado?.IdDoc?.TipoeCF || '');
  const rncEmisor = String(payload?.ECF?.Encabezado?.Emisor?.RNCEmisor || '');

  // Read the certificate via the service role (bypasses the write-only RLS).
  const supa = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '');
  const { data: cred, error: credErr } = await supa
    .from('ecf_credentials').select('*').eq('profile_id', profileId).maybeSingle();
  if (credErr) return json({ ok: false, error: `cert read: ${credErr.message}` }, 500);
  if (!cred) return json({ ok: false, error: 'No hay certificado .p12 cargado. Súbelo en Configuración contable.' }, 412);

  // The e-CF environment's SINGLE source of truth is the visible selector in
  // Configuración (settings.ecf_environment), so the transmission target and the
  // printed QR's consulta-timbre URL (which reads the same setting on the Vite
  // side) can never drift apart. Fall back to the env stored on the credential
  // at upload, then to CerteCF.
  const { data: cfg } = await supa
    .from('settings').select('ecf_environment').eq('profile_id', profileId).maybeSingle();
  const envKey = String(cfg?.ecf_environment || cred.environment || 'cert');

  let p12Path = '';
  try {
    // dgii-ecf reads the key from a .p12 file; materialize the bytes to a temp file.
    p12Path = await Deno.makeTempFile({ suffix: '.p12' });
    await Deno.writeFile(p12Path, b64ToBytes(cred.p12_base64));

    const reader = new (dgii as any).P12Reader(cred.password);
    const certs = reader.getKeyFromFile(p12Path);

    const environment = ENV_MAP[envKey] ?? ENV_MAP.cert;
    const ecf = new (dgii as any).ECF(certs, environment);

    // op:'sign' — produce the signed XML LOCALLY (no DGII contact needed): the
    // código de seguridad + QR derive from the signature itself, so this lets the
    // dealer generate the set-de-pruebas XML and SEE the timbre on the
    // representación impresa BEFORE (and independent of) transmitting.
    if (op === 'sign') {
      const transformer = new (dgii as any).Transformer();
      const signature = new (dgii as any).Signature(certs.key, certs.cert);
      const signedXml = signature.signXml(transformer.json2xml(payload));
      const fechaFirma = fechaFirmaNow();
      let securityCode = securityCodeFrom(signedXml);
      let outXml = signedXml;
      if (ecfType === '32' && typeof (dgii as any).convertECF32ToRFCE === 'function') {
        const rfce = (dgii as any).convertECF32ToRFCE(signedXml);
        securityCode = rfce?.securityCode || securityCode;
        outXml = rfce?.xml || signedXml;
      }
      return json({ ok: true, signedXml: outXml, securityCode, fechaFirma });
    }

    await ecf.authenticate();

    if (op === 'status') {
      // Track-status inquiry; tolerate the method name varying by version.
      const fn = ['statusTrackId', 'trackStatus', 'inquiryStatus', 'consultStatus']
        .map((n) => (ecf as any)[n]).find((f) => typeof f === 'function');
      if (!fn) return json({ ok: false, error: 'La librería dgii-ecf no expone consulta por trackId.' }, 501);
      const response = await fn.call(ecf, trackIdIn);
      const estado = response?.estado || response?.data?.estado || response?.status || '';
      return json({ ok: true, estado, response });
    }

    const transformer = new (dgii as any).Transformer();
    const xml = transformer.json2xml(payload);
    const signature = new (dgii as any).Signature(certs.key, certs.cert);
    const signedXml = signature.signXml(xml);

    // Commercial approval (ACECF): sign + send via the dedicated DGII service.
    // The approver is the comprador, so the file is named with THEIR RNC.
    if (op === 'approve') {
      const rncComprador = String(payload?.ACECF?.DetalleAprobacionComercial?.RNCComprador || '');
      const response = await ecf.sendCommercialApproval(signedXml, `${rncComprador}${eNcf}.xml`);
      const estado = response?.estado || response?.data?.estado || response?.status || '';
      return json({ ok: true, estado, response });
    }

    const fechaFirma = fechaFirmaNow();

    const fileName = `${rncEmisor}${eNcf}.xml`;

    // Type 32 (consumo) transmits as an RFCE summary; 31 sends the full e-CF.
    // The security code (QR) is the signature's first 6 chars for EVERY type.
    let securityCode = securityCodeFrom(signedXml);
    let response: any;
    if (ecfType === '32' && typeof (dgii as any).convertECF32ToRFCE === 'function') {
      const rfce = (dgii as any).convertECF32ToRFCE(signedXml);
      securityCode = rfce?.securityCode || securityCode;
      response = await ecf.sendElectronicDocument(rfce?.xml || signedXml, fileName);
    } else {
      response = await ecf.sendElectronicDocument(signedXml, fileName);
    }

    const trackId = response?.trackId || response?.data?.trackId || response?.body?.trackId || '';
    if (!trackId) {
      // No trackId ⇒ the DGII did NOT acknowledge reception — never report
      // 'sent' (the posting would look transmitted while nothing arrived).
      return json({ ok: false, error: `La DGII no devolvió trackId: ${JSON.stringify(response ?? null)}` }, 502);
    }

    return json({ ok: true, trackId, securityCode, fechaFirma, status: 'sent', response });
  } catch (e: any) {
    // dgii-ecf talks to the DGII via axios; an HTTP rejection (e.g. 400 schema
    // validation, or an auth failure) carries the REAL reason in the response
    // body — but the library frequently re-wraps the error and drops
    // `.response`, leaving only the opaque "Request failed with status code
    // 400". describeError walks the whole cause chain to recover the status,
    // the DGII body, and WHICH endpoint failed (authenticate vs transmit).
    const msg = e?.message || String(e);
    // Combine the thrown-error walk with the wire-level tap and de-dupe the
    // crumbs — whichever the library left intact, the DGII reason surfaces.
    const detail = [...new Set([describeError(e), lastHttpError].filter(Boolean).join(' · ').split(' · '))]
      .filter(Boolean).join(' · ');
    // Server-side breadcrumb for `get_logs` — curated crumbs only (no headers),
    // so the next failed envío is diagnosable from the function logs too.
    console.error('ecf-send failure', JSON.stringify({ op, eNcf, ecfType, envKey, msg, detail }));
    return json({ ok: false, error: `firma/transmisión: ${msg}${detail ? ` — ${detail}` : ''}` }, 502);
  } finally {
    if (p12Path) await Deno.remove(p12Path).catch(() => {});
  }
});
