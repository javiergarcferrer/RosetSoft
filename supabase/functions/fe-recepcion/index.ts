// fe-recepcion — RECEPTOR service: receives a signed e-CF that another emisor
// (or the DGII test harness, certification step 9) issued to us, validates it,
// and returns a SIGNED Acuse de Recibo (ARECF) declaring "e-CF Recibido" or
// "e-CF No Recibido" + a reason code. This is the inbound counterpart of
// ecf-send (which only ISSUES); together they make AlcoverSoft a full e-CF
// emisor+receptor.
//
// Auth: the caller must present the bearer token minted by fe-autenticacion
// (verified here with the SAME certificate via CustomAuthentication.verifyToken).
// The ARECF itself is built by the library's SenderReceiver.getECFDataFromXML
// (unsigned) and then XAdES-signed with our cert, just like an outbound e-CF.
//
// Routed from soft.alcover.do/fe/recepcion/api/ecf by vercel.json. verify_jwt=
// false (DGII sends no Supabase JWT). MUST be validated against DGII CerteCF —
// the status/reason logic below is best-effort and may need tuning once the
// real test set runs. Pinned to dgii-ecf@1.8.0. Persisting received e-CFs to
// the DB is a follow-up (does not affect the acuse the DGII validates).
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
function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { ...CORS, 'Content-Type': 'application/xml' } });
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
const digits = (s: unknown) => String(s || '').replace(/\D/g, '');

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  const url = new URL(req.url);
  const profileId = url.searchParams.get('profileId') || 'team';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const supa = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '');

  // The cert (to verify the bearer token + sign the acuse) and our own RNC
  // (the receptor) come together — read both with the service role.
  const [{ data: cred, error: credErr }, { data: settingsRow }] = await Promise.all([
    supa.from('ecf_credentials').select('*').eq('profile_id', profileId).maybeSingle(),
    supa.from('settings').select('company_rnc').eq('profile_id', profileId).maybeSingle(),
  ]);
  if (credErr) return json({ ok: false, error: `cert read: ${credErr.message}` }, 500);
  if (!cred) return json({ ok: false, error: 'No hay certificado .p12 cargado.' }, 412);
  const ourRnc = digits(settingsRow?.company_rnc);

  let p12Path = '';
  try {
    p12Path = await Deno.makeTempFile({ suffix: '.p12' });
    await Deno.writeFile(p12Path, b64ToBytes(cred.p12_base64), { mode: 0o600 }); // owner-only: it's the signing private key
    const certs = new (dgii as any).P12Reader(cred.password).getKeyFromFile(p12Path);

    // 1) Bearer token (minted by fe-autenticacion) must be present + unexpired.
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!bearer) return json({ ok: false, error: 'token requerido' }, 401);
    const auth = new (dgii as any).CustomAuthentication(certs);
    const { isExpired } = await auth.verifyToken(bearer);
    if (isExpired) return json({ ok: false, error: 'token vencido' }, 401);

    // 2) Extract the inbound e-CF XML (multipart upload, or a raw XML body).
    const sr = new (dgii as any).SenderReceiver();
    const contentType = req.headers.get('content-type') || '';
    const rawBody = await req.text();
    let xmlContent = rawBody;
    if (contentType.includes('multipart/form-data')) {
      const parsed = await sr.parseMultipart(rawBody, contentType);
      xmlContent = parsed?.xmlContent || rawBody;
    }

    // Identify the document for dedup + archival (best-effort regex extraction).
    const pick = (re: RegExp) => (re.exec(xmlContent)?.[1] || '').trim();
    const eNcfIn = pick(/<eNCF>\s*([^<]+)<\/eNCF>/i);
    const rncEmisorIn = pick(/<RNCEmisor>\s*(\d+)\s*<\/RNCEmisor>/i);

    // 3) Decide the acuse status. Default Recibido; flag No Recibido + a code on
    //    a bad signature or a buyer RNC that isn't us. (Duplicate detection,
    //    NoReceivedCode 3, needs persistence — a follow-up.)
    const { ReceivedStatus, NoReceivedCode } = dgii as any;
    let status: string = ReceivedStatus['e-CF Recibido'];
    let code: string | undefined;
    try {
      const v = (dgii as any).validateXMLCertificate?.(xmlContent, { silent: true });
      if (v && v.isValid === false) {
        status = ReceivedStatus['e-CF No Recibido'];
        code = NoReceivedCode['Error de Firma Digital'];
      }
    } catch { /* if the validator throws, fall through to the RNC check */ }
    if (!code && ourRnc) {
      const m = /<RNCComprador>\s*(\d+)\s*<\/RNCComprador>/i.exec(xmlContent);
      if (m && m[1] !== ourRnc) {
        status = ReceivedStatus['e-CF No Recibido'];
        code = NoReceivedCode['RNC Comprador no corresponde'];
      }
    }

    // Reject a document we've already received (NoReceivedCode 3 — Envío duplicado).
    if (!code && eNcfIn && rncEmisorIn) {
      const { data: dup } = await supa.from('ecf_received')
        .select('id').eq('profile_id', profileId).eq('rnc_emisor', rncEmisorIn).eq('e_ncf', eNcfIn).maybeSingle();
      if (dup) {
        status = ReceivedStatus['e-CF No Recibido'];
        code = NoReceivedCode['Envío duplicado'];
      }
    }

    // 4) Build the ARECF (unsigned) and XAdES-sign it with our certificate.
    const arecf = sr.getECFDataFromXML(xmlContent, ourRnc, status, code);
    const signedArecf = new (dgii as any).Signature(certs.key, certs.cert).signXml(arecf);

    // Best-effort archive — never block the acuse on a write failure.
    if (eNcfIn) {
      try {
        await supa.from('ecf_received').insert({
          id: crypto.randomUUID(), profile_id: profileId, e_ncf: eNcfIn,
          tipo_ecf: pick(/<TipoeCF>\s*(\d+)/i) || null, rnc_emisor: rncEmisorIn || null,
          rnc_comprador: ourRnc || null, monto_total: Number(pick(/<MontoTotal>\s*([\d.]+)/i)) || null,
          estado: status, codigo_no_recibido: code || null, xml: xmlContent,
        });
      } catch { /* duplicate or write error — non-blocking */ }
    }
    return xmlResponse(signedArecf);
  } catch (e) {
    return json({ ok: false, error: `recepcion: ${e}` }, 500);
  } finally {
    if (p12Path) await Deno.remove(p12Path).catch(() => {});
  }
});
