// Google (Gmail + Drive) client Model — the thin browser side of the google-api
// Edge Function. Every call is a single supabase.functions.invoke('google-api')
// with one action in the body; secrets stay server-side (write-only
// google_oauth_config), so nothing here ever holds a token. Mirrors the shape of
// lib/whatsapp.js (invoke → unwrap the non-2xx JSON body → throw a clean error).

import { supabase } from '../db/supabaseClient.js';

/** Invoke google-api with one action body; unwrap a non-2xx JSON error. */
async function invokeGoogle(body) {
  const { data, error } = await supabase.functions.invoke('google-api', { body });
  if (error) {
    // functions.invoke wraps non-2xx as an error whose context carries the body.
    try {
      const detail = await error.context?.json?.();
      if (detail?.error) throw new Error(detail.error);
    } catch (e) { if (e instanceof Error && e.message && e.message !== 'sin respuesta') throw e; }
    throw new Error(error.message || 'sin respuesta');
  }
  if (data && data.ok === false) throw new Error(data.error || 'No se pudo completar la acción');
  return data;
}

// ── Connection (admin) ─────────────────────────────────────────────────────

/** Persist the Google OAuth client credentials (write-only server-side). */
export async function saveGoogleConfig({ clientId, clientSecret }) {
  return invokeGoogle({ saveApp: { clientId, clientSecret } });
}

/** Set which email domain may "Sign in with Google" (empty ⇒ connected-account domain). */
export async function saveGoogleLoginDomain(domain) {
  return invokeGoogle({ saveLogin: { domain } });
}

/** Start the consent flow → returns the Google authorization URL to redirect to. */
export async function connectGoogle({ returnTo } = {}) {
  const data = await invokeGoogle({ authorize: { returnTo } });
  if (!data?.url) throw new Error('No se pudo iniciar la conexión');
  return data.url;
}

/** Forget the stored tokens (keeps the client credentials). */
export async function disconnectGoogle() {
  return invokeGoogle({ disconnect: true });
}

/** Quick "is the token alive" probe. */
export async function googleStatus() {
  return invokeGoogle({ status: true });
}

// ── Gmail ───────────────────────────────────────────────────────────────────

/** A Blob/File → base64 string (no data: prefix) for the function payload. */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      resolve(res.slice(res.indexOf(',') + 1)); // strip "data:...;base64,"
    };
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer el archivo'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Send one email. `attachments` is [{ filename, mimeType, base64 }]; pass
 * `attachmentBlobs` ([{ filename, blob }]) to have them encoded for you.
 */
export async function sendGmail({ to, cc, bcc, subject, html, text, fromName, attachments = [], attachmentBlobs = [] }) {
  const encoded = await Promise.all(
    (attachmentBlobs || []).map(async ({ filename, blob }) => ({
      filename,
      mimeType: blob?.type || 'application/octet-stream',
      base64: await blobToBase64(blob),
    })),
  );
  return invokeGoogle({ gmailSend: { to, cc, bcc, subject, html, text, fromName, attachments: [...attachments, ...encoded] } });
}

// ── Drive ─────────────────────────────────────────────────────────────────

/** Find (or create) the single workspace root folder; returns { id, url }. */
export async function driveEnsureRoot(name) {
  return invokeGoogle({ driveEnsureRoot: { name } });
}

/** Create (or reuse) a subfolder; returns { id, url }. */
export async function driveCreateFolder({ name, parentId } = {}) {
  return invokeGoogle({ driveCreateFolder: { name, parentId } });
}

/** Upload a Blob/File into a Drive folder; returns { id, name, url }. */
export async function driveUploadBlob({ folderId, filename, blob }) {
  const base64 = await blobToBase64(blob);
  return invokeGoogle({ driveUpload: { folderId, filename, mimeType: blob?.type || 'application/octet-stream', base64 } });
}

/** Copy an existing Drive file into a folder ("add from Drive"); returns { id, name, url }. */
export async function driveCopy({ fileId, folderId, name } = {}) {
  return invokeGoogle({ driveCopy: { fileId, folderId, name } });
}

/** Delete a Drive file or folder (deleting a folder removes its contents). */
export async function driveDelete(fileId) {
  return invokeGoogle({ driveDelete: { fileId } });
}

/**
 * Empty a folder — delete every file inside it but KEEP the folder itself, so its
 * id can be reused. Used to recycle an abandoned import draft's folder. Each
 * delete is best-effort; a single failure never rejects the whole sweep.
 */
export async function driveEmptyFolder(folderId) {
  if (!folderId) return;
  const data = await driveList(folderId);
  await Promise.all((data?.files || []).map((f) => driveDelete(f.id).catch(() => {})));
}

/** List a folder's files; returns { files }. */
export async function driveList(folderId) {
  return invokeGoogle({ driveList: { folderId } });
}

/** Search Drive by name; returns { files }. */
export async function driveSearch(q, pageSize) {
  return invokeGoogle({ driveSearch: { q, pageSize } });
}

/** Recently-modified files (the picker default); returns { files }. */
export async function driveRecent(pageSize) {
  return invokeGoogle({ driveRecent: { pageSize } });
}

/** List the shared drives (Team Drives) the connected account can see; returns { drives }. */
export async function driveSharedDrives() {
  return invokeGoogle({ driveSharedDrives: true });
}

/** The Drive web URL for a folder id (no round-trip — Drive's stable folder URL). */
export function driveFolderUrl(id) {
  return id ? `https://drive.google.com/drive/folders/${id}` : '';
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Is this Drive file a folder (or a shared-drive root, which we tag as one)? */
export function isDriveFolder(file) {
  return file?.mimeType === FOLDER_MIME;
}
