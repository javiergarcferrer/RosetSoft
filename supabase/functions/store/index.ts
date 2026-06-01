// store — backs the public, no-login storefront ("Tienda", #/tienda).
//
//   GET → the public catalog: the products from the dealer's HOUSE-ACCOUNT
//         quotes (the customer chosen in Settings — e.g. Alcover quoting itself
//         for store stock), shaped as the rows that core/store's `resolveStore`
//         eats (quotes + lines + the attached orders, for availability).
//
// Why a function: the storefront is used logged-OUT, but the DB is behind RLS
// (`to authenticated`). This runs with the service role and returns only
// public-safe catalog data — product names, photos (the `images` bucket is
// already public-read), and RETAIL prices. Margin is baked into every price and
// cost/margin are never copied out, so markup never leaves the server. No token:
// it's a public catalog, exactly what a storefront shows anyone. Until the dealer
// designates a house customer in Settings it returns `configured: false` and an
// empty catalog, so nothing is exposed by default.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type Admin = ReturnType<typeof createClient>;
type Row = Record<string, unknown>;

// Single-tenant: all rows live under the shared 'team' profile (see
// db/database.ts TEAM_PROFILE_ID). The storefront has no token to derive it from.
const TEAM_PROFILE_ID = 'team';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clampPct = (v: unknown): number => Math.min(100, Math.max(0, num(v)));
const toMs = (v: unknown): number | null => {
  if (!v) return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

// Shallow-pick keys off a camelCase JSONB component.
function pick(obj: Row | null | undefined, keys: string[]): Row {
  const out: Row = {};
  if (!obj) return out;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const COMPONENT_KEYS = [
  'id', 'name', 'reference', 'subtype', 'dimensions',
  'imageId', 'swatchImageId', 'qty', 'isOptional', 'alternativeGroup', 'isSelectedAlternative',
];

// Map a raw snake_case quote_lines row to the camelCase shape resolveStore eats,
// baking `factor` (quote margin × line margin × line discount) into every price
// so the storefront shows the final retail figure and the markup never leaks.
function storeLine(row: Row, factor: number): Row {
  const rawComponents = Array.isArray(row.components) ? row.components as Row[] : [];
  const components = rawComponents.map((c) => {
    const safe = pick(c, COMPONENT_KEYS);
    safe.unitPrice = num(c.unitPrice) * factor;
    if (c.priceMin != null) safe.priceMin = num(c.priceMin) * factor;
    if (c.priceMax != null) safe.priceMax = num(c.priceMax) * factor;
    return safe;
  });
  return {
    id: row.id,
    quoteId: row.quote_id,
    kind: row.kind,
    family: row.family,
    reference: row.reference,
    name: row.name,
    subtype: row.subtype,
    dimensions: row.dimensions,
    imageId: row.image_id,
    extraImageIds: Array.isArray(row.extra_image_ids) ? row.extra_image_ids : null,
    swatchImageId: row.swatch_image_id,
    qty: row.qty,
    unitPrice: num(row.unit_price) * factor,
    priceMin: row.price_min != null ? num(row.price_min) * factor : null,
    priceMax: row.price_max != null ? num(row.price_max) * factor : null,
    components,
    isOptional: row.is_optional ?? false,
    alternativeGroup: row.alternative_group ?? null,
    isSelectedAlternative: row.is_selected_alternative ?? false,
    setGroup: row.set_group ?? null,
  };
}

async function buildCatalog(admin: Admin): Promise<Row> {
  const { data: settingsRow } = await admin
    .from('settings').select('*').eq('profile_id', TEAM_PROFILE_ID).maybeSingle();
  const settings = (settingsRow as Row) || {};
  // Storefront FX: Banco Popular venta (same source as the app), with the legacy
  // shapes as fallbacks. Static figure; the page formats USD → DOP with it.
  const ex = (settings.exchange_rate || settings.bsc || settings.bpd || {}) as { buy?: unknown; sell?: unknown };
  const base = {
    storeName: settings.company_name || 'Tienda',
    logoImageId: settings.logo_image_id || null,
    rates: { USD: 1, DOP: Number(ex.sell) || Number(ex.buy) || 60.0 },
  };

  const storeCustomerId = settings.store_customer_id;
  if (!storeCustomerId) {
    return { ...base, configured: false, quotes: [], lines: [], orders: [] };
  }

  // The house customer's quotes (minus dead ones). The store shows whatever the
  // dealer parks under this customer; declined/archived are excluded.
  const { data: quoteRows } = await admin
    .from('quotes').select('id, order_id, status, margin_pct')
    .eq('profile_id', TEAM_PROFILE_ID)
    .eq('customer_id', storeCustomerId);
  const quotes = ((quoteRows || []) as Row[])
    .filter((q) => q.status !== 'declined' && q.status !== 'archived');
  if (!quotes.length) {
    return { ...base, configured: true, quotes: [], lines: [], orders: [] };
  }

  const quoteIds = quotes.map((q) => q.id);
  const orderIds = [...new Set(quotes.map((q) => q.order_id).filter(Boolean))];
  const marginByQuote = new Map<unknown, number>();
  for (const q of quotes) marginByQuote.set(q.id, num(q.margin_pct));

  const [linesRes, ordersRes] = await Promise.all([
    admin.from('quote_lines').select('*').in('quote_id', quoteIds),
    orderIds.length
      ? admin.from('orders').select('*').in('id', orderIds)
      : Promise.resolve({ data: [] as Row[] }),
  ]);

  const lines = ((linesRes.data || []) as Row[]).map((row) => {
    const qMargin = marginByQuote.get(row.quote_id) || 0;
    const factor = (1 + qMargin / 100)
      * (1 + num(row.line_margin_pct) / 100)
      * (1 - clampPct(row.line_discount_pct) / 100);
    return storeLine(row, factor);
  });

  const orders = ((ordersRes.data || []) as Row[]).map((o) => ({
    id: o.id,
    status: o.status,
    placedAt: toMs(o.placed_at),
    confirmedAt: toMs(o.confirmed_at),
    inTransitAt: toMs(o.in_transit_at),
    inCustomsAt: toMs(o.in_customs_at),
    receivedAt: toMs(o.received_at),
  }));

  return {
    ...base,
    configured: true,
    quotes: quotes.map((q) => ({ id: q.id, orderId: q.order_id || null })),
    lines,
    orders,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: 'server not configured' }, 500);
  }
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    return json(await buildCatalog(admin));
  } catch (e) {
    console.error('[store] catalog build failed:', e);
    return json({ error: 'catalog failed' }, 500);
  }
});
