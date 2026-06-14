// Bake EXIF orientation into outgoing photos.
//
// Phone cameras store the sensor's native (often landscape) pixels plus an EXIF
// `Orientation` tag telling the viewer how to rotate/flip them. Browsers honor
// it, so a portrait photo looks upright in our inbox — but WhatsApp's Cloud API
// serves the RAW pixels, so the same photo arrives at the customer sideways.
// (Same hazard as the ogImage progressive-JPEG one: what we render ≠ what the
// recipient sees.) Fix: before sending, re-encode the image with the rotation
// baked into the pixels and the tag stripped, so it's upright everywhere.

/**
 * Parse the EXIF `Orientation` (1–8) from a JPEG's bytes; 1 (or absent) means
 * the pixels are already upright. Used to gate the re-encode — only photos that
 * actually carry a non-trivial rotation get rewritten. Pure, byte-level, so it
 * stays unit-testable across the Deno↔Vite wall.
 */
export function readJpegOrientation(buf: ArrayBuffer): number {
  const view = new DataView(buf);
  const len = view.byteLength;
  if (len < 2 || view.getUint16(0) !== 0xffd8) return 1; // not a JPEG (no SOI)
  let offset = 2;
  while (offset + 4 <= len) {
    const marker = view.getUint16(offset);
    offset += 2;
    if ((marker & 0xff00) !== 0xff00) break; // lost sync — bail
    if (marker === 0xffe1) {
      // APP1 — the EXIF segment. Skip the 2-byte segment length, then "Exif\0\0".
      const exif = offset + 2;
      if (exif + 8 > len || view.getUint32(exif) !== 0x45786966) return 1; // "Exif"
      const tiff = exif + 6;
      if (tiff + 8 > len) return 1;
      const little = view.getUint16(tiff) === 0x4949; // 'II' little-endian, 'MM' big
      const u16 = (o: number) => view.getUint16(o, little);
      const u32 = (o: number) => view.getUint32(o, little);
      if (u16(tiff + 2) !== 0x002a) return 1; // TIFF magic
      const ifd0 = tiff + u32(tiff + 4);
      if (ifd0 + 2 > len) return 1;
      const count = u16(ifd0);
      for (let i = 0; i < count; i++) {
        const entry = ifd0 + 2 + i * 12;
        if (entry + 12 > len) break;
        if (u16(entry) === 0x0112) { // Orientation tag
          const val = u16(entry + 8);
          return val >= 1 && val <= 8 ? val : 1;
        }
      }
      return 1;
    }
    if (offset + 2 > len) break;
    offset += view.getUint16(offset); // skip this segment's payload
  }
  return 1;
}

/** Decode a blob to something canvas can draw, with EXIF orientation already
 *  applied by the browser. `createImageBitmap` with `imageOrientation:
 *  'from-image'` is the explicit, double-rotation-proof path; the `<img>`
 *  fallback also auto-orients in modern browsers. */
async function decodeOriented(blob: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return bmp;
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('No se pudo decodificar la imagen.'));
        el.src = url;
      });
      return Object.assign(img, { width: img.naturalWidth, height: img.naturalHeight });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Return a copy of `file` with EXIF orientation baked into the pixels (tag
 * stripped), so recipients that ignore EXIF still see it upright. Best-effort:
 * non-JPEG files, already-upright photos, and any decode/encode failure pass
 * the original through untouched — normalization must never block a send.
 */
export async function normalizeImageOrientation(file: File): Promise<File> {
  if (!/^image\/jpeg$/i.test(file.type)) return file;
  let orientation = 1;
  try {
    orientation = readJpegOrientation(await file.arrayBuffer());
  } catch {
    return file;
  }
  if (orientation === 1) return file; // already upright — keep the original bytes
  try {
    const source = await decodeOriented(file);
    const w = source.width;
    const h = source.height;
    if (!w || !h) return file;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(source, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) return file;
    return new File([blob], file.name || 'photo.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
