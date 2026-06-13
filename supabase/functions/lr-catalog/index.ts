// lr-catalog — returns the Ligne Roset fabric/leather catalog as clean JSON for
// the Materials admin importer, in two modes:
//
//   { url }      → the fabrics offered on ONE product page.
//   { all: true} → the WHOLE US catalog (a sitemap-driven sweep).
//
// How the site exposes it (two same-origin AJAX endpoints behind each product):
//   GET /<lang>/ajax/patterns/product/<productCode>           → [patternId, …]
//   GET /<lang>/ajax/colors/variant/<variantId>/pattern/<pid> → [{ … }, …]
// The colors payload carries pattern.{name,type,composition,remark} plus each
// color's name and ".../c_<code>.jpg" — that <code> is exactly the
// MaterialColor.code we store (the swatch path swatchImage.ts builds), so the
// import lines up 1:1. Those endpoints send no CORS, so the browser can't read
// them; we fetch server-side (no CORS in Deno) and re-serve with CORS.
//
// Full-catalog facts (measured): the US catalog has ~66 distinct fabrics, a
// fabric's color list is GLOBAL (identical on every product that offers it), and
// ~6 products cover all 66. So the sweep maps every fabric from the product
// sitemap (cheap patterns calls), set-covers to a handful of "anchor" products,
// reads each anchor's variant, then pulls each fabric's colors exactly once.
//
// Locked to ligne-roset.com (no SSRF). All catalog mapping/merge logic lives in
// the pure, unit-tested src/lib/lrCatalog.ts; this function only fetches+shapes.
//
// Auth: a signed-in team member only. The single-product mode backs the quote
// builder's per-model fabric lookup (any role) and the { all:true } sweep backs
// the Materials admin importer; neither is public. We verify the caller's JWT
// in-code (gateway verify_jwt stays off so the CORS preflight passes) so
// anonymous internet traffic can't drive the expensive sitemap sweep.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

const ALLOWED_HOSTS = new Set(['www.ligne-roset.com', 'ligne-roset.com']);
const DEFAULT_ORIGIN = 'https://www.ligne-roset.com';
const DEFAULT_PREFIX = 'us';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const FETCH_TIMEOUT_MS = 20_000;
const SWEEP_CONCURRENCY = 24; // cheap ~150-byte patterns calls
const COLORS_CONCURRENCY = 8;
const MAX_PRODUCTS = 6000; // safety valve on the sitemap sweep

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function fetchText(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest' },
      signal: ctrl.signal,
    });
    return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : '' };
  } catch {
    return { ok: false, status: 0, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string): Promise<unknown> {
  const r = await fetchText(url);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.text);
  } catch {
    return null;
  }
}

/** Run `fn` over `items` with bounded concurrency. */
async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

// ---- pattern accumulation -------------------------------------------------

type PatAcc = {
  name: string;
  type: string | null;
  composition: string | null;
  remark: string | null;
  description: string | null;
  colors: Map<string, string | null>;
};

function accumulate(acc: Map<number, PatAcc>, arr: unknown): void {
  if (!Array.isArray(arr)) return;
  for (const v of arr) {
    const cp = (v as Record<string, unknown>)?.colorizedPattern as Record<string, unknown> | undefined;
    const pat = cp?.pattern as Record<string, unknown> | undefined;
    const id = Number(pat?.id);
    const name = String(pat?.name ?? '').trim();
    if (!name || !Number.isFinite(id)) continue;
    let e = acc.get(id);
    if (!e) {
      e = {
        name,
        type: pat?.type != null ? String(pat.type) : null,
        composition: pat?.composition != null ? String(pat.composition) : null,
        remark: pat?.remark != null ? String(pat.remark) : null,
        description: pat?.description != null ? String(pat.description) : null,
        colors: new Map(),
      };
      acc.set(id, e);
    }
    const code = String(cp?.colorPicture ?? '').match(/c_([0-9A-Za-z]+)\.jpg/)?.[1];
    if (code && !e.colors.has(code)) {
      const cn = cp?.colorName;
      e.colors.set(code, cn != null ? String(cn).trim() : null);
    }
  }
}

function toPatterns(acc: Map<number, PatAcc>) {
  return [...acc.values()]
    .map((e) => ({
      name: e.name,
      type: e.type,
      composition: e.composition,
      remark: e.remark,
      description: e.description,
      colors: [...e.colors].map(([code, name]) => ({ code, name })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- product page resolution ----------------------------------------------

type Resolved = { origin: string; prefix: string; productCode: string; variantId: string; title: string | null };

async function resolveProductPage(href: string): Promise<Resolved | { error: string; status: number }> {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { error: 'invalid url', status: 400 };
  }
  if (!ALLOWED_HOSTS.has(u.hostname)) return { error: 'url must be a ligne-roset.com product page', status: 400 };
  const prefix = u.pathname.split('/').filter(Boolean)[0] || DEFAULT_PREFIX;
  const page = await fetchText(u.href);
  if (!page.ok) return { error: `product page returned ${page.status || 'error'}`, status: 502 };
  const html = page.text;
  const productCode =
    html.match(/patterns\/product\/(\d+)/)?.[1] ?? href.match(/(\d+)(?=[/?#]|$)/)?.[1] ?? null;
  const variantId =
    html.match(/product-variant\/(\d+)/)?.[1] ?? html.match(/\/ajax\/colors\/variant\/(\d+)\/pattern/)?.[1] ?? null;
  if (!productCode || !variantId) return { error: 'could not locate the product/variant id on the page', status: 422 };
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || null;
  return { origin: u.origin, prefix, productCode, variantId, title };
}

const patternsUrl = (o: string, p: string, code: string) => `${o}/${p}/ajax/patterns/product/${code}`;
const colorsUrl = (o: string, p: string, variant: string, pid: number) =>
  `${o}/${p}/ajax/colors/variant/${variant}/pattern/${pid}`;

// ---- single-product mode --------------------------------------------------

async function importProduct(href: string): Promise<Response> {
  const r = await resolveProductPage(href);
  if ('error' in r) return json({ error: r.error }, r.status);
  const ids = await getJson(patternsUrl(r.origin, r.prefix, r.productCode));
  if (!Array.isArray(ids)) return json({ error: 'unexpected patterns response' }, 502);
  const acc = new Map<number, PatAcc>();
  await mapPool(ids as number[], COLORS_CONCURRENCY, async (pid) => {
    accumulate(acc, await getJson(colorsUrl(r.origin, r.prefix, r.variantId, pid)));
  });
  return json({
    source: { mode: 'product', url: href, productCode: r.productCode, variantId: r.variantId, title: r.title },
    patterns: toPatterns(acc),
  });
}

// ---- full-catalog mode ----------------------------------------------------

function greedyCover(codeToPids: Map<string, Set<number>>): string[] {
  const uncovered = new Set<number>();
  for (const s of codeToPids.values()) for (const p of s) uncovered.add(p);
  const codes = [...codeToPids.keys()];
  const chosen: string[] = [];
  while (uncovered.size) {
    let best: string | null = null;
    let bestGain = 0;
    for (const c of codes) {
      let gain = 0;
      for (const p of codeToPids.get(c)!) if (uncovered.has(p)) gain++;
      if (gain > bestGain) {
        bestGain = gain;
        best = c;
      }
    }
    if (!best || bestGain === 0) break;
    chosen.push(best);
    for (const p of codeToPids.get(best)!) uncovered.delete(p);
  }
  return chosen;
}

async function importCatalog(): Promise<Response> {
  const origin = DEFAULT_ORIGIN;
  const prefix = DEFAULT_PREFIX;

  // 1) Every product URL from the sitemap → product code (trailing digits).
  const sm = await fetchText(`${origin}/${prefix}/sitemap-products.xml`);
  if (!sm.ok) return json({ error: `product sitemap returned ${sm.status || 'error'}` }, 502);
  const codeToUrl = new Map<string, string>();
  for (const loc of sm.text.match(/<loc>([^<]+)<\/loc>/g) || []) {
    const url = loc.replace(/<\/?loc>/g, '');
    if (!url.includes('/p/')) continue;
    const code = url.replace(/\/+$/, '').match(/(\d+)$/)?.[1];
    if (code && !codeToUrl.has(code)) codeToUrl.set(code, url);
  }
  const codes = [...codeToUrl.keys()].slice(0, MAX_PRODUCTS);
  if (!codes.length) return json({ error: 'no product URLs found in sitemap' }, 502);

  // 2) Sweep the cheap patterns endpoint for every product.
  const codeToPids = new Map<string, Set<number>>();
  await mapPool(codes, SWEEP_CONCURRENCY, async (code) => {
    const ids = await getJson(patternsUrl(origin, prefix, code));
    if (Array.isArray(ids) && ids.length) {
      codeToPids.set(code, new Set(ids.map((n) => Number(n)).filter(Number.isFinite)));
    }
  });
  if (!codeToPids.size) return json({ error: 'no fabrics discovered in catalog sweep' }, 502);

  // 3) Candidate products per fabric, anchors (the fewest products covering
  //    everything) first, then any other offerer as a fallback. A variant
  //    comes from a product page, so a single failed page must not drop a
  //    fabric — we just try the next product that offers it.
  const anchors = greedyCover(codeToPids);
  const anchorSet = new Set(anchors);
  const pidToCodes = new Map<number, string[]>();
  for (const [code, pids] of codeToPids) {
    for (const pid of pids) {
      const arr = pidToCodes.get(pid);
      if (arr) arr.push(code);
      else pidToCodes.set(pid, [code]);
    }
  }
  for (const arr of pidToCodes.values()) {
    arr.sort((a, b) => (anchorSet.has(b) ? 1 : 0) - (anchorSet.has(a) ? 1 : 0));
  }

  // Resolve a product's variant once, cached (null = page failed).
  const variantCache = new Map<string, string | null>();
  const variantFor = async (code: string): Promise<string | null> => {
    if (!variantCache.has(code)) {
      const r = await resolveProductPage(codeToUrl.get(code)!);
      variantCache.set(code, 'error' in r ? null : r.variantId);
    }
    return variantCache.get(code) ?? null;
  };
  for (const code of anchors) await variantFor(code); // warm cache, anchors first

  // 4) Pull each fabric's colors once — trying its candidate products in order
  //    until one yields data (the payload carries the pattern metadata too).
  const acc = new Map<number, PatAcc>();
  const discovered = pidToCodes.size;
  await mapPool([...pidToCodes.keys()], COLORS_CONCURRENCY, async (pid) => {
    for (const code of pidToCodes.get(pid)!.slice(0, 5)) {
      const variant = await variantFor(code);
      if (!variant) continue;
      const data = await getJson(colorsUrl(origin, prefix, variant, pid));
      if (Array.isArray(data) && data.length) {
        accumulate(acc, data);
        return;
      }
    }
  });

  const patterns = toPatterns(acc);
  return json({
    source: {
      mode: 'catalog',
      productsScanned: codes.length,
      productsWithFabric: codeToPids.size,
      anchors: anchors.length,
      fabricsDiscovered: discovered,
      fabrics: patterns.length,
      // We discovered more fabrics than we could fetch — a transient read gap.
      // The client must NOT flag-missing on a partial sweep.
      partial: patterns.length < discovered,
    },
    patterns,
  });
}

// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Require a logged-in dealer so the expensive catalog sweep can't be driven
  // by anonymous traffic. verify_jwt is off at the gateway (so the CORS
  // preflight, which carries no Authorization header, passes); we verify the
  // token here instead — same as bpd-rate / hl-track.
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Authorization header required' }, 401);
  }
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await caller.auth.getUser();
    if (error || !data?.user) return json({ error: 'Invalid or expired session' }, 401);
  }

  let body: { url?: string; all?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  try {
    if (body?.all) return await importCatalog();
    const url = String(body?.url ?? '').trim();
    if (!url) return json({ error: 'provide a product url, or { all: true } for the whole catalog' }, 400);
    return await importProduct(url);
  } catch (e) {
    return json({ error: 'sync failed: ' + String((e as Error)?.message || e) }, 502);
  }
});
