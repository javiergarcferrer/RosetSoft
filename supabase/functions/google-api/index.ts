// google-api — Gmail + Google Drive for the back-office, on ONE Google account.
//
// The dealer connects a single Google account via OAuth 2.0 with offline access
// (→ a refresh token). That one grant powers BOTH surfaces:
//   • Gmail  — send quotes / files / mailing-list mail (with PDF attachments).
//   • Drive  — a folder per importation, upload + list its documents, pick
//              existing files into the app.
// The OAuth client creds + refresh token live in the write-only
// google_oauth_config table (service-role only); the short-lived access token is
// a server-owned cache refreshed here. NOTHING secret ever reaches the browser.
//
// OAuth:
//   GET ?code&state   ← Google's redirect after consent. Public (no JWT); the
//                       one-shot `state` we stored authenticates it. Exchanges
//                       code → refresh+access tokens, resolves the account email,
//                       persists, then 302s back to the app with ?google=connected.
//
// POST body shapes (one per request; admin-gated unless noted):
//   { saveApp:{clientId,clientSecret} }  (admin) → store the OAuth client creds.
//   { authorize:{returnTo} }             (admin) → consent URL + CSRF state.
//   { disconnect:true }                  (admin) → forget tokens (keeps creds).
//   { status:true }                      → quick "is the token alive" probe.
//   { gmailSend:{to,cc,bcc,subject,html,text,fromName,attachments[]} }
//                                        → send one email (attachments base64).
//   { driveEnsureRoot:{name?} }          → find/create the workspace root folder.
//   { driveCreateFolder:{name,parentId?} } → create a subfolder, return id+link.
//   { driveUpload:{folderId,filename,mimeType,base64} } → upload one file.
//   { driveList:{folderId} }             → list a folder's files.
//   { driveSearch:{q,pageSize?} }        → search Drive by name.
//   { driveRecent:{pageSize?} }          → recently-modified files (the picker).
//
// Access tokens last ~1h and are refreshed from the refresh token on demand.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const TEAM = 'team';
const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DEFAULT_ROOT = 'RosetSoft';

// One consent covers both surfaces. gmail.send (send-only, no inbox read),
// full drive (browse + create + upload — drive.file alone can't see files the
// app didn't create, which "add from Drive" needs), and the account email.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
].join(' ');

type Attachment = { filename?: string; mimeType?: string; base64?: string };
type Body = {
  saveApp?: { clientId?: string; clientSecret?: string };
  authorize?: { returnTo?: string };
  disconnect?: boolean;
  status?: boolean;
  gmailSend?: {
    to?: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject?: string;
    html?: string;
    text?: string;
    fromName?: string;
    attachments?: Attachment[];
  };
  driveEnsureRoot?: { name?: string };
  driveCreateFolder?: { name?: string; parentId?: string };
  driveUpload?: { folderId?: string; filename?: string; mimeType?: string; base64?: string };
  driveCopy?: { fileId?: string; folderId?: string; name?: string };
  driveList?: { folderId?: string };
  driveSearch?: { q?: string; pageSize?: number };
  driveRecent?: { pageSize?: number };
};

type Admin = SupabaseClient;
type Cfg = {
  client_id?: string;
  client_secret?: string;
  access_token?: string;
  refresh_token?: string;
  token_expires_at?: string;
};

// ── base64 helpers (Deno's btoa is binary-string only) ─────────────────────
function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
const strToB64 = (s: string): string => bytesToB64(new TextEncoder().encode(s));
const toB64Url = (b64: string): string => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** RFC 2047 encoded-word for a header value that may carry UTF-8 (e.g. subject). */
const encHeader = (s: string): string => (/^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${strToB64(s)}?=`);
const asList = (v?: string | string[]): string =>
  (Array.isArray(v) ? v : v ? [v] : []).map((s) => String(s).trim()).filter(Boolean).join(', ');
/** base64 string → fixed 76-char lines (MIME base64 attachment bodies). */
const wrap76 = (b64: string): string => b64.replace(/(.{76})/g, '$1\r\n');

/** Build a base64url-encoded RFC 5322 message (gmail.send `raw`). */
function buildRawMessage(opts: {
  to: string; cc: string; bcc: string; from: string; subject: string;
  html?: string; text?: string; attachments: Attachment[];
}): string {
  const { to, cc, bcc, from, subject } = opts;
  const boundary = `rs_${crypto.randomUUID().replace(/-/g, '')}`;
  const altBoundary = `alt_${crypto.randomUUID().replace(/-/g, '')}`;
  const headers: string[] = [];
  if (from) headers.push(`From: ${from}`);
  headers.push(`To: ${to}`);
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  headers.push(`Subject: ${encHeader(subject)}`);
  headers.push('MIME-Version: 1.0');

  const text = opts.text ?? (opts.html ? opts.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');
  const html = opts.html ?? '';

  // The body: a text/html alternative, optionally wrapped in multipart/mixed
  // when there are attachments.
  const bodyPart = (): string => {
    const parts: string[] = [];
    parts.push(`--${altBoundary}`);
    parts.push('Content-Type: text/plain; charset="UTF-8"');
    parts.push('Content-Transfer-Encoding: base64', '', wrap76(strToB64(text)), '');
    if (html) {
      parts.push(`--${altBoundary}`);
      parts.push('Content-Type: text/html; charset="UTF-8"');
      parts.push('Content-Transfer-Encoding: base64', '', wrap76(strToB64(html)), '');
    }
    parts.push(`--${altBoundary}--`);
    return `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n${parts.join('\r\n')}`;
  };

  const attachments = (opts.attachments || []).filter((a) => a?.base64);
  let mime: string;
  if (attachments.length === 0) {
    mime = `${headers.join('\r\n')}\r\n${bodyPart()}`;
  } else {
    const lines: string[] = [];
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '');
    lines.push(`--${boundary}`);
    lines.push(bodyPart());
    for (const a of attachments) {
      const name = a.filename || 'archivo';
      lines.push(`--${boundary}`);
      lines.push(`Content-Type: ${a.mimeType || 'application/octet-stream'}; name="${name}"`);
      lines.push('Content-Transfer-Encoding: base64');
      lines.push(`Content-Disposition: attachment; filename="${name}"`, '', wrap76((a.base64 || '').replace(/\s+/g, '')), '');
    }
    lines.push(`--${boundary}--`);
    mime = `${headers.join('\r\n')}\r\n${lines.join('\r\n')}`;
  }
  return toB64Url(strToB64(mime));
}

/** Current access token, refreshed from the refresh token when stale. */
async function resolveToken(admin: Admin, cfg: Cfg): Promise<string> {
  const exp = cfg.token_expires_at ? Date.parse(cfg.token_expires_at) : 0;
  // Reuse the cached token until ~2 min before expiry.
  if (cfg.access_token && exp && exp - Date.now() > 120_000) return cfg.access_token;
  if (!cfg.refresh_token || !cfg.client_id || !cfg.client_secret) return cfg.access_token || '';
  const r = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      grant_type: 'refresh_token',
      refresh_token: cfg.refresh_token,
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d?.access_token) {
    throw new Error(d?.error_description || d?.error || `No se pudo renovar el acceso a Google (${r.status})`);
  }
  const token = String(d.access_token);
  await admin.from('google_oauth_config').update({
    access_token: token,
    token_expires_at: new Date(Date.now() + (Number(d.expires_in) || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('profile_id', TEAM);
  return token;
}

async function driveFetch(token: string, url: string, init: RequestInit = {}) {
  const r = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || d?.error || `Drive ${r.status}`);
  return d;
}

const escapeQ = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Find (or create) the single workspace root folder; cache its id on settings. */
async function ensureRoot(admin: Admin, token: string, name = DEFAULT_ROOT): Promise<{ id: string; url: string }> {
  const { data: s } = await admin.from('settings').select('google_drive_root_folder_id').eq('profile_id', TEAM).maybeSingle();
  const cached = s?.google_drive_root_folder_id || '';
  if (cached) {
    try {
      const meta = await driveFetch(token, `${DRIVE}/files/${cached}?fields=id,trashed,webViewLink`);
      if (meta?.id && !meta.trashed) return { id: meta.id, url: meta.webViewLink || '' };
    } catch { /* cached id gone — recreate below */ }
  }
  const q = `mimeType='${FOLDER_MIME}' and name='${escapeQ(name)}' and trashed=false and 'root' in parents`;
  const found = await driveFetch(token, `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,webViewLink)&pageSize=1`);
  let id = found?.files?.[0]?.id || '';
  let url = found?.files?.[0]?.webViewLink || '';
  if (!id) {
    const created = await driveFetch(token, `${DRIVE}/files?fields=id,webViewLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    });
    id = created.id; url = created.webViewLink || '';
  }
  await admin.from('settings').update({ google_drive_root_folder_id: id }).eq('profile_id', TEAM);
  return { id, url };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) return json({ error: 'Server misconfigured' }, 500);

  // OAuth redirect URI — register this verbatim in the Google Cloud OAuth client.
  const redirectUri = `${SUPABASE_URL}/functions/v1/google-api`;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── OAuth callback (Google → us). Public GET, authenticated by one-shot state. ──
  if (req.method === 'GET') {
    const u = new URL(req.url);
    const code = u.searchParams.get('code') || '';
    const state = u.searchParams.get('state') || '';
    const oauthErr = u.searchParams.get('error') || '';

    const { data: cfg } = await admin
      .from('google_oauth_config')
      .select('client_id, client_secret, oauth_state, oauth_return_to')
      .eq('profile_id', TEAM)
      .maybeSingle();
    const returnTo = cfg?.oauth_return_to || SUPABASE_URL;
    const back = (q: string) => Response.redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}${q}`, 302);

    if (oauthErr) return back(`google_error=${encodeURIComponent(oauthErr.slice(0, 160))}`);
    if (!code) return back('google_error=missing_code');
    if (!cfg?.oauth_state || state !== cfg.oauth_state) return back('google_error=state_mismatch');

    try {
      const tr = await fetch(TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.client_id || '',
          client_secret: cfg.client_secret || '',
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code,
        }),
      });
      const td = await tr.json().catch(() => ({}));
      if (!tr.ok) throw new Error(td?.error_description || td?.error || `token ${tr.status}`);
      const accessToken = String(td.access_token || '');
      const refreshToken = String(td.refresh_token || '');
      if (!accessToken) throw new Error('Google no devolvió un token');

      let email = '';
      try {
        const me = await fetch(USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
        const md = await me.json().catch(() => ({}));
        email = String(md?.email || '');
      } catch { /* email is cosmetic */ }

      const patch: Record<string, unknown> = {
        access_token: accessToken,
        token_expires_at: new Date(Date.now() + (Number(td.expires_in) || 3600) * 1000).toISOString(),
        scopes: String(td.scope || SCOPES),
        oauth_state: '',
        updated_at: new Date().toISOString(),
      };
      // Google only returns a refresh token on the FIRST consent (prompt=consent
      // forces a fresh one); never overwrite a stored one with an empty value.
      if (refreshToken) patch.refresh_token = refreshToken;
      await admin.from('google_oauth_config').update(patch).eq('profile_id', TEAM);
      await admin.from('settings').update({
        google_connected_at: new Date().toISOString(),
        google_email: email,
      }).eq('profile_id', TEAM);

      return back('google=connected');
    } catch (e) {
      return back(`google_error=${encodeURIComponent(String((e as Error)?.message || e).slice(0, 160))}`);
    }
  }

  // ── POST: verify the caller itself (gateway verify_jwt is off for CORS). ──
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authorization header required' }, 401);
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'Invalid or expired session' }, 401);
  const callerId = userData.user.id;
  const requireAdmin = async (): Promise<string | null> => {
    const { data: prof } = await admin.from('profiles').select('role, active').eq('id', callerId).maybeSingle();
    if (!prof || prof.role !== 'admin' || !prof.active) return 'Solo un administrador puede conectar Google.';
    return null;
  };

  let body: Body = {};
  try { body = await req.json(); } catch { /* empty body */ }

  // ── saveApp: persist the OAuth client credentials (admin) ──────────────────
  if (body.saveApp) {
    const err = await requireAdmin();
    if (err) return json({ ok: false, error: err }, 403);
    const clientId = String(body.saveApp.clientId || '').trim();
    const clientSecret = String(body.saveApp.clientSecret || '').trim();
    if (!clientId) return json({ ok: false, error: 'Client ID requerido' }, 400);
    // Leave the secret untouched on a blank re-save (re-entering the id never wipes it).
    const patch: Record<string, unknown> = { profile_id: TEAM, client_id: clientId, updated_at: new Date().toISOString() };
    if (clientSecret) patch.client_secret = clientSecret;
    const { error: upErr } = await admin.from('google_oauth_config').upsert(patch);
    if (upErr) return json({ ok: false, error: upErr.message });
    await admin.from('settings').update({ google_client_id: clientId }).eq('profile_id', TEAM);
    return json({ ok: true, redirectUri });
  }

  // ── authorize: build the consent URL + a one-shot CSRF state (admin) ───────
  if (body.authorize) {
    const err = await requireAdmin();
    if (err) return json({ ok: false, error: err }, 403);
    const { data: cfg } = await admin
      .from('google_oauth_config').select('client_id, client_secret').eq('profile_id', TEAM).maybeSingle();
    if (!cfg?.client_id || !cfg?.client_secret) {
      return json({ ok: false, error: 'Guarda primero el Client ID y el Client Secret de Google.' });
    }
    const state = crypto.randomUUID();
    await admin.from('google_oauth_config').update({
      oauth_state: state,
      oauth_return_to: String(body.authorize.returnTo || '').trim(),
      updated_at: new Date().toISOString(),
    }).eq('profile_id', TEAM);
    const url = new URL(AUTHORIZE);
    url.searchParams.set('client_id', cfg.client_id);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('access_type', 'offline');     // ask for a refresh token
    url.searchParams.set('prompt', 'consent');          // force one every time
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('state', state);
    return json({ ok: true, url: url.toString(), redirectUri });
  }

  // ── disconnect: drop the tokens (keep the client creds) (admin) ────────────
  if (body.disconnect) {
    const err = await requireAdmin();
    if (err) return json({ ok: false, error: err }, 403);
    await admin.from('google_oauth_config').update({
      access_token: '', refresh_token: '', token_expires_at: null, oauth_state: '', updated_at: new Date().toISOString(),
    }).eq('profile_id', TEAM);
    await admin.from('settings').update({ google_connected_at: null, google_email: '' }).eq('profile_id', TEAM);
    return json({ ok: true });
  }

  // Everything below needs a live token.
  const { data: cfg } = await admin
    .from('google_oauth_config')
    .select('client_id, client_secret, access_token, refresh_token, token_expires_at')
    .eq('profile_id', TEAM)
    .maybeSingle();
  if (!cfg?.refresh_token) return json({ configured: false, error: 'Google sin conectar' });

  let token = '';
  try { token = await resolveToken(admin, cfg); } catch (e) { return json({ ok: false, error: String((e as Error)?.message || e) }, 502); }
  if (!token) return json({ configured: false, error: 'Google sin conectar' });

  try {
    // ── status probe ──────────────────────────────────────────────────────
    if (body.status) return json({ ok: true, configured: true });

    // ── Gmail send ──────────────────────────────────────────────────────────
    if (body.gmailSend) {
      const g = body.gmailSend;
      const to = asList(g.to);
      if (!to) return json({ ok: false, error: 'Falta el destinatario' }, 400);
      const { data: s } = await admin.from('settings').select('google_email').eq('profile_id', TEAM).maybeSingle();
      const fromAddr = s?.google_email || '';
      const from = g.fromName && fromAddr ? `${encHeader(g.fromName)} <${fromAddr}>` : fromAddr;
      const raw = buildRawMessage({
        to, cc: asList(g.cc), bcc: asList(g.bcc), from,
        subject: String(g.subject || ''), html: g.html, text: g.text,
        attachments: g.attachments || [],
      });
      const r = await fetch(`${GMAIL}/messages/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ ok: false, error: d?.error?.message || `Gmail ${r.status}` }, 502);
      return json({ ok: true, id: d.id, threadId: d.threadId });
    }

    // ── Drive: ensure root ───────────────────────────────────────────────────
    if (body.driveEnsureRoot) {
      const root = await ensureRoot(admin, token, String(body.driveEnsureRoot.name || DEFAULT_ROOT));
      return json({ ok: true, ...root });
    }

    // ── Drive: create folder ─────────────────────────────────────────────────
    if (body.driveCreateFolder) {
      const name = String(body.driveCreateFolder.name || '').trim();
      if (!name) return json({ ok: false, error: 'Falta el nombre de la carpeta' }, 400);
      const parentId = body.driveCreateFolder.parentId || (await ensureRoot(admin, token)).id;
      // Reuse an existing same-named folder under the parent (idempotent).
      const q = `mimeType='${FOLDER_MIME}' and name='${escapeQ(name)}' and trashed=false and '${parentId}' in parents`;
      const found = await driveFetch(token, `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,webViewLink)&pageSize=1`);
      if (found?.files?.[0]?.id) return json({ ok: true, id: found.files[0].id, url: found.files[0].webViewLink || '' });
      const created = await driveFetch(token, `${DRIVE}/files?fields=id,webViewLink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      });
      return json({ ok: true, id: created.id, url: created.webViewLink || '' });
    }

    // ── Drive: upload a file ─────────────────────────────────────────────────
    if (body.driveUpload) {
      const up = body.driveUpload;
      if (!up.base64) return json({ ok: false, error: 'Falta el contenido del archivo' }, 400);
      const parents = up.folderId ? [up.folderId] : [(await ensureRoot(admin, token)).id];
      const metadata = { name: up.filename || 'archivo', parents };
      const boundary = `up_${crypto.randomUUID().replace(/-/g, '')}`;
      const multipart =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: ${up.mimeType || 'application/octet-stream'}\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n${(up.base64 || '').replace(/\s+/g, '')}\r\n--${boundary}--`;
      const r = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,webViewLink`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipart,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ ok: false, error: d?.error?.message || `Drive ${r.status}` }, 502);
      return json({ ok: true, id: d.id, name: d.name, url: d.webViewLink || '' });
    }

    // ── Drive: copy an existing file into a folder ("add from Drive") ────────
    if (body.driveCopy) {
      const fileId = String(body.driveCopy.fileId || '').trim();
      if (!fileId) return json({ ok: false, error: 'Falta el archivo' }, 400);
      const parents = body.driveCopy.folderId ? [body.driveCopy.folderId] : [(await ensureRoot(admin, token)).id];
      const meta: Record<string, unknown> = { parents };
      if (body.driveCopy.name) meta.name = body.driveCopy.name;
      const d = await driveFetch(token, `${DRIVE}/files/${fileId}/copy?fields=id,name,webViewLink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      });
      return json({ ok: true, id: d.id, name: d.name, url: d.webViewLink || '' });
    }

    // ── Drive: list a folder ─────────────────────────────────────────────────
    if (body.driveList) {
      const folderId = String(body.driveList.folderId || '').trim();
      if (!folderId) return json({ ok: false, error: 'Falta la carpeta' }, 400);
      const q = `'${escapeQ(folderId)}' in parents and trashed=false`;
      const d = await driveFetch(
        token,
        `${DRIVE}/files?q=${encodeURIComponent(q)}&orderBy=folder,name&pageSize=200&fields=files(id,name,mimeType,iconLink,webViewLink,modifiedTime,size)`,
      );
      return json({ ok: true, files: d.files || [] });
    }

    // ── Drive: search ────────────────────────────────────────────────────────
    if (body.driveSearch) {
      const needle = String(body.driveSearch.q || '').trim();
      const pageSize = Math.min(Math.max(Number(body.driveSearch.pageSize) || 25, 1), 100);
      const q = `name contains '${escapeQ(needle)}' and trashed=false`;
      const d = await driveFetch(
        token,
        `${DRIVE}/files?q=${encodeURIComponent(q)}&orderBy=modifiedTime desc&pageSize=${pageSize}&fields=files(id,name,mimeType,iconLink,webViewLink,modifiedTime,size)`,
      );
      return json({ ok: true, files: d.files || [] });
    }

    // ── Drive: recent files (the picker) ─────────────────────────────────────
    if (body.driveRecent) {
      const pageSize = Math.min(Math.max(Number(body.driveRecent.pageSize) || 25, 1), 100);
      const d = await driveFetch(
        token,
        `${DRIVE}/files?q=${encodeURIComponent('trashed=false')}&orderBy=modifiedTime desc&pageSize=${pageSize}&fields=files(id,name,mimeType,iconLink,webViewLink,modifiedTime,size)`,
      );
      return json({ ok: true, files: d.files || [] });
    }

    return json({ ok: false, error: 'Acción no reconocida' }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 200) }, 502);
  }
});
