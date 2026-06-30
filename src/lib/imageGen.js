// Client helpers for the DALL·E 3 image generation pane.
//
// Mirrors the WhatsApp client (lib/whatsapp.js): the OpenAI key lives server-side
// and every call goes through the `dalle-image` Edge Function (two modes:
// `generate` text-to-image and `describe` inspiration → style brief). Non-2xx
// responses carry the real reason in a JSON body that supabase-js hides behind a
// generic message, so we read it back the same way invokeWaSend does.
//
// Browser/Vite layer (it calls supabase) — never imported by an Edge Function.

import { supabase } from '../db/supabaseClient.js';

/**
 * Invoke the `dalle-image` Edge Function and unwrap its JSON body, surfacing the
 * server's real error message on a non-2xx (read from error.context) and on an
 * explicit `{ ok:false, error }` payload.
 */
async function invokeDalle(body) {
  const { data, error } = await supabase.functions.invoke('dalle-image', { body });
  if (error) {
    // Non-2xx: the real reason is in the JSON body supabase-js hides behind a
    // generic message. Parse it in its OWN try so a non-JSON body (a 5xx HTML
    // page, an empty/gateway-timeout response) falls through to the generic
    // throw below instead of surfacing a raw "Unexpected token <" parse error.
    const ctx = error.context;
    let body2 = null;
    if (ctx && typeof ctx.json === 'function') {
      try { body2 = await ctx.json(); } catch { /* not a JSON body — fall through */ }
    }
    if (body2 && body2.ok === false) throw new Error(body2.error || 'No se pudo generar la imagen.');
    if (body2) return body2;
    throw new Error(error.message || 'No se pudo contactar con el generador de imágenes.');
  }
  if (data && data.ok === false) throw new Error(data.error || 'No se pudo generar la imagen.');
  return data;
}

/**
 * Generate `count` images for the chosen native aspect; the function generates
 * at the native DALL·E 3 size then crops/resizes each to the exact target dims.
 * `prompt` + `styleNote` (the inspiration style brief) compose the final prompt
 * server-side. Returns `{ ok:true, images:[{ url, revisedPrompt, width, height }] }`.
 */
export async function generateImages({ prompt, styleNote, aspect, count, targetWidth, targetHeight, quality, style }) {
  return invokeDalle({
    mode: 'generate',
    prompt,
    styleNote,
    aspect,
    count,
    targetWidth,
    targetHeight,
    quality,
    style,
  });
}

/**
 * Turn dropped "inspiration" reference images into an editable text style brief
 * (DALL·E 3 takes no image input — the `describe` mode reads the public URLs and
 * returns a prose style note). Returns `{ ok:true, styleNote }`.
 */
export async function describeInspiration(imageUrls) {
  return invokeDalle({ mode: 'describe', imageUrls });
}
