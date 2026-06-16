// Shared canvas plumbing for the Instagram croppers — the single-photo
// ImageCropper and the sliding-feed PanoramaCropper both decode a device photo
// to oriented full-res pixels (EXIF baked in, matching socialUpload's path) and
// JPEG-encode the framed canvas the exact same way. Keeping it here means a
// HEIC/orientation fix lands in ONE place. Browser-only (canvas), so it stays a
// View helper, not a pure Model.

export const IMG_MAX_BYTES = 8 * 1024 * 1024; // IG feed image cap (mirror of socialUpload)

/** Decode a file to oriented full-res pixels on a master canvas (EXIF baked in,
 *  matching socialUpload's `from-image` path) plus a once-encoded preview URL
 *  the <img> can pan/zoom smoothly on the GPU. */
export async function loadOriented(file) {
  let source; let w; let h;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    source = bmp; w = bmp.width; h = bmp.height;
  } catch {
    const url = URL.createObjectURL(file);
    try {
      source = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('decode'));
        el.src = url;
      });
      w = source.naturalWidth; h = source.naturalHeight;
    } finally { URL.revokeObjectURL(url); }
  }
  if (!w || !h) throw new Error('empty');
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no-ctx');
  ctx.drawImage(source, 0, 0, w, h);
  if (typeof source.close === 'function') source.close();
  const previewUrl = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : ''), 'image/jpeg', 0.9));
  return { canvas, w, h, previewUrl };
}

/** Encode a canvas to a baseline JPEG blob at quality `q`. */
export const toJpeg = (canvas, q) => new Promise((resolve, reject) =>
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', q));
