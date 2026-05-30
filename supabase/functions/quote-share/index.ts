// quote-share — backs the public, interactive client quote link (#/q/<token>).
//
//   GET  ?token=…  → a whitelisted, CLIENT-FACING bundle for the viewer.
//   POST ?token=…  → applies the recipient's picks DIRECTLY to the quote and
//                    returns the fresh bundle. The owner chose ONE version over
//                    a separate copy ("always on the same page"), so fabrics,
//                    optionals, and alternatives edit the real quote_lines in
//                    place rather than living in a side channel.
//
// Why a function: the share link is used logged-OUT, but the DB is behind RLS
// (`to authenticated`). This runs with the service role and gates on the secret
// share token, so the public never gets raw table access — only this whitelist.
//
// CRITICAL — no margin/cost leakage: the bundle bakes BOTH line- and quote-level
// margin into each unit price and zeroes the margin fields, so the client sees
// the real quoted prices but the markup never leaves the server. Costs, internal
// notes, commission, etc. are simply never copied into the bundle.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
// The pick REDUCER (pure domain Model) lives in ./pick.ts and is the SERVER half
// of a rule the client's src/core/quote/actions.js (applyAction) also implements
// — one rule, two layers (persisted rows here; the client-facing bundle there).
// This file is the imperative SHELL: auth, I/O, the catalog price fetch,
// persistence, and the client-bundle projection. Parity of the two layers is
// pinned by tests/quotePickParity.test.js.
import { num, rootOf, applyPicks, rootsForMaterialPicks } from './pick.ts';
import type { GradeInfo } from './pick.ts';

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

// Pick a subset of an object's keys (shallow; for camelCase JSONB components).
function pick<T extends Record<string, unknown>>(obj: T | null | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!obj) return out;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const COMPONENT_KEYS = [
  'id', 'name', 'reference', 'subtype', 'dimensions', 'description',
  'imageId', 'swatchImageId', 'qty', 'unitPrice', 'isOptional', 'optionalOffered',
  'alternativeGroup', 'isSelectedAlternative', 'materialOptions',
];

// Enrich a line/component's materialOptions with a per-option `delta`: the
// list-price difference between that grade's SKU and the base grade's SKU,
// scaled by the SAME margin factor baked into the unit price — so the client
// sees a real, margin-consistent +/- and the markup never leaks. Graceful:
// no catalog row / no resolved base or grade price -> that option keeps no
// delta and renders label-only.
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
  row: Row,
  marginFactor: number,
  priceByRootGrade: Map<string, Map<string, number>>,
): Record<string, unknown> {
  const rawComponents = Array.isArray(row.components) ? row.components as Row[] : [];
  const components = rawComponents.map((c) => {
    const safe = pick(c, COMPONENT_KEYS);
    safe.unitPrice = num(c.unitPrice) * marginFactor;
    // Component price RANGE (material-less sub-piece) — margin baked into BOTH
    // ends like unitPrice, so the client link shows "min – max" with no markup.
    if (c.priceMin != null) safe.priceMin = num(c.priceMin) * marginFactor;
    if (c.priceMax != null) safe.priceMax = num(c.priceMax) * marginFactor;
    safe.materialOptions = withDeltas(
      c.materialOptions as Row | null, c.reference, marginFactor, priceByRootGrade,
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
    // Margin baked in; the margin field is zeroed so the viewer reproduces the
    // same total without ever seeing the markup.
    unitPrice: num(row.unit_price) * marginFactor,
    // Price RANGE for a material-less line — margin baked into both ends so the
    // client link widens to "min – max" with the markup still invisible.
    priceMin: row.price_min != null ? num(row.price_min) * marginFactor : null,
    priceMax: row.price_max != null ? num(row.price_max) * marginFactor : null,
    lineMarginPct: 0,
    lineDiscountPct: row.line_discount_pct,
    materialOptions: withDeltas(
      row.material_options as Row | null, row.reference, marginFactor, priceByRootGrade,
    ),
    components,
    isOptional: row.is_optional ?? false,
    // The dealer-designated "client may toggle this optional in/out" marker.
    // Lets the viewer turn an add-on ON and back OFF (a real toggle) — without
    // it, clearing is_optional on include would erase the fact it was optional.
    optionalOffered: row.optional_offered ?? false,
    alternativeGroup: row.alternative_group ?? null,
    isSelectedAlternative: row.is_selected_alternative ?? false,
    setGroup: row.set_group ?? null,
  };
}

// Catalog list price (+ wholesale cost) per root→grade, for the given roots.
// Scoped to the roots actually in play, which also dodges PostgREST's default
// 1000-row cap silently truncating a large price list.
async function priceMapForRoots(
  admin: Admin,
  profileId: unknown,
  roots: Set<string>,
): Promise<Map<string, Map<string, GradeInfo>>> {
  const map = new Map<string, Map<string, GradeInfo>>();
  if (!roots.size) return map;
  const orFilter = [...roots].map((r) => `reference.like.${r}*`).join(',');
  const { data: prods } = await admin
    .from('products')
    .select('reference, price_usd, cost')
    .eq('profile_id', profileId)
    .or(orFilter);
  for (const p of (prods || []) as Row[]) {
    const m = /^(\d{8})([A-Za-z])$/.exec(String(p.reference || '').trim());
    if (!m) continue;
    const root = m[1];
    const grade = m[2].toUpperCase();
    if (!map.has(root)) map.set(root, new Map());
    map.get(root)!.set(grade, { price: num(p.price_usd), cost: num(p.cost) });
  }
  return map;
}

// Just the list-price view of a root→grade map, for delta computation.
function priceOnly(full: Map<string, Map<string, GradeInfo>>): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [root, grades] of full) {
    const m = new Map<string, number>();
    for (const [g, info] of grades) m.set(g, info.price);
    out.set(root, m);
  }
  return out;
}

// Build the whole client-facing bundle for a resolved quote row. Re-reads the
// (possibly just-mutated) lines, so GET and the POST response share one path.
async function buildBundle(admin: Admin, quote: Row): Promise<Record<string, unknown>> {
  const quoteMargin = num(quote.margin_pct);
  const baseFactor = 1 + quoteMargin / 100;

  const { data: lineRows } = await admin
    .from('quote_lines')
    .select('*')
    .eq('quote_id', quote.id)
    .order('sort_order', { ascending: true });

  // Catalog prices for every material option's grade → per-option delta.
  const roots = new Set<string>();
  for (const row of (lineRows || []) as Row[]) {
    const mo = row.material_options as { options?: unknown[] } | null;
    if (mo?.options?.length) { const r = rootOf(row.reference); if (r) roots.add(r); }
    const comps = Array.isArray(row.components) ? row.components as Row[] : [];
    for (const c of comps) {
      const cmo = c.materialOptions as { options?: unknown[] } | null;
      if (cmo?.options?.length) { const r = rootOf(c.reference); if (r) roots.add(r); }
    }
  }
  const priceByRootGrade = priceOnly(await priceMapForRoots(admin, quote.profile_id, roots));

  const lines = ((lineRows || []) as Row[]).map((row) =>
    clientLine(row, baseFactor * (1 + num(row.line_margin_pct) / 100), priceByRootGrade),
  );

  const fetchOne = async (table: string, id: unknown) => {
    if (!id) return null;
    const { data } = await admin.from(table).select('*').eq('id', id).maybeSingle();
    return (data as Row) || null;
  };
  const [customerRow, professionalRow, sellerRow, settingsRow, containerRows] = await Promise.all([
    fetchOne('customers', quote.customer_id),
    fetchOne('professionals', quote.professional_id),
    fetchOne('profiles', quote.created_by_user_id),
    admin.from('settings').select('*').eq('profile_id', quote.profile_id).maybeSingle().then((r) => (r.data as Row) || null),
    // The attached order's containers, so the link can track the shipment. Only
    // the number (a label) and the ISO 6346 code leave the server — the client
    // tracks via the keyless hl-track function; no order/cost data is exposed.
    quote.order_id
      ? admin.from('containers').select('number, code').eq('order_id', quote.order_id).then((r) => (r.data as Row[]) || [])
      : Promise.resolve([] as Row[]),
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
    rateLogoImageId: settingsRow.rate_logo_image_id,
    quoteFooter: settingsRow.quote_footer,
  } : {};

  // FX rate for the link: LIVE (Banco Popular venta) until the quote is
  // ACCEPTED, then the frozen accept-time snapshot — the same rule as
  // displayRatesFor, so the public link agrees with the dealer's surfaces and a
  // sent quote the client is still deciding on tracks today's rate.
  const ex = (settingsRow?.exchange_rate || settingsRow?.bsc || settingsRow?.bpd || {}) as { buy?: unknown; sell?: unknown };
  const liveDop = Number(ex.sell) || Number(ex.buy) || 60.0;
  const rates = (quote.accepted_at && quote.rates) ? quote.rates : { USD: 1, DOP: liveDop };

  // Containers with a real code only (label + code); the client validates the
  // ISO 6346 number and renders one tracking panel each.
  const containers = (containerRows as Row[])
    .filter((c) => String(c.code || '').trim())
    .map((c) => ({ number: c.number, code: c.code }));

  return {
    quote: {
      id: quote.id,
      number: quote.number,
      status: quote.status,
      currencyCode: quote.currency_code,
      rates,
      terms: quote.terms,
      marginPct: 0,
      discountPct: quote.discount_pct,
      shipping: quote.shipping,
    },
    lines,
    customer,
    professional,
    seller,
    settings,
    containers,
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
  const { data: quoteData, error: qErr } = await admin
    .from('quotes')
    .select('*')
    .eq('share_token', token)
    .eq('share_enabled', true)
    .maybeSingle();
  if (qErr) return json({ error: 'lookup failed' }, 500);
  if (!quoteData) return json({ error: 'not found' }, 404);
  const quote = quoteData as Row;

  // ---- POST: apply the recipient's picks to the REAL quote_lines ----------
  if (req.method === 'POST') {
    let body: {
      alternatives?: Record<string, unknown>;
      optionals?: Record<string, unknown>;
      materials?: Record<string, unknown>;
    } = {};
    try { body = await req.json(); } catch { /* empty body ok */ }

    const { data: lineRowsData } = await admin
      .from('quote_lines')
      .select('*')
      .eq('quote_id', quote.id);
    const lineRows = (lineRowsData || []) as Row[];

    // Which catalog roots the material picks touch — resolved by the Model so we
    // fetch exactly those prices (the I/O stays in this shell).
    const matRoots = rootsForMaterialPicks(lineRows, body);
    const priceMap = await priceMapForRoots(admin, quote.profile_id, matRoots);

    // Apply the recipient's picks — the pure REDUCER (Model), mirrored by the
    // client's applyAction. Validates against what the dealer offered and
    // returns one snake_case patch per touched line.
    const patches = applyPicks(lineRows, body, priceMap);

    // Persist — one UPDATE per touched line, scoped to this quote.
    for (const [id, patch] of patches) {
      const { error } = await admin.from('quote_lines').update(patch).eq('id', id).eq('quote_id', quote.id);
      if (error) return json({ error: 'save failed' }, 500);
    }
    // Touch the quote so the dealer's list reflects recent activity.
    await admin.from('quotes').update({ updated_at: new Date().toISOString() }).eq('id', quote.id);

    return json(await buildBundle(admin, quote));
  }

  // ---- GET: build the client-facing bundle --------------------------------
  return json(await buildBundle(admin, quote));
});
