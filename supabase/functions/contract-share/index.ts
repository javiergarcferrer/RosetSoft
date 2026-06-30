// contract-share — backs the public, signable contract link (#/contrato/<token>).
//
//   GET  ?token=…  → a whitelisted, CLIENT-FACING bundle: the company + client
//                    header, the financed total, the amortized payment schedule,
//                    the contract body, and the signed state.
//   POST ?token=…  → the client SIGNS: { signerName, signerDoc, signatureDataUrl,
//                    signedPdfBase64 }. The drawn signature (PNG) is archived in
//                    the `images` bucket and the rendered, signed PDF in the
//                    `documents` bucket; the plan row is stamped signed and the
//                    fresh bundle returned. A second POST after signing is a 409.
//
// Why a function (mirrors quote-share): the link is used logged-OUT but the DB is
// behind RLS. This runs with the service role and gates on the secret token, so
// the public only ever gets this whitelist — never raw table access. No
// margin/cost leakage: the plan figures are already final (USD), and the quote's
// internal pricing is never read here.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type Admin = ReturnType<typeof createClient>;
type Row = Record<string, unknown>;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';

/** Public Storage URL for an object in a public bucket. */
function publicUrl(bucket: string, path: string | null | undefined): string | null {
  if (!path) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodeURIComponent(path)}`;
}

/** Decode a base64 (optionally data-URL) string to bytes. */
function decodeBase64(input: string): Uint8Array {
  const comma = input.indexOf(',');
  const b64 = input.startsWith('data:') && comma >= 0 ? input.slice(comma + 1) : input;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function fetchOne(admin: Admin, table: string, id: unknown): Promise<Row | null> {
  if (!id) return null;
  const { data } = await admin.from(table).select('*').eq('id', id).maybeSingle();
  return (data as Row) || null;
}

// The DOP rate for the contract: the quote's frozen accept-time snapshot once
// accepted, else live (Banco Popular venta) — same rule as the dealer surfaces.
function ratesFor(quote: Row | null, settings: Row | null): { USD: number; DOP: number } {
  const ex = ((settings?.exchange_rate || settings?.bsc || settings?.bpd || {}) as { buy?: unknown; sell?: unknown });
  const liveDop = num(ex.sell) || num(ex.buy) || 60.0;
  if (quote?.accepted_at && quote?.rates && typeof quote.rates === 'object') {
    return quote.rates as { USD: number; DOP: number };
  }
  return { USD: 1, DOP: liveDop };
}

async function buildBundle(admin: Admin, plan: Row): Promise<Record<string, unknown>> {
  const [customerRow, quoteRow, settingsRow] = await Promise.all([
    fetchOne(admin, 'customers', plan.customer_id),
    fetchOne(admin, 'quotes', plan.quote_id),
    admin.from('settings').select('*').eq('profile_id', plan.profile_id).maybeSingle().then((r) => (r.data as Row) || null),
  ]);

  const customer = customerRow ? {
    name: customerRow.name, company: customerRow.company, address: customerRow.address,
    city: customerRow.city, state: customerRow.state, country: customerRow.country,
    email: customerRow.email, phone: customerRow.phone, rnc: customerRow.rnc ?? customerRow.cedula ?? null,
  } : null;

  const settings = settingsRow ? {
    companyName: settingsRow.company_name,
    companyAddress: settingsRow.company_address,
    companyPhone: settingsRow.company_phone,
    companyEmail: settingsRow.company_email,
    companyRnc: settingsRow.company_rnc,
    logoImageId: settingsRow.logo_image_id,
  } : {};

  return {
    plan: {
      id: plan.id,
      number: plan.number,
      status: plan.status,
      scheduleMode: plan.schedule_mode === 'custom' ? 'custom' : 'amortized',
      totalUsd: num(plan.total_usd),
      downPaymentPct: num(plan.down_payment_pct),
      downPaymentUsd: num(plan.down_payment_usd),
      financedUsd: num(plan.financed_usd),
      monthlyRatePct: num(plan.monthly_rate_pct),
      installmentCount: num(plan.installment_count),
      firstDueAt: plan.first_due_at,
      schedule: Array.isArray(plan.schedule) ? plan.schedule : [],
      // The body is derived from the plan on the client (resolvePaymentPlanView)
      // unless the dealer overrode it; pass both so the public link can decide.
      contractBody: plan.contract_body || '',
      contractBodyCustom: plan.contract_body_custom === true,
      // Signed state — surfaced so the link shows the stamped signature + a link
      // to the archived PDF once signed.
      signedAt: plan.signed_at,
      signerName: plan.signer_name,
      signerDoc: plan.signer_doc,
      signatureUrl: publicUrl('images', signaturePath(plan)),
      signedPdfUrl: publicUrl('documents', plan.signed_pdf_path as string),
    },
    rates: ratesFor(quoteRow, settingsRow),
    quote: quoteRow ? { number: quoteRow.number, currencyCode: quoteRow.currency_code } : null,
    customer,
    settings,
  };
}

// The signature image is stored at a deterministic path in the images bucket.
function signaturePath(plan: Row): string | null {
  const id = plan.signature_image_id as string | null;
  if (!id) return null;
  return `${id}.png`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'server not configured' }, 500);

  const token = (new URL(req.url).searchParams.get('token') || '').trim();
  if (!token) return json({ error: 'missing token' }, 400);
  // A real share token is a long random string; a short/garbage value can't be
  // one, so reject it before hitting the DB (cheap abuse/enumeration guard).
  if (token.length < 20) return json({ error: 'not found' }, 404);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Resolve the plan by its secret token; a disabled link reads as 404 so a
  // revoked link is indistinguishable from a bad one.
  const { data: planData, error: pErr } = await admin
    .from('payment_plans')
    .select('*')
    .eq('share_token', token)
    .eq('share_enabled', true)
    .maybeSingle();
  if (pErr) return json({ error: 'lookup failed' }, 500);
  if (!planData) return json({ error: 'not found' }, 404);
  const plan = planData as Row;

  if (req.method === 'POST') {
    // Already signed → immutable. Don't overwrite a stored signature.
    if (plan.signed_at) return json({ error: 'already signed' }, 409);

    let body: {
      signerName?: string; signerDoc?: string;
      signatureDataUrl?: string; signedPdfBase64?: string;
    } = {};
    try { body = await req.json(); } catch { /* empty body */ }

    const signerName = String(body.signerName || '').trim();
    if (!signerName) return json({ error: 'signer name required' }, 400);
    if (!body.signatureDataUrl) return json({ error: 'signature required' }, 400);

    // Cap the uploads BEFORE decoding/uploading so a hostile payload can't pin
    // the function on a giant base64 string or fill the bucket. A drawn PNG
    // signature is a few KB; the rendered contract PDF a few MB. Base64 inflates
    // ~4/3, so cap the encoded string length (a cheap, pre-decode bound).
    const MAX_SIGNATURE_CHARS = 1_400_000;  // ~1 MB decoded
    const MAX_PDF_CHARS = 14_000_000;       // ~10 MB decoded
    if (body.signatureDataUrl.length > MAX_SIGNATURE_CHARS) return json({ error: 'signature too large' }, 413);
    if (body.signedPdfBase64 && body.signedPdfBase64.length > MAX_PDF_CHARS) return json({ error: 'signed PDF too large' }, 413);

    const signatureImageId = `sig-${plan.id}`;
    const sigPath = `${signatureImageId}.png`;

    // Archive the drawn signature in the (public-read) images bucket + its
    // metadata row so the dealer's <ImageView> and the contract render it.
    const sigBytes = decodeBase64(body.signatureDataUrl);
    const upSig = await admin.storage.from('images').upload(sigPath, sigBytes, {
      contentType: 'image/png', upsert: true,
    });
    if (upSig.error) return json({ error: 'signature upload failed' }, 500);
    await admin.from('images').upsert({
      id: signatureImageId, kind: 'contract-signature', owner_id: plan.id,
      content_type: 'image/png', size: sigBytes.byteLength, storage_path: sigPath,
    });

    // Archive the rendered, signed PDF in the documents bucket (optional — the
    // client app may post it; the signature record stands on its own otherwise).
    let signedPdfPath: string | null = null;
    if (body.signedPdfBase64) {
      const pdfBytes = decodeBase64(body.signedPdfBase64);
      const path = `contract-${plan.id}-${Date.now()}.pdf`;
      const upPdf = await admin.storage.from('documents').upload(path, pdfBytes, {
        contentType: 'application/pdf', upsert: true,
      });
      if (!upPdf.error) signedPdfPath = path;
    }

    // Advisory only: x-forwarded-for is client-spoofable, so signed_ip is a
    // best-effort breadcrumb for the audit trail, NOT a trusted identifier.
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    const patch: Row = {
      signed_at: new Date().toISOString(),
      signer_name: signerName,
      signer_doc: String(body.signerDoc || '').trim() || null,
      signature_image_id: signatureImageId,
      signed_ip: ip,
      status: 'active',
      updated_at: new Date().toISOString(),
    };
    if (signedPdfPath) patch.signed_pdf_path = signedPdfPath;

    const { error: uErr } = await admin.from('payment_plans').update(patch).eq('id', plan.id);
    if (uErr) return json({ error: 'save failed' }, 500);

    const { data: fresh } = await admin.from('payment_plans').select('*').eq('id', plan.id).maybeSingle();
    return json(await buildBundle(admin, (fresh as Row) || plan));
  }

  return json(await buildBundle(admin, plan));
});
