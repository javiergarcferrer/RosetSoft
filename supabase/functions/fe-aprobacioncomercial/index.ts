// fe-aprobacioncomercial — RECEPTOR service: receives an Aprobación/Rechazo
// Comercial (ACECF) that a buyer (or the DGII test harness, certification steps
// 10–11) issued against an e-CF WE emitted, validates the bearer token, and
// acknowledges. Per the DGII process the acknowledgement is a simple status
// ("OK" satisfactory / "Error" not) — this is NOT a DGII-validated document
// like the acuse de recibo, just our receipt confirmation.
//
// Auth is the same bearer token fe-autenticacion mints. Routed from
// soft.alcover.do/fe/aprobacioncomercial/api/ecf by vercel.json; verify_jwt=
// false. MUST be validated against DGII CerteCF — the exact acknowledgement
// envelope may need a tweak once tested. Pinned to dgii-ecf@1.8.0. Persisting
// the received approval to the DB is a follow-up.
import { createClient } from 'npm:@supabase/supabase-js@2';
// deno-lint-ignore no-explicit-any
import * as dgii from 'npm:dgii-ecf@1.8.0';

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  const url = new URL(req.url);
  const profileId = url.searchParams.get('profileId') || 'team';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const supa = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '');
  const { data: cred, error: credErr } = await supa
    .from('ecf_credentials').select('*').eq('profile_id', profileId).maybeSingle();
  if (credErr) return json({ ok: false, error: `cert read: ${credErr.message}` }, 500);
  if (!cred) return json({ ok: false, error: 'No hay certificado .p12 cargado.' }, 412);

  let p12Path = '';
  try {
    p12Path = await Deno.makeTempFile({ suffix: '.p12' });
    await Deno.writeFile(p12Path, b64ToBytes(cred.p12_base64));
    const certs = new (dgii as any).P12Reader(cred.password).getKeyFromFile(p12Path);

    // Bearer token (minted by fe-autenticacion) must be present + unexpired.
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!bearer) return json({ ok: false, error: 'token requerido' }, 401);
    const auth = new (dgii as any).CustomAuthentication(certs);
    const { isExpired } = await auth.verifyToken(bearer);
    if (isExpired) return json({ ok: false, error: 'token vencido' }, 401);

    // Pull the ACECF out of the request (validated structurally by parsing it).
    const sr = new (dgii as any).SenderReceiver();
    const contentType = req.headers.get('content-type') || '';
    const rawBody = await req.text();
    let xmlContent = rawBody;
    if (contentType.includes('multipart/form-data')) {
      const parsed = await sr.parseMultipart(rawBody, contentType);
      xmlContent = parsed?.xmlContent || rawBody;
    }
    if (!xmlContent || !/<ACECF/i.test(xmlContent)) {
      return json({ estado: 'Error', mensaje: 'Aprobación comercial no reconocida.' }, 400);
    }

    // Acknowledge receipt. (Persisting to the DB is a follow-up.)
    return json({ estado: 'OK' });
  } catch (e) {
    return json({ estado: 'Error', mensaje: `aprobacioncomercial: ${e}` }, 500);
  } finally {
    if (p12Path) await Deno.remove(p12Path).catch(() => {});
  }
});
