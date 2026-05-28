// lr-catalog — reads a Ligne Roset product page and returns the fabric/leather
// catalog it offers (pattern name, type, composition, care remark, and every
// color with its catalog code), as clean JSON for the Materials admin importer.
//
// Why a function (not a direct browser fetch):
//   - Ligne Roset serves the catalog from two same-origin AJAX endpoints behind
//     each product page:
//       GET /<lang>/ajax/patterns/product/<productCode>            → [patternId, …]
//       GET /<lang>/ajax/colors/variant/<variantId>/pattern/<pid>  → [{ … }, …]
//     The colors payload carries everything we need:
//       colorizedPattern.pattern = { name, type, composition, remark, … }
//       colorizedPattern.colorName + colorPicture (".../c_<code>.jpg")
//     That <code> is exactly the MaterialColor.code we already store and the
//     swatch path src/lib/swatchImage.ts builds — so the import lines up 1:1.
//   - Those endpoints send no `Access-Control-Allow-Origin`, so the browser
//     can't read them directly (same reason swatch-proxy exists). We fetch them
//     server-side (no CORS in Deno) and re-serve the merged result with CORS.
//
// Locked to ligne-roset.com — it will only ever fetch that host, so it is not
// an open proxy (no SSRF). All catalog mapping/merge logic lives in the pure,
// unit-tested src/lib/lrCatalog.ts; this function only fetches and shapes.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

// The only hosts this function will ever reach. Hardcoded on purpose — there is
// NO env override — so a crafted `url` can't redirect it elsewhere.
const ALLOWED_HOSTS = new Set(['www.ligne-roset.com', 'ligne-roset.com']);

// Ligne Roset's CDN serves a generic bot a stripped page; a desktop UA gets the
// full markup that carries the product/variant ids and the AJAX wiring.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// Fan-out cap for the per-pattern color requests: a popular model offers ~55
// patterns; 8-at-a-time keeps us well inside the function's wall-clock budget.
const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 15_000;

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: { url?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const raw = String(body?.url ?? '').trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return json({ error: 'invalid url' }, 400);
  }
  if (!ALLOWED_HOSTS.has(u.hostname)) {
    return json({ error: 'url must be a ligne-roset.com product page' }, 400);
  }

  // The AJAX endpoints sit under the page's language prefix, e.g. "/us/…".
  const appPrefix = u.pathname.split('/').filter(Boolean)[0] || 'us';
  const origin = u.origin;

  // 1) Product page → product code + default variant id (+ a title for the UI).
  const page = await fetchText(u.href);
  if (!page.ok) return json({ error: `product page returned ${page.status || 'error'}` }, 502);
  const html = page.text;

  const productCode =
    html.match(/patterns\/product\/(\d+)/)?.[1] ??
    raw.match(/(\d+)(?=[/?#]|$)/)?.[1] ??
    null;
  const variantId =
    html.match(/product-variant\/(\d+)/)?.[1] ??
    html.match(/\/ajax\/colors\/variant\/(\d+)\/pattern/)?.[1] ??
    null;
  if (!productCode || !variantId) {
    return json({ error: 'could not locate the product/variant id on the page' }, 422);
  }
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || null;

  // 2) Pattern ids offered for this product.
  const patRes = await fetchText(`${origin}/${appPrefix}/ajax/patterns/product/${productCode}`);
  if (!patRes.ok) return json({ error: `patterns endpoint returned ${patRes.status}` }, 502);
  let patternIds: unknown;
  try {
    patternIds = JSON.parse(patRes.text);
  } catch {
    return json({ error: 'patterns endpoint did not return JSON' }, 502);
  }
  if (!Array.isArray(patternIds)) return json({ error: 'unexpected patterns response' }, 502);

  // 3) Colors per pattern (batched). Group into one entry per pattern, deduping
  //    colors by catalog code. Individual failures are skipped, not fatal.
  type Pat = {
    name: string;
    type: string | null;
    composition: string | null;
    remark: string | null;
    description: string | null;
    colors: Map<string, string | null>;
  };
  const byPattern = new Map<number, Pat>();

  async function loadPattern(pid: unknown): Promise<void> {
    const res = await fetchText(`${origin}/${appPrefix}/ajax/colors/variant/${variantId}/pattern/${pid}`);
    if (!res.ok) return;
    let arr: unknown;
    try {
      arr = JSON.parse(res.text);
    } catch {
      return;
    }
    if (!Array.isArray(arr)) return;
    for (const v of arr) {
      const cp = (v as Record<string, unknown>)?.colorizedPattern as Record<string, unknown> | undefined;
      const pat = cp?.pattern as Record<string, unknown> | undefined;
      const patId = Number(pat?.id);
      const patName = String(pat?.name ?? '').trim();
      if (!patName || !Number.isFinite(patId)) continue;
      let entry = byPattern.get(patId);
      if (!entry) {
        entry = {
          name: patName,
          type: pat?.type != null ? String(pat.type) : null,
          composition: pat?.composition != null ? String(pat.composition) : null,
          remark: pat?.remark != null ? String(pat.remark) : null,
          description: pat?.description != null ? String(pat.description) : null,
          colors: new Map(),
        };
        byPattern.set(patId, entry);
      }
      const code = String(cp?.colorPicture ?? '').match(/c_([0-9A-Za-z]+)\.jpg/)?.[1];
      if (code && !entry.colors.has(code)) {
        const cn = cp?.colorName;
        entry.colors.set(code, cn != null ? String(cn).trim() : null);
      }
    }
  }

  for (let i = 0; i < patternIds.length; i += CONCURRENCY) {
    await Promise.all(patternIds.slice(i, i + CONCURRENCY).map(loadPattern));
  }

  const patterns = [...byPattern.values()]
    .map((p) => ({
      name: p.name,
      type: p.type,
      composition: p.composition,
      remark: p.remark,
      description: p.description,
      colors: [...p.colors].map(([code, name]) => ({ code, name })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return json({
    source: { url: u.href, productCode, variantId, title },
    patterns,
  });
});
