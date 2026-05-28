// swatch-proxy — re-serves a Ligne Roset fabric/leather swatch image so the
// browser-side PDF generator can embed it.
//
// Why a function (not a direct browser fetch):
//   - The catalog stores only a color CODE; the swatch itself is a public
//     image on Ligne Roset's CDN (…/colorized-pattern/c_<code>.jpg).
//   - The web preview hotlinks it via <img>, which works (displaying a
//     cross-origin image needs no CORS). But the PDF generator (pdf-lib, in
//     the browser) needs the raw BYTES to embed, and the CDN sends no
//     `Access-Control-Allow-Origin` — so a direct browser fetch is blocked.
//   - This function fetches the image server-side (no CORS in Deno) and
//     re-serves the bytes with permissive CORS so the export can embed them.
//
// Locked to the Ligne Roset swatch path and to a sanitised `code` — it can
// only ever return one of those swatch images, never an arbitrary URL, so it
// is not an open proxy (no SSRF).

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

// Same base the app derives swatch URLs from (src/lib/swatchImage.ts).
// Hardcoded on purpose — there is NO env override — so the function can only
// ever reach the Ligne Roset swatch CDN.
const LR_SWATCH_BASE =
  'https://www.ligne-roset.com/media/ligne_roset_us/colorized-pattern';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  const code = (new URL(req.url).searchParams.get('code') || '').trim();
  // Catalog color codes are short alphanumerics (e.g. "855", "3807", "137").
  // Reject anything else so a crafted `code` can't smuggle a path or host.
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(code)) {
    return new Response('bad code', { status: 400, headers: CORS_HEADERS });
  }

  try {
    const upstream = await fetch(`${LR_SWATCH_BASE}/c_${code}.jpg`);
    if (!upstream.ok) {
      return new Response('swatch not found', {
        status: upstream.status,
        headers: CORS_HEADERS,
      });
    }
    const bytes = await upstream.arrayBuffer();
    return new Response(bytes, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
        // A swatch is immutable per code — let the browser cache it hard so
        // repeat exports don't re-hit the CDN.
        'Cache-Control': 'public, max-age=604800, immutable',
      },
    });
  } catch (e) {
    return new Response('upstream error: ' + String((e as Error)?.message || e), {
      status: 502,
      headers: CORS_HEADERS,
    });
  }
});
