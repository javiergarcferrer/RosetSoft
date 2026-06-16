// togo-embed — backs the PUBLIC, no-login Togo configurator widget (embeddable in
// the dealer's website via an <iframe>).
//
//   GET  → the public Togo catalog: the active `togo_models` with their RETAIL
//          price (list × the dealer's default margin; markup baked in, never the
//          list/cost), the FX rate and store identity. No token — it's public.
//   POST → a quote REQUEST (lead): the visitor's contact + their plan layout
//          becomes a DRAFT QUOTE in the dealer's pipeline (the configurator is a
//          view of the quoting engine, so a web lead feeds the same engine). The
//          line is a normal modular Togo line priced at LIST + the quote's margin,
//          so the dealer reviews/sends it exactly like any other quote.
//
// Why a function: used logged-OUT, but the DB is behind RLS (`to authenticated`).
// This runs with the service role and exposes only public-safe data + writes a
// draft the dealer must act on. verify_jwt=false (see config.toml).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type Admin = ReturnType<typeof createClient>;
type Row = Record<string, unknown>;

const TEAM_PROFILE_ID = 'team';
const MAX_ITEMS = 40;

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

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clampPct = (v: unknown): number => Math.min(500, Math.max(0, num(v)));
const newId = (): string => crypto.randomUUID();
const str = (v: unknown, max = 200): string => String(v ?? '').slice(0, max);

// The cheapest priced SKU under a family root (8-digit prefix) = the model's base
// grade. Mirrors lib/catalog: a graded model's SKUs share the root; ascending
// price → the cheapest grade is the quoted base.
function baseProductFor(root: string | null, products: Row[]): Row | null {
  if (!root) return null;
  let best: Row | null = null;
  for (const p of products) {
    const ref = String(p.reference || '');
    if (!ref.startsWith(root)) continue;
    if (!best || num(p.price_usd) < num(best.price_usd)) best = p;
  }
  return best;
}

async function loadContext(admin: Admin) {
  const [settingsRes, modelsRes, productsRes] = await Promise.all([
    admin.from('settings').select('*').eq('profile_id', TEAM_PROFILE_ID).maybeSingle(),
    admin.from('togo_models').select('*').eq('profile_id', TEAM_PROFILE_ID),
    admin.from('products').select('reference, name, price_usd, dimensions').eq('profile_id', TEAM_PROFILE_ID),
  ]);
  const settings = (settingsRes.data as Row) || {};
  const ex = (settings.exchange_rate || settings.bsc || settings.bpd || {}) as { buy?: unknown; sell?: unknown };
  const rates = { USD: 1, DOP: Number(ex.sell) || Number(ex.buy) || 60.0 };
  const marginPct = clampPct(settings.default_margin_pct);
  const models = ((modelsRes.data || []) as Row[])
    .filter((m) => m.active !== false && m.svg)
    .sort((a, b) => num(a.sort_order) - num(b.sort_order));
  const products = (productsRes.data || []) as Row[];
  return { settings, rates, marginPct, models, products };
}

async function buildCatalog(admin: Admin): Promise<Row> {
  const { settings, rates, marginPct, models, products } = await loadContext(admin);
  const retail = (list: number) => Math.round(list * (1 + marginPct / 100) * 100) / 100;
  const out = models.map((m) => {
    const base = baseProductFor(m.product_root as string | null, products);
    const list = base ? num(base.price_usd) : null;
    return {
      id: m.id,
      name: m.name,
      svg: m.svg,
      widthCm: num(m.width_cm),
      depthCm: num(m.depth_cm),
      priceUsd: list != null ? retail(list) : null,
      bound: !!base,
    };
  });
  return {
    configured: out.length > 0,
    storeName: settings.company_name || 'Togo',
    logoImageId: settings.logo_image_id || null,
    rates,
    models: out,
  };
}

// Assign the next per-(profile, number) quote number, retrying on a unique clash.
async function insertQuoteWithNumber(admin: Admin, base: Row): Promise<number> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data } = await admin.from('quotes')
      .select('number').eq('profile_id', TEAM_PROFILE_ID)
      .order('number', { ascending: false }).limit(1);
    const max = num((data as Row[])?.[0]?.number) || 1000;
    const number = Math.max(1000, max) + 1;
    const { error } = await admin.from('quotes').insert({ ...base, number });
    if (!error) return number;
    if (error.code !== '23505') throw error; // not a number clash → real failure
  }
  throw new Error('could not assign a quote number');
}

async function captureLead(admin: Admin, body: Row): Promise<Row> {
  const contact = (body.contact || {}) as Row;
  const name = str(contact.name, 120).trim();
  const phone = str(contact.phone, 40).trim();
  const email = str(contact.email, 160).trim();
  const note = str(body.note, 1000).trim();
  const items = Array.isArray(body.items) ? (body.items as Row[]).slice(0, MAX_ITEMS) : [];
  if (!name || (!phone && !email)) return Promise.reject(Object.assign(new Error('contact required'), { status: 400 }));
  if (!items.length) return Promise.reject(Object.assign(new Error('empty configuration'), { status: 400 }));

  const { rates, marginPct, models, products } = await loadContext(admin);
  const modelById = new Map(models.map((m) => [String(m.id), m]));

  // Build the modular line — one module per placed piece, LIST price (the quote's
  // margin applies on top), plan geometry inline (round-trips like any Togo line).
  const components = items.map((it) => {
    const m = modelById.get(String(it.modelId));
    if (!m) return null;
    const base = baseProductFor(m.product_root as string | null, products);
    const w = num(m.width_cm), d = num(m.depth_cm);
    return {
      id: newId(),
      name: base ? String(base.name || m.name) : String(m.name),
      reference: base ? String(base.reference || '') : '',
      subtype: '',
      dimensions: w && d ? `${w}×${d} cm` : '',
      qty: 1,
      unitPrice: base ? num(base.price_usd) : 0,
      moduleGroup: newId(),
      moduleName: String(m.name),
      plan: { pieceId: String(m.id), x: num(it.x), y: num(it.y), rot: num(it.rot), widthCm: w, depthCm: d },
    };
  }).filter(Boolean);
  if (!components.length) return Promise.reject(Object.assign(new Error('no known models'), { status: 400 }));

  const nowISO = new Date().toISOString();
  const quoteId = newId();
  const notes = [
    'Solicitud web (configurador Togo)',
    `Nombre: ${name}`,
    phone ? `Teléfono: ${phone}` : '',
    email ? `Correo: ${email}` : '',
    note ? `Nota: ${note}` : '',
  ].filter(Boolean).join('\n');

  const number = await insertQuoteWithNumber(admin, {
    id: quoteId, profile_id: TEAM_PROFILE_ID, customer_id: null, professional_id: null,
    status: 'draft', currency_code: 'USD', order_type: 'floor',
    margin_pct: marginPct, discount_pct: 0, shipping: 0,
    rates, notes, created_at: nowISO, updated_at: nowISO,
  });

  const { error: lineErr } = await admin.from('quote_lines').insert({
    id: newId(), quote_id: quoteId, kind: 'item', sort_order: 0,
    family: 'Togo', reference: '', name: 'Togo — solicitud web', subtype: '',
    dimensions: '', description: '', page_ref: '', image_id: null,
    qty: 1, unit_price: 0, line_margin_pct: 0, line_discount_pct: 0,
    notes: '', components, is_optional: false,
  });
  if (lineErr) throw lineErr;

  return { ok: true, number };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'server not configured' }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    if (req.method === 'GET') return json(await buildCatalog(admin));
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return json(await captureLead(admin, body as Row));
    }
    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    const status = (e as { status?: number })?.status || 500;
    if (status >= 500) console.error('[togo-embed] failed:', e);
    return json({ error: (e as Error)?.message || 'failed' }, status);
  }
});
