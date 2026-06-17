// Upload a real Togo 3D model (a pCon mesh export) to the PUBLIC `togo-models`
// bucket and hand back its public URL — which the dealer saves on the
// togo_models row so the configurator (used logged-out, on the embed too) loads
// it instead of the procedural geometry. Browser-only (uses the supabase
// client), so it lives in the db layer, mirroring socialUpload.ts.
import { supabase } from './supabaseClient.js';

const BUCKET = 'togo-models';
const EXT = /\.(fbx|glb|gltf|obj|dae|3ds)$/i;
const MAX_BYTES = 75 * 1024 * 1024;

/** Upload a mesh file → its public URL. Validates extension + size. */
export async function uploadTogoMesh(file: File): Promise<string> {
  if (!file) throw new Error('No se recibió ningún archivo.');
  const m = EXT.exec(file.name);
  if (!m) throw new Error('Formato no soportado — usa FBX, GLB, glTF, OBJ, DAE o 3DS.');
  if (file.size > MAX_BYTES) throw new Error(`El archivo es muy grande (${(file.size / 1048576).toFixed(0)} MB). Máximo 75 MB.`);
  const path = `${crypto.randomUUID()}.${m[1].toLowerCase()}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) throw new Error(error.message || 'No se pudo subir el modelo 3D.');
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error('No se pudo obtener la URL pública.');
  return data.publicUrl;
}

/** Best-effort removal of a previously-uploaded mesh (on replace/clear). */
export async function removeTogoMesh(url: string | null | undefined): Promise<void> {
  const marker = `/${BUCKET}/`;
  const i = (url || '').indexOf(marker);
  if (i < 0) return;
  const path = url!.slice(i + marker.length).split('?')[0];
  if (path) await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
}
