// Upload a receipt/comprobante (photo or PDF) for a compra/gasto to the PUBLIC
// `documents` bucket and hand back its public URL + metadata, which the detail
// view stores on the expense/purchase row (attachmentUrl/Name/Type) and renders
// as an inline preview. Browser-only (uses the supabase client), so it lives in
// the db layer, mirroring socialUpload.ts / togoMeshUpload.ts.
import { supabase } from './supabaseClient.js';

const BUCKET = 'documents';
const FOLDER = 'comprobantes';
// Photos of a paper receipt + scanned PDFs. Kept in step with the
// `documents` bucket's allowed_mime_types (see the matching migration).
const ALLOWED_MIME = /^(application\/pdf|image\/(png|jpe?g|webp|gif|heic|heif|avif))$/i;
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — a receipt scan is tiny; this is headroom

export interface DocAttachment {
  url: string;
  name: string;
  type: string;
  size: number;
}

function extensionFor(type: string, name: string): string {
  const fromName = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (fromName) return fromName === 'jpeg' ? 'jpg' : fromName;
  if (type === 'application/pdf') return 'pdf';
  const m = type.match(/^image\/([a-z0-9]+)/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'bin';
}

/**
 * Upload a comprobante file → its public URL + name/type/size. Validates the
 * MIME type and size at the boundary; the thrown message is dealer-readable and
 * surfaced inline by the caller.
 */
export async function uploadDocAttachment(file: File): Promise<DocAttachment> {
  if (!file) throw new Error('No se recibió ningún archivo.');
  if (!file.size) throw new Error('El archivo está vacío.');
  const type = file.type || '';
  if (!ALLOWED_MIME.test(type)) {
    throw new Error('Formato no soportado — adjunta una imagen (JPG, PNG, HEIC…) o un PDF.');
  }
  if (file.size > MAX_BYTES) {
    throw new Error(`El archivo es muy grande (${(file.size / 1048576).toFixed(1)} MB). Máximo 25 MB.`);
  }
  const path = `${FOLDER}/${crypto.randomUUID()}.${extensionFor(type, file.name || '')}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: type || 'application/octet-stream',
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) throw new Error(error.message || 'No se pudo subir el comprobante.');
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error('No se pudo obtener la URL pública del comprobante.');
  return { url: data.publicUrl, name: file.name || 'comprobante', type, size: file.size };
}

/** Best-effort removal of a previously-uploaded comprobante (on replace/clear).
 *  A no-op for an external pasted link — only files we put in our bucket are
 *  removed (the path is derived from the public URL). */
export async function removeDocAttachment(url: string | null | undefined): Promise<void> {
  const marker = `/${BUCKET}/`;
  const i = (url || '').indexOf(marker);
  if (i < 0) return;
  const path = url!.slice(i + marker.length).split('?')[0];
  if (path) await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
}
