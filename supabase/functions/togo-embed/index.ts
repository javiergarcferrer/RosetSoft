// togo-embed — backs the PUBLIC, no-login Togo configurator widget (embeddable in
// the dealer's website via an <iframe>).
//
//   GET  → the public Togo catalog: the active `togo_models` with their RETAIL
//          price (list × the dealer's default margin; markup baked in, never the
//          list/cost), the FX rate and store identity. No token — it's public.
//   POST → a quote REQUEST (lead): the visitor's contact + their plan layout is
//          stored as a PENDING row in `togo_requests` — held on the dealer's Togo
//          workspace (Solicitudes tab), NOT injected into Cotizaciones. The dealer
//          triages it there and promotes the ones they want into the regular quote
//          pipeline (a one-tap "Pasar a cotización" that replays the placements
//          through the same configurator engine → a draft quote).
//
// Why a function: used logged-OUT, but the DB is behind RLS (`to authenticated`).
// This runs with the service role and exposes only public-safe data + writes a
// pending lead the dealer must act on. verify_jwt=false (see config.toml).

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

// The Ligne Roset fabric/leather grade letters (mirrors lib/subtype GRADE_GROUPS:
// Telas A–R, Microfibras S, Pieles U–X; T/Y/Z skipped). A SKU "8 digits + grade
// letter" is a graded variant; ascending price → the cheapest grade is the base.
const GRADES = new Set('ABCDEFGHIJKLMNOPQRSUVWX'.split(''));

function splitGrade(ref: string): { root: string; grade: string } {
  const m = /^(\d{8})([A-Za-z])$/.exec(ref);
  if (m && GRADES.has(m[2].toUpperCase())) return { root: m[1], grade: m[2].toUpperCase() };
  return { root: ref, grade: '' };
}

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

// The graded family at a root → the SAME CatalogFamily shape the app builds, but
// with RETAIL per-grade prices baked in (so the widget reprices identically to
// the internal configurator). `byGrade` is a plain object (JSON); the client
// rehydrates it to a Map for productForGrade.
function familyFor(root: string | null, products: Row[], retail: (n: number) => number) {
  if (!root) return null;
  const byGrade: Record<string, { priceUsd: number; reference: string }> = {};
  let name = '';
  for (const p of products) {
    const ref = String(p.reference || '');
    const { root: r, grade } = splitGrade(ref);
    if (r !== root || !grade) continue;
    if (!byGrade[grade]) byGrade[grade] = { priceUsd: retail(num(p.price_usd)), reference: ref };
    if (!name && p.name) name = String(p.name);
  }
  const grades = Object.keys(byGrade).sort((a, b) => byGrade[a].priceUsd - byGrade[b].priceUsd);
  if (!grades.length) return null;
  return { root, name, graded: grades.length >= 2, grades, byGrade };
}

async function loadContext(admin: Admin) {
  const [settingsRes, modelsRes, productsRes, materialsRes, fabricsRes] = await Promise.all([
    admin.from('settings').select('*').eq('profile_id', TEAM_PROFILE_ID).maybeSingle(),
    admin.from('togo_models').select('*').eq('profile_id', TEAM_PROFILE_ID),
    admin.from('products').select('reference, name, price_usd, dimensions').eq('profile_id', TEAM_PROFILE_ID),
    admin.from('materials').select('id, name, grade, category, composition, price, price_unit, colors, not_in_pricelist_at, discontinued_at').eq('profile_id', TEAM_PROFILE_ID),
    admin.from('model_fabrics').select('id, pattern_names').eq('profile_id', TEAM_PROFILE_ID),
  ]);
  const settings = (settingsRes.data as Row) || {};
  const ex = (settings.exchange_rate || settings.bsc || settings.bpd || {}) as { buy?: unknown; sell?: unknown };
  const rates = { USD: 1, DOP: Number(ex.sell) || Number(ex.buy) || 60.0 };
  const marginPct = clampPct(settings.default_margin_pct);
  const models = ((modelsRes.data || []) as Row[])
    .filter((m) => m.active !== false && m.svg)
    .sort((a, b) => num(a.sort_order) - num(b.sort_order));
  const products = (productsRes.data || []) as Row[];
  const materials = (materialsRes.data || []) as Row[];
  const fabrics = (fabricsRes.data || []) as Row[];
  return { settings, rates, marginPct, models, products, materials, fabrics };
}

async function buildCatalog(admin: Admin): Promise<Row> {
  const { settings, rates, marginPct, models, products, materials, fabrics } = await loadContext(admin);
  const retail = (list: number) => Math.round(list * (1 + marginPct / 100) * 100) / 100;

  // Offered fabrics per family root (model_fabrics.pattern_names, already stored
  // fabricKey-normalized) → the picker's per-model fabric allowlist.
  const offeredByRoot = new Map<string, string[]>();
  for (const f of fabrics) {
    offeredByRoot.set(String(f.id), Array.isArray(f.pattern_names) ? (f.pattern_names as string[]) : []);
  }

  // The public-safe materials catalog — only OFFERED rows (in price list + on
  // site), colors reduced to {name, code}. Swatches render from the public Ligne
  // Roset CDN (swatchUrl(code)) client-side; no Storage bytes cross.
  const offeredMaterials = materials
    .filter((r) => r.not_in_pricelist_at == null && r.discontinued_at == null)
    .map((r) => ({
      id: r.id, name: r.name, grade: r.grade || null, category: r.category,
      composition: r.composition || null, price: r.price ?? null, priceUnit: r.price_unit || null,
      colors: Array.isArray(r.colors)
        ? (r.colors as Row[]).map((c) => ({ name: String(c?.name || ''), code: String(c?.code || '') }))
        : [],
    }));

  const out = models.map((m) => {
    const root = (m.product_root as string | null) || null;
    const base = baseProductFor(root, products);
    const list = base ? num(base.price_usd) : null;
    const family = familyFor(root, products, retail);
    return {
      id: m.id,
      name: m.name,
      svg: m.svg,
      widthCm: num(m.width_cm),
      depthCm: num(m.depth_cm),
      priceUsd: list != null ? retail(list) : null,
      bound: !!base,
      root,
      family,                                                  // { root, name, graded, grades, byGrade } | null
      offeredFabricKeys: root ? (offeredByRoot.get(root) || []) : [],
    };
  });
  return {
    configured: out.length > 0,
    storeName: settings.company_name || 'Togo',
    logoImageId: settings.logo_image_id || null,
    rates,
    models: out,
    materials: offeredMaterials,
  };
}

async function captureLead(admin: Admin, body: Row): Promise<Row> {
  const contact = (body.contact || {}) as Row;
  const name = str(contact.name, 120).trim();
  const phone = str(contact.phone, 40).trim();
  const email = str(contact.email, 160).trim();
  const note = str(body.note, 1000).trim();
  const rawItems = Array.isArray(body.items) ? (body.items as Row[]).slice(0, MAX_ITEMS) : [];
  if (!name || (!phone && !email)) return Promise.reject(Object.assign(new Error('contact required'), { status: 400 }));
  if (!rawItems.length) return Promise.reject(Object.assign(new Error('empty configuration'), { status: 400 }));

  // Keep only placements of CURRENTLY-known models, normalized to the exact shape
  // the dealer pane replays through the configurator VM. (camelCase keys survive
  // the JSONB round-trip — the app's rowMapping only converts top-level columns.)
  const { models } = await loadContext(admin);
  const known = new Set(models.map((m) => String(m.id)));
  const items = rawItems
    .map((it) => {
      const base = { modelId: String(it.modelId || ''), x: num(it.x), y: num(it.y), rot: num(it.rot) };
      const mat = it.material && typeof it.material === 'object' ? it.material as Row : null;
      if (mat && (mat.grade || mat.fabric)) {
        return {
          ...base,
          material: { grade: str(mat.grade, 8), fabric: str(mat.fabric, 200), code: str(mat.code, 32) },
        };
      }
      return base;
    })
    .filter((it) => known.has(it.modelId));
  if (!items.length) return Promise.reject(Object.assign(new Error('no known models'), { status: 400 }));

  const est = num(body.estimateUsd);
  const nowISO = new Date().toISOString();
  const { error } = await admin.from('togo_requests').insert({
    id: newId(), profile_id: TEAM_PROFILE_ID, status: 'pending',
    contact: { name, phone, email }, items, note: note || null,
    estimate_usd: est > 0 ? est : null,
    created_at: nowISO, updated_at: nowISO,
  });
  if (error) throw error;

  return { ok: true };
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
