// quote-share — backs the public, interactive client quote link (#/q/<token>).
//
//   GET  ?token=…  → a whitelisted, CLIENT-FACING bundle for the viewer.
//   POST ?token=…  → persists the recipient's option picks (plan A: stored
//                    separately in quotes.client_selections, never mutating
//                    the dealer's own lines).
//
// Why a function: the share link is used logged-OUT, but the database is
// behind RLS (`to authenticated`). Rather than open anon reads on quotes
// (which would expose every quote to anyone with the public key), this runs
// with the service role and gates on the secret share token.
//
// CRITICAL — no margin/cost leakage: the bundle bakes BOTH line- and
// quote-level margin into each unit price and zeroes the margin fields, so
// the client sees the real quoted prices but the markup never leaves the
// server. Costs, internal notes, commission, etc. are simply never copied in.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

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

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Pick a subset of an object's keys (snake→camel handled by the explicit map
// in the callers; this is just a safe shallow picker for camelCase JSONB).
function pick<T extends Record<string, unknown>>(obj: T | null | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!obj) return out;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const COMPONENT_KEYS = [
  'id', 'name', 'reference', 'subtype', 'dimensions', 'description',
  'imageId', 'swatchImageId', 'qty', 'unitPrice', 'isOptional', 'materialOptions',
];

// Map a raw snake_case quote_lines row to the client-facing camelCase shape,
// baking `marginFactor` into every price so margin is invisible downstream.
function clientLine(row: Record<string, unknown>, marginFactor: number): Record<string, unknown> {
  const rawComponents = Array.isArray(row.components) ? row.components as Record<string, unknown>[] : [];
  const components = rawComponents.map((c) => {
    const safe = pick(c, COMPONENT_KEYS);
    safe.unitPrice = num(c.unitPrice) * marginFactor;
    return safe;
  });
  return {
    id: row.id,
    kind: row.kind,
    sortOrder: row.sort_order,
    family: row.family,
    reference: row.reference,
    name: row.name,
    subtype: row.subtype,
    dimensions: row.dimensions,
    description: row.description,
    imageId: row.image_id,
    swatchImageId: row.swatch_image_id,
    qty: row.qty,
    // Margin baked in; the margin field is zeroed so the viewer's pricing
    // reproduces the same total without ever seeing the markup.
    unitPrice: num(row.unit_price) * marginFactor,
    lineMarginPct: 0,
    lineDiscountPct: row.line_discount_pct,
    materialOptions: row.material_options ?? null,
    components,
    isOptional: row.is_optional ?? false,
    alternativeGroup: row.alternative_group ?? null,
    isSelectedAlternative: row.is_selected_alternative ?? false,
    setGroup: row.set_group ?? null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: 'server not configured' }, 500);
  }
  const token = (new URL(req.url).searchParams.get('token') || '').trim();
  if (!token) return json({ error: 'missing token' }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Resolve the quote by its secret token; a disabled link reads as 404 so a
  // revoked link is indistinguishable from a bad one.
  const { data: quote, error: qErr } = await admin
    .from('quotes')
    .select('*')
    .eq('share_token', token)
    .eq('share_enabled', true)
    .maybeSingle();
  if (qErr) return json({ error: 'lookup failed' }, 500);
  if (!quote) return json({ error: 'not found' }, 404);

  // ---- POST: persist the recipient's picks (validated against this quote) --
  if (req.method === 'POST') {
    let body: { alternatives?: Record<string, unknown>; optionals?: Record<string, unknown> } = {};
    try { body = await req.json(); } catch { /* empty body ok */ }

    const { data: lineRows } = await admin
      .from('quote_lines')
      .select('id, is_optional, alternative_group')
      .eq('quote_id', quote.id);
    const lines = lineRows || [];
    // Valid targets: alternative groups → their member line ids; optional ids.
    const groupMembers = new Map<string, Set<string>>();
    const optionalIds = new Set<string>();
    for (const l of lines) {
      if (l.alternative_group) {
        const g = String(l.alternative_group);
        if (!groupMembers.has(g)) groupMembers.set(g, new Set());
        groupMembers.get(g)!.add(String(l.id));
      }
      if (l.is_optional) optionalIds.add(String(l.id));
    }

    const alternatives: Record<string, string> = {};
    for (const [g, lineId] of Object.entries(body.alternatives || {})) {
      if (groupMembers.get(g)?.has(String(lineId))) alternatives[g] = String(lineId);
    }
    const optionals: Record<string, boolean> = {};
    for (const [lineId, on] of Object.entries(body.optionals || {})) {
      if (optionalIds.has(lineId)) optionals[lineId] = !!on;
    }

    const client_selections = { alternatives, optionals, updatedAt: Date.now() };
    const { error: upErr } = await admin
      .from('quotes')
      .update({ client_selections })
      .eq('id', quote.id);
    if (upErr) return json({ error: 'save failed' }, 500);
    return json({ ok: true, clientSelections: client_selections });
  }

  // ---- GET: build the client-facing bundle --------------------------------
  const quoteMargin = num(quote.margin_pct);
  const baseFactor = 1 + quoteMargin / 100;

  const { data: lineRows, error: lErr } = await admin
    .from('quote_lines')
    .select('*')
    .eq('quote_id', quote.id)
    .order('sort_order', { ascending: true });
  if (lErr) return json({ error: 'lines failed' }, 500);

  const lines = (lineRows || []).map((row) =>
    clientLine(row, baseFactor * (1 + num(row.line_margin_pct) / 100)),
  );

  // Related rows — each best-effort, all whitelisted to client-facing fields.
  const fetchOne = async (table: string, id: unknown) => {
    if (!id) return null;
    const { data } = await admin.from(table).select('*').eq('id', id).maybeSingle();
    return data || null;
  };
  const [customerRow, professionalRow, sellerRow, settingsRow] = await Promise.all([
    fetchOne('customers', quote.customer_id),
    fetchOne('professionals', quote.professional_id),
    fetchOne('profiles', quote.created_by_user_id),
    admin.from('settings').select('*').eq('profile_id', quote.profile_id).maybeSingle().then((r) => r.data || null),
  ]);

  const customer = customerRow ? {
    name: customerRow.name, company: customerRow.company, address: customerRow.address,
    city: customerRow.city, state: customerRow.state, zip: customerRow.zip,
    country: customerRow.country, email: customerRow.email, phone: customerRow.phone,
  } : null;
  const professional = professionalRow ? { name: professionalRow.name, company: professionalRow.company } : null;
  const seller = sellerRow ? { name: sellerRow.name } : null;
  const settings = settingsRow ? {
    companyName: settingsRow.company_name, logoImageId: settingsRow.logo_image_id,
    quoteFooter: settingsRow.quote_footer,
  } : {};

  const bundle = {
    quote: {
      id: quote.id,
      number: quote.number,
      status: quote.status,
      currencyCode: quote.currency_code,
      rates: quote.rates,
      terms: quote.terms,
      // Margin is baked into the lines above, so the quote-level margin is
      // zeroed here; the client discount + shipping stay.
      marginPct: 0,
      discountPct: quote.discount_pct,
      shipping: quote.shipping,
      clientSelections: quote.client_selections ?? null,
    },
    lines,
    customer,
    professional,
    seller,
    settings,
  };
  return json(bundle);
});
