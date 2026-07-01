// fe-autenticacion — RECEPTOR-side authentication service the DGII requires to
// certify us as a receptor (certification steps 8–11). A sender (the DGII test
// harness, or any emisor delivering us an e-CF) first GETs a `semilla` (seed
// XML) from us, signs it with their digital certificate, and POSTs it to
// `validacioncertificado`; we validate the signature and return a bearer token
// they then use to deliver e-CFs to fe-recepcion / approvals to
// fe-aprobacioncomercial.
//
// This is the MIRROR of ecf-send's client-side `ecf.authenticate()` — there we
// are the client against the DGII; here WE are the server. The crypto is the
// dgii-ecf library's `CustomAuthentication` (generateSeed / verifySignedSeed /
// verifyToken), built from the team's .p12 in the write-only `ecf_credentials`
// table (service role), exactly like ecf-send reads it.
//
// Routed from soft.alcover.do/fe/autenticacion/api/{semilla,
// validacioncertificado} by the Vercel rewrites in vercel.json. config.toml
// sets verify_jwt=false: DGII sends no Supabase JWT — auth IS this flow.
//
// MUST be validated against DGII CerteCF: the exact token envelope and the
// multipart field name of the signed seed can vary by DGII version and may
// need a small tweak once tested (same caveat ecf-send carries). Pinned to
// dgii-ecf@1.8.0 so the receptor and issuer can't drift across a lib bump.
import { createClient } from 'npm:@supabase/supabase-js@2';
// deno-lint-ignore no-explicit-any
import * as dgii from 'npm:dgii-ecf@1.8.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { ...CORS, 'Content-Type': 'application/xml' } });
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
/** Decode a JWT payload (no verification) to fill the DGII token envelope. */
function jwtPayload(token: string): { exp?: number; iat?: number } {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part));
  } catch { return {}; }
}
const isoFromUnix = (s?: number) => (s ? new Date(s * 1000).toISOString() : '');

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);
  const path = url.pathname.toLowerCase();
  const wantSemilla = path.endsWith('/semilla');
  const wantValidate = path.endsWith('/validacioncertificado');
  if (!wantSemilla && !wantValidate) return json({ ok: false, error: 'ruta no encontrada' }, 404);

  // Read the certificate via the service role (bypasses the write-only RLS).
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const supa = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '');
  const profileId = url.searchParams.get('profileId') || 'team';
  const { data: cred, error: credErr } = await supa
    .from('ecf_credentials').select('*').eq('profile_id', profileId).maybeSingle();
  if (credErr) return json({ ok: false, error: `cert read: ${credErr.message}` }, 500);
  if (!cred) return json({ ok: false, error: 'No hay certificado .p12 cargado.' }, 412);

  let p12Path = '';
  try {
    p12Path = await Deno.makeTempFile({ suffix: '.p12' });
    await Deno.writeFile(p12Path, b64ToBytes(cred.p12_base64), { mode: 0o600 }); // owner-only: it's the signing private key
    const certs = new (dgii as any).P12Reader(cred.password).getKeyFromFile(p12Path);
    const auth = new (dgii as any).CustomAuthentication(certs);

    // GET /semilla — hand the caller the seed XML for them to sign.
    if (wantSemilla) {
      if (req.method !== 'GET') return json({ ok: false, error: 'method not allowed' }, 405);
      return xmlResponse(auth.generateSeed());
    }

    // POST /validacioncertificado — the caller's signed seed → a bearer token.
    if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
    const contentType = req.headers.get('content-type') || '';
    const rawBody = await req.text();
    let signedXml = rawBody;
    if (contentType.includes('multipart/form-data')) {
      const sr = new (dgii as any).SenderReceiver();
      const parsed = await sr.parseMultipart(rawBody, contentType);
      signedXml = parsed?.xmlContent || rawBody;
    }
    const token = await auth.verifySignedSeed(signedXml);
    const p = jwtPayload(token);
    return json({ token, expira: isoFromUnix(p.exp), expedido: isoFromUnix(p.iat) });
  } catch (e) {
    return json({ ok: false, error: `autenticacion: ${e}` }, 401);
  } finally {
    if (p12Path) await Deno.remove(p12Path).catch(() => {});
  }
});
