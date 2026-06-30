// google-api — Gmail + Google Drive for the back-office, on ONE Google account.
//
// The dealer connects a single Google account via OAuth 2.0 with offline access
// (→ a refresh token). That one grant powers BOTH surfaces:
//   • Gmail  — send quotes / files / mailing-list mail (with PDF attachments),
//              and READ inbound mail (gmail.readonly) so the meta-receipts job
//              can pull Meta Ads payment receipts from the inbox.
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
// "Sign in with Google" (login) — a SECOND purpose for the same OAuth client,
// kept fully separate from the Gmail/Drive workspace grant above:
//   GET ?login=start&returnTo=… ← public. Builds a consent URL with MINIMAL
//                       scopes (openid email profile) + an HMAC-signed `state`
//                       (no shared CSRF slot → concurrent logins are fine) and
//                       302s to Google. `returnTo` is origin-allowlisted so a
//                       crafted link can't redirect the one-time login token to
//                       an attacker.
//   GET ?code&state(login) ← the same redirect URI; when `state` is a signed
//                       login token we verify the Google identity + domain,
//                       ensure a Supabase auth user, mint a magic-link
//                       hashed_token and 302 back with ?gl_login=<token>. The SPA
//                       trades it for a session via verifyOtp. We NEVER store the
//                       user's Google tokens — login only reads their email.
//
// POST body shapes (one per request; admin-gated unless noted):
//   { saveApp:{clientId,clientSecret} }  (admin) → store the OAuth client creds.
//   { authorize:{returnTo} }             (admin) → consent URL + CSRF state.
//   { disconnect:true }                  (admin) → forget tokens (keeps creds).
//   { status:true }                      → quick "is the token alive" probe.
//   { gmailSend:{to,cc,bcc,subject,html,text,fromName,attachments[]} }
//                                        → send one email (attachments base64).
//   { gmailAttachment:{messageId,attachmentId} } → fetch one attachment's bytes
//                                        (base64) for preview/download.
//   { driveEnsureRoot:{name?} }          → find/create the workspace root folder.
//   { driveCreateFolder:{name,parentId?} } → create a subfolder, return id+link.
//   { driveUpload:{folderId,filename,mimeType,base64} } → upload one file.
//   { driveList:{folderId} }             → list a folder's files (incl. shared drives).
//   { driveSearch:{q,pageSize?} }        → search Drive by name (across all drives).
//   { driveRecent:{pageSize?} }          → recently-modified files (the picker).
//   { driveSharedDrives:true }           → list the shared drives (Team Drives).
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
// Query params that make files.list see SHARED DRIVES (Team Drives), not just
// My Drive; `supportsAllDrives` also lets create/copy/upload/delete target them.
const ALL_DRIVES = 'includeItemsFromAllDrives=true&supportsAllDrives=true';

// One consent covers all surfaces. gmail.send (send quotes/files/mail),
// gmail.readonly (read INBOUND mail — the `meta-receipts` job searches the
// inbox for Meta Ads payment receipts to file as gastos with the receipt
// attached), full drive (browse + create + upload — drive.file alone can't see
// files the app didn't create, which "add from Drive" needs), and the account
// email. Adding a scope is why a connected account must RE-CONNECT once (Google
// forces re-consent for a new scope).
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
].join(' ');

// Login is identity-only — no Gmail/Drive scopes, no offline access. We just
// read the verified email; we store nothing.
const LOGIN_SCOPES = 'openid email profile';
// A login `state` is self-authenticating (HMAC-signed) rather than a stored
// one-shot, so it doesn't collide with the admin connect flow's oauth_state and
// supports many team members logging in at once. This prefix tells the callback
// "this is a login round-trip, not a workspace connect".
const LOGIN_STATE_PREFIX = 'lg1.';
const LOGIN_STATE_TTL_MS = 10 * 60 * 1000; // consent must complete within 10 min

type Attachment = { filename?: string; mimeType?: string; base64?: string };
type Body = {
  saveApp?: { clientId?: string; clientSecret?: string };
  saveLogin?: { domain?: string };
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
  // A reply nests into an existing thread: `threadId` makes Gmail file it under
  // the conversation, and the server pulls the original's Message-ID/References
  // (`messageId` = the message being replied to) to set the In-Reply-To /
  // References headers every other mail client threads by.
  gmailReply?: {
    messageId?: string;
    threadId?: string;
    to?: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject?: string;
    html?: string;
    text?: string;
    fromName?: string;
    attachments?: Attachment[];
  };
  gmailSync?: { query?: string; maxResults?: number };
  // Add/remove Gmail labels on a batch of messages — read/unread (UNREAD),
  // star (STARRED), archive (remove INBOX), etc. — so an action in our inbox
  // reflects in the dealer's actual Gmail.
  gmailModify?: { ids?: string[]; addLabelIds?: string[]; removeLabelIds?: string[] };
  // Move messages to Trash (Gmail requires the dedicated trash endpoint — TRASH
  // can't be applied via batchModify).
  gmailTrash?: { ids?: string[] };
  gmailAttachment?: { messageId?: string; attachmentId?: string };
  driveEnsureRoot?: { name?: string };
  driveCreateFolder?: { name?: string; parentId?: string };
  driveUpload?: { folderId?: string; filename?: string; mimeType?: string; base64?: string };
  driveCopy?: { fileId?: string; folderId?: string; name?: string };
  driveDelete?: { fileId?: string };
  driveList?: { folderId?: string };
  driveSearch?: { q?: string; pageSize?: number };
  driveRecent?: { pageSize?: number };
  driveSharedDrives?: boolean;
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
/** Gmail's base64url (attachment data) → standard, padded base64 the browser can decode. */
const b64UrlToStd = (s: string): string => {
  let v = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = v.length % 4;
  if (pad) v += '='.repeat(4 - pad);
  return v;
};

// ── login state: HMAC-signed, stateless ────────────────────────────────────
function b64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}
/** Sign a small JSON payload → `lg1.<b64url(json)>.<b64url(sig)>`. */
async function signLoginState(secret: string, payload: Record<string, unknown>): Promise<string> {
  const body = toB64Url(strToB64(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `${LOGIN_STATE_PREFIX}${body}.${toB64Url(bytesToB64(sig))}`;
}
/** Verify + decode a login state; null if tampered, malformed, or expired. */
async function verifyLoginState(secret: string, state: string): Promise<Record<string, unknown> | null> {
  if (!state.startsWith(LOGIN_STATE_PREFIX)) return null;
  const rest = state.slice(LOGIN_STATE_PREFIX.length);
  const dot = rest.lastIndexOf('.');
  if (dot < 0) return null;
  const body = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, b64UrlToBytes(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64UrlToBytes(body))) as Record<string, unknown>;
    const exp = Number(payload.exp || 0);
    if (!exp || Date.now() > exp) return null;
    return payload;
  } catch { return null; }
}

const originOf = (raw?: string | null): string => {
  if (!raw) return '';
  try { return new URL(raw).origin; } catch { return ''; }
};

/**
 * The app origins a login token may be redirected back to. Derived (zero-config)
 * from the origin the admin connected Google from (google_oauth_config
 * .oauth_return_to) — that browser proved it's the real app — plus localhost for
 * dev. An unrecognised returnTo is refused so a crafted link can't steal the
 * one-time login token.
 */
async function allowedLoginOrigins(admin: Admin): Promise<Set<string>> {
  const set = new Set<string>(['http://localhost:5173', 'http://localhost:3000']);
  const { data } = await admin
    .from('google_oauth_config').select('oauth_return_to').eq('profile_id', TEAM).maybeSingle();
  const o = originOf(data?.oauth_return_to);
  if (o) set.add(o);
  return set;
}

/** Build a base64url-encoded RFC 5322 message (gmail.send `raw`). */
function buildRawMessage(opts: {
  to: string; cc: string; bcc: string; from: string; subject: string;
  html?: string; text?: string; attachments: Attachment[];
  inReplyTo?: string; references?: string;
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
  // Reply threading: clients chain a conversation by these two headers.
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) headers.push(`References: ${opts.references}`);
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
      const meta = await driveFetch(token, `${DRIVE}/files/${cached}?fields=id,trashed,webViewLink&supportsAllDrives=true`);
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

// ── Gmail read (inbox sync) ─────────────────────────────────────────────────
// Mirrors the read path the meta-receipts job uses: list ids → fetch each full
// message → extract headers + bodies + attachment metadata. The classification
// (brand) + invoice detection are pure DERIVATIONS done client-side in the
// ViewModel, so this only stores the raw email fields.
function b64urlDecode(s: string): string {
  try {
    const bin = atob(String(s || '').replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch { return ''; }
}

type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
};

/** Walk the MIME tree collecting the text/html bodies + any attachment parts. */
function extractGmailContent(payload: GmailPart | undefined): {
  text: string; html: string; attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }>;
} {
  let text = '', html = '';
  const attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> = [];
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    const mt = String(p.mimeType || '');
    const data = p.body?.data;
    const attId = p.body?.attachmentId;
    if (p.filename && attId) {
      attachments.push({ filename: p.filename, mimeType: mt || 'application/octet-stream', size: Number(p.body?.size) || 0, attachmentId: attId });
    } else if (data) {
      if (mt === 'text/plain') text += b64urlDecode(data);
      else if (mt === 'text/html') html += b64urlDecode(data);
    }
    for (const part of p.parts || []) walk(part);
  };
  walk(payload);
  return { text, html, attachments };
}

/** Split an RFC 5322 `From`/`To` header into a display name + bare address. */
function parseAddress(raw: string): { name: string; email: string } {
  const s = String(raw || '').trim();
  const m = s.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { name: (m[1] || '').trim().replace(/^"|"$/g, ''), email: (m[2] || '').trim().toLowerCase() };
  return { name: '', email: s.toLowerCase() };
}

async function gmailListIds(token: string, query: string, maxResults: number): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = '';
  while (ids.length < maxResults) {
    const url = new URL(`${GMAIL}/messages`);
    if (query) url.searchParams.set('q', query);
    url.searchParams.set('maxResults', String(Math.min(100, maxResults - ids.length)));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error?.message || `Gmail ${r.status}`);
    for (const m of (d.messages || []) as Array<{ id: string }>) ids.push(m.id);
    pageToken = d.nextPageToken || '';
    if (!pageToken) break;
  }
  return ids.slice(0, maxResults);
}

async function gmailGetMessage(token: string, id: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${GMAIL}/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Gmail ${r.status}`);
  const headers = ((d.payload?.headers || []) as Array<{ name: string; value: string }>);
  const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n)?.value || '';
  const { text, html, attachments } = extractGmailContent(d.payload as GmailPart);
  const labelIds = (d.labelIds || []) as string[];
  const from = parseAddress(h('from'));
  const to = parseAddress(h('to'));
  return {
    id: d.id,
    profile_id: TEAM,
    thread_id: d.threadId || d.id,
    direction: labelIds.includes('SENT') ? 'out' : 'in',
    from_email: from.email,
    from_name: from.name,
    to_email: to.email,
    subject: h('subject'),
    snippet: String(d.snippet || ''),
    body_text: text.slice(0, 100_000),
    body_html: html.slice(0, 400_000),
    label_ids: labelIds,
    has_attachment: attachments.length > 0,
    attachment_count: attachments.length,
    attachments,
    is_read: !labelIds.includes('UNREAD'),
    received_at: d.internalDate ? new Date(Number(d.internalDate)).toISOString() : null,
  };
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

    // ── "Sign in with Google" — START the login consent (public) ─────────────
    if (u.searchParams.get('login') === 'start') {
      const rawReturn = u.searchParams.get('returnTo') || '';
      const ret = originOf(rawReturn);
      const origins = await allowedLoginOrigins(admin);
      if (!ret || !origins.has(ret)) return json({ error: 'returnTo no permitido' }, 400);
      const lback = (q: string) => Response.redirect(`${rawReturn}${rawReturn.includes('?') ? '&' : '?'}${q}`, 302);
      const { data: cfg } = await admin
        .from('google_oauth_config').select('client_id').eq('profile_id', TEAM).maybeSingle();
      if (!cfg?.client_id) return lback(`gl_error=${encodeURIComponent('Acceso con Google no disponible — conéctalo en Integraciones.')}`);
      const loginState = await signLoginState(SERVICE_ROLE_KEY, {
        t: 'login', r: rawReturn, exp: Date.now() + LOGIN_STATE_TTL_MS, n: crypto.randomUUID(),
      });
      const url = new URL(AUTHORIZE);
      url.searchParams.set('client_id', cfg.client_id);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', LOGIN_SCOPES);
      url.searchParams.set('access_type', 'online');     // identity only — no refresh token
      url.searchParams.set('prompt', 'select_account');
      url.searchParams.set('include_granted_scopes', 'true');
      url.searchParams.set('state', loginState);
      return Response.redirect(url.toString(), 302);
    }

    // ── "Sign in with Google" — CALLBACK (state is a signed login token) ──────
    if (state.startsWith(LOGIN_STATE_PREFIX)) {
      const payload = await verifyLoginState(SERVICE_ROLE_KEY, state);
      // returnTo inside the payload was origin-checked at start AND is HMAC-protected.
      const loginReturn = String(payload?.r || '') || SUPABASE_URL;
      const lback = (q: string) => Response.redirect(`${loginReturn}${loginReturn.includes('?') ? '&' : '?'}${q}`, 302);
      const fail = (m: string) => lback(`gl_error=${encodeURIComponent(m.slice(0, 160))}`);
      if (oauthErr) return fail(oauthErr);
      if (!payload) return fail('Enlace de acceso vencido. Intenta de nuevo.');
      if (!code) return fail('missing_code');
      try {
        const { data: cfg } = await admin
          .from('google_oauth_config').select('client_id, client_secret').eq('profile_id', TEAM).maybeSingle();
        if (!cfg?.client_id || !cfg?.client_secret) return fail('Acceso con Google no disponible.');
        const tr = await fetch(TOKEN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: cfg.client_id, client_secret: cfg.client_secret,
            grant_type: 'authorization_code', redirect_uri: redirectUri, code,
          }),
        });
        const td = await tr.json().catch(() => ({}));
        if (!tr.ok || !td?.access_token) throw new Error(td?.error_description || td?.error || `token ${tr.status}`);

        const me = await fetch(USERINFO, { headers: { Authorization: `Bearer ${td.access_token}` } });
        const md = await me.json().catch(() => ({}));
        const email = String(md?.email || '').toLowerCase().trim();
        const verified = md?.verified_email !== false;   // userinfo: verified_email boolean
        const name = String(md?.name || '').trim();
        if (!email || !verified) return fail('No se pudo verificar tu correo de Google.');

        // Domain gate: settings.google_login_domain, else the connected account's domain.
        const { data: s } = await admin
          .from('settings').select('google_login_domain, google_email').eq('profile_id', TEAM).maybeSingle();
        const configured = String(s?.google_login_domain || '').trim().toLowerCase().replace(/^@/, '');
        const fallback = (String(s?.google_email || '').split('@')[1] || '').toLowerCase().trim();
        const allowed = configured || fallback;
        if (!allowed) return fail('El acceso con Google no está habilitado. Configúralo en Integraciones.');
        if ((email.split('@')[1] || '') !== allowed) return fail(`Solo cuentas @${allowed} pueden entrar con Google.`);

        // Ensure the auth user exists (idempotent). user_metadata.google_login lets
        // the app skip the SetPassword gate — these users sign in passwordless.
        await admin.auth.admin.createUser({
          email, email_confirm: true, user_metadata: { google_login: true, name },
        }).catch(() => { /* already registered — proceed to mint a session */ });

        // Mint a one-time magic-link token; the SPA trades it for a session via verifyOtp.
        const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
        const hashed = link?.properties?.hashed_token;
        if (linkErr || !hashed) throw new Error(linkErr?.message || 'No se pudo iniciar sesión.');
        return lback(`gl_login=${encodeURIComponent(hashed)}`);
      } catch (e) {
        return fail(String((e as Error)?.message || e));
      }
    }

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

  // ── saveLogin: which email domain may "Sign in with Google" (admin) ────────
  if (body.saveLogin) {
    const err = await requireAdmin();
    if (err) return json({ ok: false, error: err }, 403);
    const domain = String(body.saveLogin.domain || '').trim().toLowerCase().replace(/^@/, '');
    const { error: upErr } = await admin.from('settings').update({ google_login_domain: domain }).eq('profile_id', TEAM);
    if (upErr) return json({ ok: false, error: upErr.message });
    return json({ ok: true });
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

    // ── Gmail reply ───────────────────────────────────────────────────────────
    // Reply INTO an existing thread. We pass Gmail's `threadId` so it nests on
    // our side, and pull the original message's RFC822 Message-ID + References
    // (a cheap metadata fetch — the sync stores only Gmail's internal id) to set
    // In-Reply-To / References, the headers every other client threads by.
    if (body.gmailReply) {
      const g = body.gmailReply;
      const to = asList(g.to);
      if (!to) return json({ ok: false, error: 'Falta el destinatario' }, 400);
      const { data: s } = await admin.from('settings').select('google_email').eq('profile_id', TEAM).maybeSingle();
      const fromAddr = s?.google_email || '';
      const from = g.fromName && fromAddr ? `${encHeader(g.fromName)} <${fromAddr}>` : fromAddr;

      let inReplyTo = '';
      let references = '';
      if (g.messageId) {
        try {
          const mr = await fetch(
            `${GMAIL}/messages/${g.messageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          const md = await mr.json().catch(() => ({}));
          const hs = ((md.payload?.headers || []) as Array<{ name: string; value: string }>);
          const get = (n: string) => hs.find((x) => x.name.toLowerCase() === n)?.value || '';
          inReplyTo = get('message-id');
          references = [get('references'), inReplyTo].filter(Boolean).join(' ').trim();
        } catch { /* best-effort threading — the send still goes out */ }
      }

      const raw = buildRawMessage({
        to, cc: asList(g.cc), bcc: asList(g.bcc), from,
        subject: String(g.subject || ''), html: g.html, text: g.text,
        attachments: g.attachments || [], inReplyTo, references,
      });
      const r = await fetch(`${GMAIL}/messages/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(g.threadId ? { raw, threadId: g.threadId } : { raw }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ ok: false, error: d?.error?.message || `Gmail ${r.status}` }, 502);
      return json({ ok: true, id: d.id, threadId: d.threadId });
    }

    // ── Gmail modify (labels: read/unread, star, archive) ─────────────────────
    // batchModify adds/removes labels on up to 1000 messages in one call (204 No
    // Content on success). Used for mark read/unread (UNREAD), star (STARRED) and
    // archive (remove INBOX) — so the action taken in our inbox lands in Gmail.
    if (body.gmailModify) {
      const ids = (body.gmailModify.ids || []).filter(Boolean).slice(0, 1000);
      if (!ids.length) return json({ ok: true, modified: 0 });
      const r = await fetch(`${GMAIL}/messages/batchModify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids,
          addLabelIds: body.gmailModify.addLabelIds || [],
          removeLabelIds: body.gmailModify.removeLabelIds || [],
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        return json({ ok: false, error: d?.error?.message || `Gmail ${r.status}` }, 502);
      }
      return json({ ok: true, modified: ids.length });
    }

    // ── Gmail trash ───────────────────────────────────────────────────────────
    // TRASH is special in Gmail — it can't be set via batchModify, so each id
    // goes through the dedicated trash endpoint. Best-effort per id.
    if (body.gmailTrash) {
      const ids = (body.gmailTrash.ids || []).filter(Boolean).slice(0, 200);
      let trashed = 0;
      for (const id of ids) {
        const r = await fetch(`${GMAIL}/messages/${id}/trash`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.ok) trashed += 1;
      }
      return json({ ok: true, trashed });
    }

    // ── Gmail sync ────────────────────────────────────────────────────────────
    // List recent messages, fetch the ones we don't have yet, and upsert them
    // into gmail_messages. Already-stored ids are skipped (the message body is
    // immutable), keeping each sync to only the new mail. The inbox reads the
    // table; brand/invoice classification happens client-side.
    if (body.gmailSync) {
      const maxResults = Math.min(Math.max(Number(body.gmailSync.maxResults) || 120, 1), 250);
      // Default: recent inbox + our replies, so a thread shows both sides.
      const query = String(body.gmailSync.query || '(in:inbox OR in:sent) newer_than:180d');
      let ids: string[];
      try { ids = await gmailListIds(token, query, maxResults); }
      catch (e) { return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 200) }, 502); }

      // Skip ids already mirrored (immutable bodies) — only fetch+store new mail.
      const known = new Set<string>();
      if (ids.length) {
        const { data: rows } = await admin.from('gmail_messages').select('id').in('id', ids);
        for (const r2 of (rows || []) as Array<{ id: string }>) known.add(r2.id);
      }
      const fresh = ids.filter((id) => !known.has(id));

      const toUpsert: Record<string, unknown>[] = [];
      for (const id of fresh) {
        try { toUpsert.push(await gmailGetMessage(token, id)); }
        catch (_) { /* one bad message never sinks the sync */ }
      }
      if (toUpsert.length) {
        // Chunk to keep each PostgREST payload bounded.
        for (let i = 0; i < toUpsert.length; i += 200) {
          const { error } = await admin.from('gmail_messages').upsert(toUpsert.slice(i, i + 200), { onConflict: 'id' });
          if (error) return json({ ok: false, error: error.message }, 502);
        }
      }
      await admin.from('settings').update({ gmail_synced_at: new Date().toISOString() }).eq('profile_id', TEAM);
      return json({ ok: true, scanned: ids.length, synced: toUpsert.length });
    }

    // ── Gmail attachment fetch (preview/download) ─────────────────────────────
    // The sync stores only attachment METADATA (filename/mime/size/attachmentId);
    // the bytes are fetched on demand here so the inbox can preview/download a
    // file without bloating gmail_messages. Gmail returns base64url — we hand the
    // browser standard, padded base64 it can turn into a Blob.
    if (body.gmailAttachment) {
      const messageId = String(body.gmailAttachment.messageId || '').trim();
      const attachmentId = String(body.gmailAttachment.attachmentId || '').trim();
      if (!messageId || !attachmentId) return json({ ok: false, error: 'Falta el adjunto' }, 400);
      const r = await fetch(`${GMAIL}/messages/${messageId}/attachments/${attachmentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ ok: false, error: d?.error?.message || `Gmail ${r.status}` }, 502);
      return json({ ok: true, base64: b64UrlToStd(String(d.data || '')), size: Number(d.size) || 0 });
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
      const found = await driveFetch(token, `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,webViewLink)&pageSize=1&${ALL_DRIVES}`);
      if (found?.files?.[0]?.id) return json({ ok: true, id: found.files[0].id, url: found.files[0].webViewLink || '' });
      const created = await driveFetch(token, `${DRIVE}/files?fields=id,webViewLink&supportsAllDrives=true`, {
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
      const r = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`, {
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
      const d = await driveFetch(token, `${DRIVE}/files/${fileId}/copy?fields=id,name,webViewLink&supportsAllDrives=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      });
      return json({ ok: true, id: d.id, name: d.name, url: d.webViewLink || '' });
    }

    // ── Drive: delete a file/folder (folder deletion removes its contents) ───
    if (body.driveDelete) {
      const fileId = String(body.driveDelete.fileId || '').trim();
      if (!fileId) return json({ ok: false, error: 'Falta el archivo' }, 400);
      const r = await fetch(`${DRIVE}/files/${fileId}?supportsAllDrives=true`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      // 404 ⇒ already gone — treat as success (idempotent).
      if (!r.ok && r.status !== 404) {
        const d = await r.json().catch(() => ({}));
        return json({ ok: false, error: d?.error?.message || `Drive ${r.status}` }, 502);
      }
      return json({ ok: true });
    }

    // ── Drive: list shared drives (Team Drives) — explorer entry points ──────
    if (body.driveSharedDrives) {
      const d = await driveFetch(token, `${DRIVE}/drives?pageSize=100&fields=drives(id,name)`);
      return json({ ok: true, drives: d.drives || [] });
    }

    // ── Drive: list a folder ─────────────────────────────────────────────────
    if (body.driveList) {
      const folderId = String(body.driveList.folderId || '').trim();
      if (!folderId) return json({ ok: false, error: 'Falta la carpeta' }, 400);
      const q = `'${escapeQ(folderId)}' in parents and trashed=false`;
      const d = await driveFetch(
        token,
        `${DRIVE}/files?q=${encodeURIComponent(q)}&orderBy=folder,name&pageSize=200&fields=files(id,name,mimeType,iconLink,webViewLink,modifiedTime,size)&${ALL_DRIVES}`,
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
        `${DRIVE}/files?q=${encodeURIComponent(q)}&orderBy=modifiedTime desc&pageSize=${pageSize}&fields=files(id,name,mimeType,iconLink,webViewLink,modifiedTime,size)&corpora=allDrives&${ALL_DRIVES}`,
      );
      return json({ ok: true, files: d.files || [] });
    }

    // ── Drive: recent files (the picker) ─────────────────────────────────────
    if (body.driveRecent) {
      const pageSize = Math.min(Math.max(Number(body.driveRecent.pageSize) || 25, 1), 100);
      const d = await driveFetch(
        token,
        `${DRIVE}/files?q=${encodeURIComponent('trashed=false')}&orderBy=modifiedTime desc&pageSize=${pageSize}&fields=files(id,name,mimeType,iconLink,webViewLink,modifiedTime,size)&corpora=allDrives&${ALL_DRIVES}`,
      );
      return json({ ok: true, files: d.files || [] });
    }

    return json({ ok: false, error: 'Acción no reconocida' }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 200) }, 502);
  }
});
