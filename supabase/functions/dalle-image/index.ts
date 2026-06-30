// dalle-image — the server side of the JARVIS image-generation pane. The dealer
// types a prompt (optionally with dropped "inspiration" reference images and a
// target size), and this function relays it to OpenAI DALL·E 3, renders the
// results to the chosen dimensions, archives them in the public `social` bucket
// and returns their URLs.
//
// Why a function (not a direct browser call): same shape as claude-chat — the
// OpenAI API key is a write-only secret (openai_config table, service-role read)
// and must never reach the browser bundle. The caller's JWT is verified here so
// anonymous traffic can't drain the API spend.
//
// Modes (switch on body.mode; body.test is an alias for the probe):
//   test | config        → health probe for the JARVIS card; does NOT need a key.
//   saveConfig {apiKey}   → write-only UPSERT of the key (never returned).
//   describe {imageUrls}  → vision brief of reference images (art-direction note).
//   generate {prompt,…}   → N parallel DALL·E 3 generations → resized → uploaded.
//
// This slice never writes the generated_images history table — the frontend
// persists that, keeping this function independent.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import OpenAI from 'npm:openai';
import { Image } from 'https://deno.land/x/imagescript@1.2.17/mod.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';

const DEFAULT_VISION_MODEL = 'gpt-4o';
const STORAGE_BUCKET = 'social';

// DALL·E 3 only supports n=1; we fan out `count` parallel calls for multiples.
type Aspect = 'square' | 'portrait' | 'landscape';
const SIZE_BY_ASPECT: Record<Aspect, '1024x1024' | '1024x1792' | '1792x1024'> = {
  square: '1024x1024',
  portrait: '1024x1792',
  landscape: '1792x1024',
};

const DESCRIBE_PROMPT =
  `You are an art director. Look at the reference image(s) and write a concise ` +
  `art-direction brief — style, color palette, mood, lighting and composition — ` +
  `in 2 to 4 sentences. Respond with the brief only, no preamble.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    return json({ ok: false, error: 'Server misconfigured' }, 500);
  }

  // Require a logged-in team member so the API spend can't be drained by
  // anonymous traffic. verify_jwt is off at the gateway (CORS preflight); we
  // verify the token here, same as claude-chat / wa-draft.
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ ok: false, error: 'Authorization header required' }, 401);
  }
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, error: 'Invalid or expired session' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: {
    mode?: string; test?: boolean;
    apiKey?: string;
    imageUrls?: string[];
    prompt?: string; styleNote?: string; aspect?: string; count?: number;
    targetWidth?: number; targetHeight?: number; quality?: string; style?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body → defaults below */
  }

  const mode = body.test ? 'test' : String(body.mode || '').trim();

  // The key lives in the write-only openai_config table; only this service-role
  // read ever sees it.
  const { data: cfg } = await admin
    .from('openai_config')
    .select('api_key, image_model, vision_model')
    .eq('profile_id', 'team')
    .maybeSingle();

  // Health probe — must NOT require the key to be present (the JARVIS card + the
  // settings tile use it to show "connected / not connected").
  if (mode === 'test' || mode === 'config') {
    return json({ configured: !!cfg?.api_key, ok: true });
  }

  // Write-only credential save: never echo the key back.
  if (mode === 'saveConfig') {
    const apiKey = String(body.apiKey || '').trim();
    if (!apiKey) return json({ ok: false, error: 'Falta la llave API de OpenAI' }, 400);
    const { error: upErr } = await admin.from('openai_config').upsert(
      { profile_id: 'team', api_key: apiKey, updated_at: new Date().toISOString() },
      { onConflict: 'profile_id' },
    );
    if (upErr) return json({ ok: false, error: 'No se pudo guardar la llave' }, 500);
    // Mirror the connection time on settings for the dashboard freshness badge.
    // settings' PK is profile_id (not id) — same key every other function uses.
    await admin.from('settings').update({ openai_connected_at: new Date().toISOString() }).eq('profile_id', 'team');
    return json({ ok: true, configured: true });
  }

  // Everything below needs the key.
  if (!cfg?.api_key) {
    return json({ configured: false, error: 'Sin llave API de OpenAI' });
  }
  const openai = new OpenAI({ apiKey: cfg.api_key });

  if (mode === 'describe') {
    const imageUrls = Array.isArray(body.imageUrls)
      ? body.imageUrls.filter((u) => typeof u === 'string' && u).slice(0, 4)
      : [];
    if (!imageUrls.length) return json({ ok: false, error: 'No hay imágenes de referencia.' }, 400);
    try {
      const completion = await openai.chat.completions.create({
        model: cfg.vision_model || DEFAULT_VISION_MODEL,
        messages: [
          { role: 'system', content: DESCRIBE_PROMPT },
          {
            role: 'user',
            content: imageUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
          },
        ],
      });
      const style = (completion.choices?.[0]?.message?.content || '').trim();
      return json({ ok: true, style });
    } catch (e) {
      return json({ ok: false, error: apiErrorMessage(e) }, 502);
    }
  }

  if (mode === 'generate') {
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return json({ ok: false, error: 'Falta el prompt.' }, 400);

    const aspect: Aspect =
      body.aspect === 'portrait' || body.aspect === 'landscape' ? body.aspect : 'square';
    const size = SIZE_BY_ASPECT[aspect];
    const count = clamp(Math.round(Number(body.count) || 1), 1, 6);

    const quality = body.quality === 'hd' ? 'hd' : 'standard';
    const style = body.style === 'natural' ? 'natural' : 'vivid';
    const styleNote = String(body.styleNote || '').trim();
    const fullPrompt = [prompt, styleNote].filter(Boolean).join('\n\nEstilo de referencia: ');

    const targetWidth = posInt(body.targetWidth);
    const targetHeight = posInt(body.targetHeight);

    try {
      // DALL·E 3 only does n=1 → fan out `count` parallel calls.
      const results = await Promise.all(
        Array.from({ length: count }, () =>
          openai.images.generate({
            model: 'dall-e-3',
            n: 1,
            size,
            response_format: 'b64_json',
            quality,
            style,
            prompt: fullPrompt,
          }),
        ),
      );

      const images = await Promise.all(
        results.map(async (res) => {
          const datum = res.data?.[0];
          const b64 = datum?.b64_json || '';
          const revisedPrompt = datum?.revised_prompt || null;
          let bytes = decodeBase64(b64);
          let width = nativeWidth(size);
          let height = nativeHeight(size);

          // Resize to the dealer's chosen dimensions when they differ from the
          // native DALL·E size: center-crop to the target aspect, then resize.
          if (targetWidth && targetHeight && (targetWidth !== width || targetHeight !== height)) {
            const img = await Image.decode(bytes);
            const cropped = centerCropToAspect(img, targetWidth / targetHeight);
            cropped.resize(targetWidth, targetHeight);
            bytes = await cropped.encodeJPEG(90);
            width = targetWidth;
            height = targetHeight;
          }

          const path = `dalle/${crypto.randomUUID()}.jpg`;
          const up = await admin.storage.from(STORAGE_BUCKET).upload(path, bytes, {
            contentType: 'image/jpeg',
            upsert: false,
          });
          if (up.error) throw new Error(`upload failed: ${up.error.message}`);

          const url = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${encodeURIComponent(path)}`;
          return { url, width, height, revisedPrompt };
        }),
      );

      return json({ ok: true, images });
    } catch (e) {
      return json({ ok: false, error: apiErrorMessage(e) }, 502);
    }
  }

  return json({ ok: false, error: 'Modo no reconocido.' }, 400);
});

/** Center-crop an image to a target aspect ratio (w/h), keeping the most pixels. */
function centerCropToAspect(img: Image, targetRatio: number): Image {
  const w = img.width;
  const h = img.height;
  const current = w / h;
  if (Math.abs(current - targetRatio) < 1e-3) return img;
  if (current > targetRatio) {
    // Too wide → crop width.
    const newW = Math.max(1, Math.round(h * targetRatio));
    const x = Math.floor((w - newW) / 2);
    return img.crop(x, 0, newW, h);
  }
  // Too tall → crop height.
  const newH = Math.max(1, Math.round(w / targetRatio));
  const y = Math.floor((h - newH) / 2);
  return img.crop(0, y, w, newH);
}

function nativeWidth(size: string): number {
  return Number(size.split('x')[0]) || 1024;
}
function nativeHeight(size: string): number {
  return Number(size.split('x')[1]) || 1024;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function posInt(v: unknown): number | null {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
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

function apiErrorMessage(e: unknown): string {
  const err = e as { status?: number; code?: string; message?: string; error?: { code?: string; message?: string } };
  const status = err?.status;
  const code = err?.code || err?.error?.code || '';
  const message = err?.message || err?.error?.message || String(e);
  if (status === 401 || /invalid api key|incorrect api key|authentication/i.test(message)) {
    return 'Llave API de OpenAI inválida o revocada';
  }
  if (status === 429 || /rate limit|quota/i.test(message)) {
    return 'Límite de uso de OpenAI alcanzado';
  }
  if (code === 'content_policy_violation' || /content_policy|content policy|safety system/i.test(message)) {
    return 'El contenido viola la política de OpenAI; ajusta el prompt';
  }
  return String(message).trim().slice(0, 300);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
