/**
 * Image Studio ViewModel — pure projections for the DALL·E 3 ad/artwork pane.
 *
 * DALL·E 3 is text-to-image only and exposes just THREE native sizes at n=1 per
 * call. The dealer types EXACT target pixels; we pick the nearest native aspect
 * here, the `dalle-image` Edge Function generates at that native size then
 * crops+resizes to the exact dims, and multiple images come from `count`
 * parallel server calls. This module owns all that math + the validation gate +
 * the history gallery projection. No React / db / supabase — it's a Model.
 */

/** The three native gpt-image-1 sizes, with the API string each maps to. */
export const DALLE_SIZES = {
  square: { w: 1024, h: 1024, api: '1024x1024' },
  portrait: { w: 1024, h: 1536, api: '1024x1536' },
  landscape: { w: 1536, h: 1024, api: '1536x1024' },
};

const ASPECTS = ['square', 'portrait', 'landscape'];

const DIM_MIN = 256;
const DIM_MAX = 2048;
const COUNT_MIN = 1;
const COUNT_MAX = 6;

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Closest native aspect to a target. Compares the target ratio (w/h) to each
 * native ratio; the smallest absolute difference wins. Ties resolve to 'square'
 * (it's first in ASPECTS, and we only replace on a strictly-smaller distance).
 */
export function nearestDalleAspect(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0) return 'square';
  const target = w / h;
  let best = 'square';
  let bestDist = Infinity;
  for (const name of ASPECTS) {
    const s = DALLE_SIZES[name];
    const dist = Math.abs(target - s.w / s.h);
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }
  return best;
}

/**
 * Center-crop a native image to the target aspect, then resize to the exact
 * target dims. Pure math:
 *   - target wider than native → keep full width, crop height (letterbox top/bottom).
 *   - target taller than native → keep full height, crop width (pillarbox sides).
 * Returns the source crop rect + the final resize dims (always exactly target).
 */
export function cropPlan(nativeW, nativeH, targetW, targetH) {
  const nw = Number(nativeW) || 0;
  const nh = Number(nativeH) || 0;
  const tw = Number(targetW) || 0;
  const th = Number(targetH) || 0;
  if (nw <= 0 || nh <= 0 || tw <= 0 || th <= 0) {
    return { crop: { x: 0, y: 0, w: nw, h: nh }, resize: { w: tw, h: th } };
  }
  const targetRatio = tw / th;
  const nativeRatio = nw / nh;
  let cropW;
  let cropH;
  if (targetRatio > nativeRatio) {
    // Target is wider → full native width, shorter crop height.
    cropW = nw;
    cropH = nw / targetRatio;
  } else {
    // Target is taller (or equal) → full native height, narrower crop width.
    cropH = nh;
    cropW = nh * targetRatio;
  }
  const x = (nw - cropW) / 2;
  const y = (nh - cropH) / 2;
  return {
    crop: { x, y, w: cropW, h: cropH },
    resize: { w: tw, h: th },
  };
}

/**
 * Validate + normalize the generation request the View collected. Returns
 * { ok:true, request } ready to hand to `generateImages`, or { ok:false, error }
 * with a Spanish message. Rules:
 *   - prompt required (trimmed non-empty).
 *   - count clamped to 1..6.
 *   - dims clamped to 256..2048; omitted dims default to the chosen native size.
 *   - aspect picked from the (clamped) dims via nearestDalleAspect.
 */
export function buildGenerationPlan({ prompt, styleNote, count, targetWidth, targetHeight, quality, style } = {}) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) {
    return { ok: false, error: 'Escribe una descripción para generar la imagen.' };
  }

  const safeCount = clamp(Math.round(Number(count) || 1), COUNT_MIN, COUNT_MAX);

  // Resolve dims: clamp what's given; default an omitted dim to the native size
  // of the aspect implied by whatever WAS given (or square when neither is).
  const rawW = Number(targetWidth);
  const rawH = Number(targetHeight);
  const hasW = Number.isFinite(rawW) && rawW > 0;
  const hasH = Number.isFinite(rawH) && rawH > 0;

  let aspect;
  let width;
  let height;
  if (hasW && hasH) {
    width = clamp(Math.round(rawW), DIM_MIN, DIM_MAX);
    height = clamp(Math.round(rawH), DIM_MIN, DIM_MAX);
    aspect = nearestDalleAspect(width, height);
  } else if (hasW || hasH) {
    // Only one dim given — pick the aspect from the ratio against the OTHER
    // native dimension is ambiguous, so default the missing one to the native
    // square and let nearestDalleAspect decide from the provided dim.
    width = hasW ? clamp(Math.round(rawW), DIM_MIN, DIM_MAX) : DALLE_SIZES.square.w;
    height = hasH ? clamp(Math.round(rawH), DIM_MIN, DIM_MAX) : DALLE_SIZES.square.h;
    aspect = nearestDalleAspect(width, height);
  } else {
    aspect = 'square';
    width = DALLE_SIZES.square.w;
    height = DALLE_SIZES.square.h;
  }

  return {
    ok: true,
    request: {
      prompt: cleanPrompt,
      styleNote: String(styleNote || '').trim() || undefined,
      aspect,
      count: safeCount,
      targetWidth: width,
      targetHeight: height,
      quality: quality === 'hd' ? 'hd' : 'standard',
      style: style === 'natural' ? 'natural' : 'vivid',
    },
  };
}

const STATUS_LABEL = {
  queued: 'En cola',
  generating: 'Generando…',
  completed: 'Listo',
  failed: 'Falló',
};

/** YYYY-MM-DD key in DR-local time (UTC-4, no DST) for the day grouping. */
function dayKey(ms) {
  const d = new Date((Number(ms) || 0) - 4 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Project the `generated_images` rows into the gallery the View renders:
 * newest-first items + the same items grouped by (DR-local) day. Deterministic
 * — ties on createdAt break on id so the order never flickers.
 */
export function resolveImageStudio(rows, { now = Date.now() } = {}) {
  const items = (rows || []).map((r) => ({
    id: r.id,
    prompt: r.prompt || '',
    styleNote: r.styleNote || '',
    status: r.status || 'completed',
    statusLabel: STATUS_LABEL[r.status] || r.status || '',
    imageUrl: r.imageUrl || null,
    width: r.width || null,
    height: r.height || null,
    count: r.count || 1,
    revisedPrompt: r.revisedPrompt || '',
    error: r.error || null,
    createdAt: r.createdAt || 0,
  }));

  items.sort((a, b) => (b.createdAt - a.createdAt) || String(b.id).localeCompare(String(a.id)));

  const byDay = [];
  const index = new Map();
  for (const item of items) {
    const key = dayKey(item.createdAt);
    let bucket = index.get(key);
    if (!bucket) {
      bucket = { day: key, items: [] };
      index.set(key, bucket);
      byDay.push(bucket);
    }
    bucket.items.push(item);
  }

  return { items, byDay, total: items.length, now };
}
