// Stage device media for Instagram publishing. IG Content Publishing fetches a
// PUBLIC URL we host, so the flow is: pick a file → (images) re-encode to the
// JPEG IG demands, ≤8 MB, ≤1440px wide → upload to the public `social` bucket →
// hand the public URL to the meta-social `publish` mode. Browser-only (canvas),
// so it lives in the db layer with the supabase client, not in a pure Model.
import { supabase } from './supabaseClient.js';

const SOCIAL_BUCKET = 'social';
const IMG_MAX_BYTES = 8 * 1024 * 1024; // IG feed image cap
const VIDEO_MAX_BYTES = 300 * 1024 * 1024; // IG Reels cap
const IMG_MAX_WIDTH = 1440; // IG feed image max width

export type SocialMedia = { url: string; type: 'image' | 'video' };

const toBlob = (canvas: HTMLCanvasElement, quality: number): Promise<Blob> =>
  new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo codificar la imagen'))), 'image/jpeg', quality));

/** Decode any browser-readable image to a bitmap (HEIC usually can't decode —
 *  surfaced as a friendly error so the dealer exports a JPG instead). */
async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number }> {
  try {
    // Apply EXIF orientation explicitly (not the browser-default, which was
    // historically 'none') so portrait phone photos bake upright into the
    // re-encoded JPEG instead of posting sideways.
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bmp, width: bmp.width, height: bmp.height };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Formato de imagen no soportado — exporta un JPG.'));
        el.src = url;
      });
      return { source: img, width: img.naturalWidth, height: img.naturalHeight };
    } finally { URL.revokeObjectURL(url); }
  }
}

/** Re-encode an image to a baseline JPEG within IG's size/width limits. */
async function toInstagramJpeg(file: File): Promise<Blob> {
  const { source, width, height } = await decode(file);
  if (!width || !height) throw new Error('Imagen vacía o ilegible.');
  const scale = width > IMG_MAX_WIDTH ? IMG_MAX_WIDTH / width : 1;
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No se pudo procesar la imagen.');
  ctx.fillStyle = '#ffffff'; // flatten any transparency onto white (JPEG has no alpha)
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  let quality = 0.92;
  let blob = await toBlob(canvas, quality);
  while (blob.size > IMG_MAX_BYTES && quality > 0.5) {
    quality -= 0.1;
    blob = await toBlob(canvas, quality);
  }
  if (blob.size > IMG_MAX_BYTES) throw new Error('La imagen sigue siendo muy grande tras comprimir.');
  return blob;
}

/** Put a ready blob into the public `social` bucket → its public URL + kind. */
async function putSocialBlob(blob: Blob, ext: string, type: 'image' | 'video'): Promise<SocialMedia> {
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(SOCIAL_BUCKET).upload(path, blob, {
    contentType: type === 'video' ? (ext === 'mov' ? 'video/quicktime' : 'video/mp4') : 'image/jpeg',
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) throw new Error(error.message || 'No se pudo subir el archivo.');
  const { data } = supabase.storage.from(SOCIAL_BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error('No se pudo obtener la URL pública.');
  return { url: data.publicUrl, type };
}

/**
 * Upload a device file and return its public URL + kind. Images are converted
 * to IG-spec JPEG; videos are validated and uploaded as-is (MP4/MOV ≤300 MB).
 * Used directly for VIDEO and as the raw-image fallback; cropped images take the
 * `uploadSocialImage` blob path below (already IG-spec — no second re-encode).
 */
export async function uploadSocialMedia(file: File): Promise<SocialMedia> {
  if (!file) throw new Error('No se recibió ningún archivo.');
  const isVideo = /^video\//.test(file.type);

  if (isVideo) {
    if (!/(mp4|quicktime)/.test(file.type)) throw new Error('Video no soportado — usa MP4 o MOV.');
    if (file.size > VIDEO_MAX_BYTES) throw new Error(`Video muy grande (${(file.size / 1048576).toFixed(0)} MB). Máximo 300 MB.`);
    return putSocialBlob(file, file.type.includes('quicktime') ? 'mov' : 'mp4', 'video');
  }
  if (/^image\//.test(file.type) || /\.(heic|heif)$/i.test(file.name)) {
    return putSocialBlob(await toInstagramJpeg(file), 'jpg', 'image');
  }
  throw new Error(`Formato no soportado: ${file.type || 'desconocido'}.`);
}

/**
 * Upload an already-cropped image blob (the IG cropper outputs an exact-spec
 * 1080-wide baseline JPEG). We only guard the byte cap here — re-encoding a
 * second time would just soften the crop the dealer carefully framed — and
 * fall back to a one-pass re-compress if a huge source somehow overshoots.
 */
export async function uploadSocialImage(blob: Blob): Promise<SocialMedia> {
  if (!blob || !blob.size) throw new Error('No se recibió ninguna imagen.');
  let out = blob;
  if (out.size > IMG_MAX_BYTES) {
    // Rare safety net: decode + re-encode the cropped image down under the cap.
    out = await toInstagramJpeg(new File([blob], 'crop.jpg', { type: 'image/jpeg' }));
  }
  return putSocialBlob(out, 'jpg', 'image');
}

/** Best-effort cleanup of a staged file (e.g. the user removed it before publishing). */
export async function removeSocialMedia(url: string | null | undefined): Promise<void> {
  if (!url) return;
  const marker = `/${SOCIAL_BUCKET}/`;
  const i = url.indexOf(marker);
  if (i < 0) return;
  const path = url.slice(i + marker.length).split('?')[0];
  if (path) await supabase.storage.from(SOCIAL_BUCKET).remove([path]).catch(() => {});
}
