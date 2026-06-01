// ecf-send — signs an e-CF and transmits it to the DGII.
//
// The browser builds the e-CF payload (pure `buildEcfPayload`, on the Vite side)
// and POSTs it here; this function (Deno, server-side) reads the team's .p12 from
// the write-only `ecf_credentials` table via the SERVICE ROLE, then runs the
// dgii-ecf flow: authenticate (semilla → token), json2xml, XAdES signXml, send.
// Only DATA crosses the Deno↔Vite wall — never code.
//
// Auth: declared with verify_jwt=true (default) so only a signed-in team member
// can invoke it. The service-role key + SUPABASE_URL are auto-injected by the
// platform — no manual secret.
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

const ENV_MAP: Record<string, unknown> = {
  // dgii-ecf's ENVIRONMENT enum: DEV (TesteCF), CERT (CerteCF), PROD (eCF).
  dev: (dgii as any).ENVIRONMENT?.DEV,
  cert: (dgii as any).ENVIRONMENT?.CERT,
  prod: (dgii as any).ENVIRONMENT?.PROD,
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  let body: { payload?: any; eNcf?: string; profileId?: string } = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid body' }, 400); }
  const payload = body.payload;
  const eNcf = String(body.eNcf || '');
  if (!payload || !eNcf) return json({ ok: false, error: 'payload + eNcf required' }, 400);

  const profileId = body.profileId || 'team';
  const ecfType = String(payload?.ECF?.Encabezado?.IdDoc?.TipoeCF || '');
  const rncEmisor = String(payload?.ECF?.Encabezado?.Emisor?.RNCEmisor || '');

  // Read the certificate via the service role (bypasses the write-only RLS).
  const supa = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
  );
  const { data: cred, error: credErr } = await supa
    .from('ecf_credentials').select('*').eq('profile_id', profileId).maybeSingle();
  if (credErr) return json({ ok: false, error: `cert read: ${credErr.message}` }, 500);
  if (!cred) return json({ ok: false, error: 'No hay certificado .p12 cargado. Súbelo en Configuración contable.' }, 412);

  try {
    // dgii-ecf reads the key from a .p12 file; materialize the bytes to a temp file.
    const p12Path = await Deno.makeTempFile({ suffix: '.p12' });
    await Deno.writeFile(p12Path, b64ToBytes(cred.p12_base64));

    const reader = new (dgii as any).P12Reader(cred.password);
    const certs = reader.getKeyFromFile(p12Path);

    const environment = ENV_MAP[cred.environment as string] ?? ENV_MAP.cert;
    const ecf = new (dgii as any).ECF(certs, environment);
    await ecf.authenticate();

    const transformer = new (dgii as any).Transformer();
    const xml = transformer.json2xml(payload);
    const signature = new (dgii as any).Signature(certs.key, certs.cert);
    const signedXml = signature.signXml(xml);

    const fileName = `${rncEmisor}${eNcf}.xml`;

    // Type 32 (consumo) transmits as an RFCE summary; 31 sends the full e-CF.
    let securityCode = '';
    let response: any;
    if (ecfType === '32' && typeof (dgii as any).convertECF32ToRFCE === 'function') {
      const rfce = (dgii as any).convertECF32ToRFCE(signedXml);
      securityCode = rfce?.securityCode || '';
      response = await ecf.sendElectronicDocument(rfce?.xml || signedXml, fileName);
    } else {
      response = await ecf.sendElectronicDocument(signedXml, fileName);
    }

    const trackId = response?.trackId || response?.data?.trackId || response?.body?.trackId || '';
    await Deno.remove(p12Path).catch(() => {});

    return json({ ok: true, trackId, securityCode, status: 'sent', response });
  } catch (e) {
    return json({ ok: false, error: `firma/transmisión: ${e}` }, 502);
  }
});
