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

// 8-digit family root of an upholstered SKU ("15420000G" -> "15420000").
// Material options only ride on graded SKUs, so a non-matching reference
// yields null and the line renders its options without a price delta.
function rootOf(ref: unknown): string | null {
  const m = /^(\d{8})[A-Za-z]$/.exec(String(ref || '').trim());
  return m ? m[1] : null;
}

// Enrich a line/component's materialOptions with a per-option `delta`: the
// list-price difference between that grade's SKU and the base grade's SKU,
// scaled by the SAME margin factor baked into the unit price — so the client
// sees a real, margin-consistent +/- and the markup never leaks. Graceful:
// no catalog row / no resolved base or grade price -> that option keeps no
// delta and renders label-only, exactly as the on-screen preview degrades.
function withDeltas(
  mo: Record<string, unknown> | null | undefined,
  reference: unknown,
  marginFactor: number,
  priceByRootGrade: Map<string, Map<string, number>>,
): Record<string, unknown> | null {
  if (!mo) return null;
  const options = Array.isArray(mo.options) ? mo.options as Record<string, unknown>[] : [];
  if (!options.length) return mo;
  const grades = priceByRootGrade.get(rootOf(reference) || '');
  if (!grades) return mo;
  const basePrice = grades.get(String(mo.baseGrade || '').toUpperCase());
  if (typeof basePrice !== 'number') return mo;
  const pricedOptions = options.map((o) => {
    const p = grades.get(String(o.grade || '').toUpperCase());
    if (typeof p !== 'number') return o;
    return { ...o, delta: (p - basePrice) * marginFactor };
  });
  return { ...mo, options: pricedOptions };
}

// Map a raw snake_case quote_lines row to the client-facing camelCase shape,
// baking `marginFactor` into every price so margin is invisible downstream.
function clientLine(
  row: Record<string, unknown>,
  marginFactor: number,
  priceByRootGrade: Map<string, Map<string, number>>,
): Record<string, unknown> {
  const rawComponents = Array.isArray(row.components) ? row.components as Record<string, unknown>[] : [];
  const components = rawComponents.map((c) => {
    const safe = pick(c, COMPONENT_KEYS);
    safe.unitPrice = num(c.unitPrice) * marginFactor;
    safe.materialOptions = withDeltas(
      c.materialOptions as Record<string, unknown> | null, c.reference, marginFactor, priceByRootGrade,
    );
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
    materialOptions: withDeltas(
      row.material_options as Record<string, unknown> | null, row.reference, marginFactor, priceByRootGrade,
    ),
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
    let body: {
      alternatives?: Record<string, unknown>;
      optionals?: Record<string, unknown>;
      materials?: Record<string, unknown>;
    } = {};
    try { body = await req.json(); } catch { /* empty body ok */ }

    const { data: lineRows } = await admin
      .from('quote_lines')
      .select('id, is_optional, alternative_group, material_options, components')
      .eq('quote_id', quote.id);
    const lines = lineRows || [];
    // Valid targets: alternative groups → their member line ids; optional ids;
    // material-bearing ids (line OR component) → their valid grades.
    const groupMembers = new Map<string, Set<string>>();
    const optionalIds = new Set<string>();
    const materialGrades = new Map<string, Set<string>>();
    const addMaterialTarget = (
      id: unknown,
      mo: { baseGrade?: unknown; options?: unknown[] } | null | undefined,
    ): void => {
      if (!id || !mo || !Array.isArray(mo.options) || !mo.options.length) return;
      const set = new Set<string>();
      if (mo.baseGrade != null) set.add(String(mo.baseGrade));
      for (const o of mo.options) {
        const g = (o as { grade?: unknown })?.grade;
        if (g != null) set.add(String(g));
      }
      if (set.size) materialGrades.set(String(id), set);
    };
    for (const l of lines) {
      if (l.alternative_group) {
        const g = String(l.alternative_group);
        if (!groupMembers.has(g)) groupMembers.set(g, new Set());
        groupMembers.get(g)!.add(String(l.id));
      }
      if (l.is_optional) optionalIds.add(String(l.id));
      addMaterialTarget(l.id, l.material_options as { baseGrade?: unknown; options?: unknown[] } | null);
      const comps = Array.isArray(l.components) ? l.components as Record<string, unknown>[] : [];
      for (const c of comps) {
        addMaterialTarget(c.id, c.materialOptions as { baseGrade?: unknown; options?: unknown[] } | null);
      }
    }

    const alternatives: Record<string, string> = {};
    for (const [g, lineId] of Object.entries(body.alternatives || {})) {
      if (groupMembers.get(g)?.has(String(lineId))) alternatives[g] = String(lineId);
    }
    const optionals: Record<string, boolean> = {};
    for (const [lineId, on] of Object.entries(body.optionals || {})) {
      if (optionalIds.has(lineId)) optionals[lineId] = !!on;
    }
    const materials: Record<string, string> = {};
    for (const [id, grade] of Object.entries(body.materials || {})) {
      if (materialGrades.get(String(id))?.has(String(grade))) materials[String(id)] = String(grade);
    }

    const client_selections = { alternatives, optionals, materials, updatedAt: Date.now() };
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

  // Catalog prices for every material option's grade, so each option carries a
  // real price delta. Scoped to the SKU roots actually used here — both to keep
  // the query small AND to dodge PostgREST's default 1000-row cap silently
  // truncating a large price list. No options anywhere -> no query.
  const roots = new Set<string>();
  for (const row of lineRows || []) {
    const mo = row.material_options as { options?: unknown[] } | null;
    if (mo?.options?.length) { const r = rootOf(row.reference); if (r) roots.add(r); }
    const comps = Array.isArray(row.components) ? row.components as Record<string, unknown>[] : [];
    for (const c of comps) {
      const cmo = c.materialOptions as { options?: unknown[] } | null;
      if (cmo?.options?.length) { const r = rootOf(c.reference); if (r) roots.add(r); }
    }
  }
  const priceByRootGrade = new Map<string, Map<string, number>>();
  if (roots.size) {
    const orFilter = [...roots].map((r) => `reference.like.${r}*`).join(',');
    const { data: prods } = await admin
      .from('products')
      .select('reference, price_usd')
      .eq('profile_id', quote.profile_id)
      .or(orFilter);
    for (const p of prods || []) {
      const m = /^(\d{8})([A-Za-z])$/.exec(String(p.reference || '').trim());
      if (!m) continue;
      const root = m[1];
      const grade = m[2].toUpperCase();
      if (!priceByRootGrade.has(root)) priceByRootGrade.set(root, new Map());
      priceByRootGrade.get(root)!.set(grade, num(p.price_usd));
    }
  }

  const lines = (lineRows || []).map((row) =>
    clientLine(row, baseFactor * (1 + num(row.line_margin_pct) / 100), priceByRootGrade),
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
