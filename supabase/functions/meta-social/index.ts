// meta-social — Instagram (Instagram API with Instagram Login) into JARVIS.
//
// Instagram-ONLY. The team connects its Instagram professional account
// DIRECTLY via Instagram Business Login — no Facebook Page, no pages_*
// permissions. The long-lived IG user token + the Instagram app credentials
// stay server-side (write-only meta_social_config, service-role reads) and we
// talk to graph.instagram.com so the dashboard can show the IG side of the
// business (profile, reach, posts, comments) and publish.
//
// OAuth (Instagram Business Login):
//   GET  ?code&state            ← Instagram's redirect after consent. Public
//                                  (no JWT); exchanges code → long-lived token,
//                                  persists it, then 302s back to the app.
//
// POST body shapes (one per request; authenticated unless noted):
//   { saveApp:{appId,appSecret} } (admin) → store the Instagram app creds.
//   { authorize:{returnTo} }      (admin) → build the consent URL + CSRF state.
//   { test:true }                 → verify the stored token still answers.
//   { publish:{...} }             → IG image/Reel/Story/carousel (now). A still-
//                                   processing video returns { pending, creationId }.
//   { finishPublish:{creationId} }→ publish a pending IG video container.
//   { snapshot:true }             → profile counts, reach (28d), recent posts.
//   { igStudio:true }             → consolidated Studio read (profile,
//                                   demographics, media, stories, mentions).
//   { mediaInsights } { mediaComments } { replyComment }
//   { setCommentVisibility } { deleteComment }
//   { subscribeWebhooks:true }    (admin) → IG comment/mention webhook fields.
//
// The token is resolved live and auto-refreshed (IG long-lived tokens last 60
// days); it never reaches the browser.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const GRAPH_VERSION = 'v23.0';
const IG = 'https://graph.instagram.com';
const IG_API = `${IG}/${GRAPH_VERSION}`;
const IG_AUTHORIZE = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN = 'https://api.instagram.com/oauth/access_token';
const TEAM = 'team';

// The scopes we request at consent — Instagram Login, business surface.
const SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_comments',
  'instagram_business_manage_insights',
  'instagram_business_manage_messages',
].join(',');

type CarouselItem = { imageUrl?: string; videoUrl?: string };
type PublishBody = {
  message?: string;
  imageUrl?: string;
  /** A video URL → IG Reel (or video Story). */
  videoUrl?: string;
  /** Optional IG Reel cover image (else Meta picks a frame). */
  coverUrl?: string;
  /** IG Reel also shows in the feed grid (default true). */
  shareToFeed?: boolean;
  /** 2–10 media → an IG carousel (each item an image or a video URL). */
  carousel?: CarouselItem[];
  /** Accessibility caption for a single feed image (≤1000 chars). */
  altText?: string;
  /** Up to 3 IG usernames invited as collaborators (feed image / reel / carousel). */
  collaborators?: string[];
  /** Auto-post this as the first comment after publishing (e.g. hashtags). */
  firstComment?: string;
  /** Publish the IG side as a 24h Story (image or video, no caption). */
  igStory?: boolean;
};
type Body = {
  saveApp?: { appId?: string; appSecret?: string };
  authorize?: { returnTo?: string };
  test?: boolean;
  snapshot?: boolean;
  publish?: PublishBody;
  finishPublish?: { creationId?: string };
  replyComment?: { commentId?: string; message?: string };
  igStudio?: boolean;
  mediaInsights?: { mediaId?: string; productType?: string };
  mediaComments?: { mediaId?: string };
  setCommentVisibility?: { commentId?: string; hide?: boolean };
  deleteComment?: { commentId?: string };
  subscribeWebhooks?: boolean;
  // ── Instagram Direct (DM) inbox ──
  /** Send a Direct message to a contact (within Meta's 24h window). */
  igSendDm?: { recipientId?: string; text?: string };
  /** Pull recent Direct conversations into ig_messages (history backfill). */
  igBackfill?: boolean;
};

/** Translate Meta's token-death message into the action that fixes it. */
function friendly(msg: string): string {
  return /session has expired|expirad[oa]|access token.*(invalid|expired)|error validating access token|oauthexception/i.test(msg)
    ? 'La conexión con Instagram expiró — vuelve a conectar Instagram en Configuración y este panel se cura solo.'
    : msg;
}

/** GET an Instagram Graph endpoint; throws the API's own error on failure. */
async function igGet(path: string, token: string, params: Record<string, string> = {}) {
  const url = new URL(`${IG_API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    throw new Error(String(data?.error?.message || `Graph ${res.status}`).slice(0, 200));
  }
  return data;
}

/** POST an Instagram Graph endpoint (form-encoded); throws the API's error. */
async function igPost(path: string, token: string, params: Record<string, string>) {
  const res = await fetch(`${IG_API}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, access_token: token }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    throw new Error(String(data?.error?.message || `Graph ${res.status}`).slice(0, 200));
  }
  return data;
}

/** POST JSON to an IG Graph endpoint (the Direct messaging send takes a JSON
 *  body, not a form). */
async function igPostJson(path: string, token: string, payload: Record<string, unknown>) {
  const res = await fetch(`${IG_API}/${path}?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    throw new Error(String(data?.error?.message || `Graph ${res.status}`).slice(0, 200));
  }
  return data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type PublishResult = { ok: boolean; id?: string; error?: string; pending?: boolean; creationId?: string };

/**
 * Poll an IG media container to FINISHED. Image containers are ready on the
 * first check; VIDEO/REELS/CAROUSEL-with-video are processed async, so we wait
 * (bounded — ~36s, comfortably under the function budget). If it's still
 * IN_PROGRESS we return that and hand the creation id back so the caller can
 * finish a few seconds later via `finishPublish`.
 */
async function igWaitReady(creationId: string, token: string, tries = 9, delayMs = 4000): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const r = await igGet(creationId, token, { fields: 'status_code' });
    const s = String(r?.status_code || '');
    if (s === 'FINISHED' || s === '') return 'FINISHED';
    if (s === 'ERROR' || s === 'EXPIRED') return s;
    await sleep(delayMs);
  }
  return 'IN_PROGRESS';
}

/**
 * Publish to Instagram. Picks the media kind from the body: a ≥2-item carousel,
 * else a Reel (video, not story), else a Story (image/video), else the original
 * single-image feed post. Every path is the same 2-step container → publish
 * dance; video paths wait for processing first.
 */
async function publishInstagram(igId: string, token: string, pub: PublishBody): Promise<PublishResult> {
  const caption = String(pub.message || '').trim();
  const carousel = (pub.carousel || []).filter((it) => it && (it.videoUrl || it.imageUrl)).slice(0, 10);
  const altText = String(pub.altText || '').trim().slice(0, 1000);
  // collaborators ride on the PARENT/feed/reel container (max 3) — never on a
  // carousel child, which Meta rejects.
  const collaborators = (pub.collaborators || []).map((u) => String(u).replace(/^@/, '').trim()).filter(Boolean).slice(0, 3);
  const collabParam = collaborators.length ? { collaborators: JSON.stringify(collaborators) } : {};

  // CAROUSEL — each child its own container, then a parent that ties them.
  if (carousel.length >= 2) {
    const childIds: string[] = [];
    for (const it of carousel) {
      const params = it.videoUrl
        ? { media_type: 'VIDEO', video_url: String(it.videoUrl), is_carousel_item: 'true' }
        : { image_url: String(it.imageUrl), is_carousel_item: 'true' };
      const c = await igPost(`${igId}/media`, token, params);
      if (it.videoUrl) {
        const s = await igWaitReady(String(c?.id), token);
        if (s !== 'FINISHED') return { ok: false, error: `Un video del carrusel no terminó de procesar (${s})` };
      }
      childIds.push(String(c?.id || ''));
    }
    if (childIds.length < 2) return { ok: false, error: 'El carrusel necesita al menos 2 elementos válidos' };
    const parent = await igPost(`${igId}/media`, token, { media_type: 'CAROUSEL', caption, children: childIds.join(','), ...collabParam });
    const out = await igPost(`${igId}/media_publish`, token, { creation_id: String(parent?.id || '') });
    return { ok: true, id: out?.id };
  }

  // REEL — a video feed post (async processing).
  if (pub.videoUrl && !pub.igStory) {
    const params: Record<string, string> = { media_type: 'REELS', video_url: String(pub.videoUrl), caption, ...collabParam };
    if (pub.coverUrl) params.cover_url = String(pub.coverUrl);
    if (pub.shareToFeed === false) params.share_to_feed = 'false';
    const c = await igPost(`${igId}/media`, token, params);
    const s = await igWaitReady(String(c?.id), token);
    if (s === 'IN_PROGRESS') return { ok: false, pending: true, creationId: String(c?.id), error: 'El Reel sigue procesando — pulsa “Finalizar” en unos segundos.' };
    if (s !== 'FINISHED') return { ok: false, error: `El Reel no se pudo procesar (${s})` };
    const out = await igPost(`${igId}/media_publish`, token, { creation_id: String(c?.id || '') });
    return { ok: true, id: out?.id };
  }

  // STORY — image or video, 24h, no caption.
  if (pub.igStory) {
    const params = pub.videoUrl
      ? { media_type: 'STORIES', video_url: String(pub.videoUrl) }
      : pub.imageUrl ? { media_type: 'STORIES', image_url: String(pub.imageUrl) } : null;
    if (!params) return { ok: false, error: 'La Story requiere una imagen o un video' };
    const c = await igPost(`${igId}/media`, token, params);
    if (pub.videoUrl) {
      const s = await igWaitReady(String(c?.id), token);
      if (s === 'IN_PROGRESS') return { ok: false, pending: true, creationId: String(c?.id), error: 'La Story de video sigue procesando — pulsa “Finalizar”.' };
      if (s !== 'FINISHED') return { ok: false, error: `La Story no se pudo procesar (${s})` };
    }
    const out = await igPost(`${igId}/media_publish`, token, { creation_id: String(c?.id || '') });
    return { ok: true, id: out?.id };
  }

  // FEED IMAGE — the original path (alt text + collaborators here).
  if (!pub.imageUrl) return { ok: false, error: 'Instagram requiere una imagen o un video (URL pública)' };
  const params: Record<string, string> = { image_url: String(pub.imageUrl), caption, ...collabParam };
  if (altText) params.alt_text = altText;
  const c = await igPost(`${igId}/media`, token, params);
  const out = await igPost(`${igId}/media_publish`, token, { creation_id: String(c?.id || '') });
  return { ok: true, id: out?.id };
}

/**
 * Read a media's insights, resilient to Meta's metric churn: try the richest
 * metric set first, fall back to leaner ones (a single unsupported metric 400s
 * the whole call), and surface whatever answered as a flat {metric: value} map.
 */
async function mediaInsightValues(mediaId: string, token: string, metricSets: string[]): Promise<Record<string, number>> {
  let lastErr: unknown = null;
  for (const metric of metricSets) {
    try {
      const r = await igGet(`${mediaId}/insights`, token, { metric });
      const out: Record<string, number> = {};
      for (const row of (r?.data || [])) {
        const v = row?.values?.[0]?.value;
        if (typeof v === 'number') out[String(row.name)] = v;
      }
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Sin métricas');
}

type Admin = SupabaseClient;

/** The current IG user token, auto-refreshed when close to its 60-day expiry. */
async function resolveToken(admin: Admin, cfg: { ig_access_token?: string; ig_token_expires_at?: string }): Promise<string> {
  let token = cfg.ig_access_token || '';
  if (!token) return '';
  const exp = cfg.ig_token_expires_at ? Date.parse(cfg.ig_token_expires_at) : 0;
  // Refresh inside the last 7 days of the window (IG tokens must be >24h old to
  // refresh; a freshly minted one comfortably is by then).
  if (exp && exp - Date.now() < 7 * 86_400_000) {
    try {
      const r = await fetch(`${IG}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
      const d = await r.json().catch(() => ({}));
      if (r.ok && d?.access_token) {
        token = String(d.access_token);
        await admin.from('meta_social_config').update({
          ig_access_token: token,
          ig_token_expires_at: new Date(Date.now() + (Number(d.expires_in) || 5_184_000) * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('profile_id', TEAM);
      }
    } catch { /* keep the current token — a transient refresh blip isn't fatal */ }
  }
  return token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    return json({ error: 'Server misconfigured' }, 500);
  }
  // The OAuth redirect URI — must be registered verbatim in the Instagram app's
  // Business login settings. Derived from the project URL, never hardcoded.
  const redirectUri = `${SUPABASE_URL}/functions/v1/meta-social`;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── OAuth callback (Instagram → us). Public GET: no JWT, authenticated by
  // the one-shot `state` we stored when the admin started the flow. ──────────
  if (req.method === 'GET') {
    const u = new URL(req.url);
    const code = u.searchParams.get('code') || '';
    const state = u.searchParams.get('state') || '';
    const oauthErr = u.searchParams.get('error_description') || u.searchParams.get('error') || '';

    const { data: cfg } = await admin
      .from('meta_social_config')
      .select('ig_app_id, ig_app_secret, oauth_state, oauth_return_to')
      .eq('profile_id', TEAM)
      .maybeSingle();
    const returnTo = cfg?.oauth_return_to || SUPABASE_URL;
    const back = (q: string) => Response.redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}${q}`, 302);

    if (oauthErr) return back(`ig_error=${encodeURIComponent(oauthErr.slice(0, 160))}`);
    if (!code) return back('ig_error=missing_code');
    if (!cfg?.oauth_state || state !== cfg.oauth_state) return back('ig_error=state_mismatch');

    try {
      // 1) authorization code → short-lived token (+ the IG user id).
      const tr = await fetch(IG_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.ig_app_id,
          client_secret: cfg.ig_app_secret,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code,
        }),
      });
      const td = await tr.json().catch(() => ({}));
      if (!tr.ok) throw new Error(td?.error_message || td?.error?.message || `token ${tr.status}`);
      // Response is either flat { access_token, user_id } or { data:[{…}] }.
      const first = td?.data?.[0] || td;
      const short = String(first?.access_token || '');
      if (!short) throw new Error('Instagram no devolvió un token');

      // 2) short-lived → long-lived (60-day) token.
      const lr = await fetch(`${IG}/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(cfg.ig_app_secret)}&access_token=${encodeURIComponent(short)}`);
      const ld = await lr.json().catch(() => ({}));
      const longToken = String(ld?.access_token || short);
      const expiresIn = Number(ld?.expires_in) || 5_184_000;

      // 3) resolve the account id + username for subsequent calls.
      let userId = String(first?.user_id || '');
      let username = '';
      try {
        const me = await igGet('me', longToken, { fields: 'user_id,username' });
        userId = String(me?.user_id || userId);
        username = String(me?.username || '');
      } catch { /* keep the user_id from the token exchange */ }

      await admin.from('meta_social_config').update({
        ig_access_token: longToken,
        ig_token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        ig_user_id: userId,
        ig_username: username,
        access_token: '',
        oauth_state: '',
        updated_at: new Date().toISOString(),
      }).eq('profile_id', TEAM);
      await admin.from('settings').update({
        meta_social_connected_at: new Date().toISOString(),
        meta_social_ig_username: username,
      }).eq('profile_id', TEAM);

      return back('ig=connected');
    } catch (e) {
      return back(`ig_error=${encodeURIComponent(friendly(String((e as Error)?.message || e)).slice(0, 160))}`);
    }
  }

  // ── POST: verify the caller (gateway verify_jwt is off for the CORS
  // preflight). The scheduler worker calls us server-to-server with the
  // service-role key in x-internal-secret (no user JWT) — that bypass is for
  // the publish path only; admin actions still require an admin user. ────────
  const authHeader = req.headers.get('Authorization') || '';
  const internal = (req.headers.get('x-internal-secret') || '') === SERVICE_ROLE_KEY;
  let userId = '';
  if (!internal) {
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authorization header required' }, 401);
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await caller.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Invalid or expired session' }, 401);
    userId = userData.user.id;
  }
  const requireAdmin = async (): Promise<string | null> => {
    if (!userId) return 'Solo un administrador puede hacer esto.';
    const { data: prof } = await admin.from('profiles').select('role, active').eq('id', userId).maybeSingle();
    if (!prof || prof.role !== 'admin' || !prof.active) return 'Solo un administrador puede conectar Instagram.';
    return null;
  };

  let body: Body = {};
  try { body = await req.json(); } catch { /* empty body → handled below */ }

  // ── saveApp: persist the Instagram app credentials (admin) ─────────────
  if (body.saveApp) {
    const err = await requireAdmin();
    if (err) return json({ ok: false, error: err }, 403);
    const appId = String(body.saveApp.appId || '').trim();
    const appSecret = String(body.saveApp.appSecret || '').trim();
    if (!appId) return json({ ok: false, error: 'App ID requerido' }, 400);
    // Upsert (the row may not exist yet). Leave the secret untouched when the
    // field is left blank on a re-save, so re-entering the App ID never wipes it.
    const patch: Record<string, unknown> = { profile_id: TEAM, ig_app_id: appId, access_token: '', updated_at: new Date().toISOString() };
    if (appSecret) patch.ig_app_secret = appSecret;
    const { error: upErr } = await admin.from('meta_social_config').upsert(patch);
    if (upErr) return json({ ok: false, error: upErr.message });
    await admin.from('settings').update({ meta_social_ig_app_id: appId }).eq('profile_id', TEAM);
    return json({ ok: true, redirectUri });
  }

  // ── authorize: build the Instagram consent URL + a one-shot CSRF state (admin) ─
  if (body.authorize) {
    const err = await requireAdmin();
    if (err) return json({ ok: false, error: err }, 403);
    const { data: cfg } = await admin
      .from('meta_social_config')
      .select('ig_app_id, ig_app_secret')
      .eq('profile_id', TEAM)
      .maybeSingle();
    if (!cfg?.ig_app_id || !cfg?.ig_app_secret) {
      return json({ ok: false, error: 'Guarda primero el App ID y el App Secret de Instagram.' });
    }
    const state = crypto.randomUUID();
    await admin.from('meta_social_config').update({
      oauth_state: state,
      oauth_return_to: String(body.authorize.returnTo || '').trim(),
      updated_at: new Date().toISOString(),
    }).eq('profile_id', TEAM);
    const url = new URL(IG_AUTHORIZE);
    url.searchParams.set('client_id', cfg.ig_app_id);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('state', state);
    return json({ ok: true, url: url.toString(), redirectUri });
  }

  // Everything below needs a connected account + a live token.
  const { data: cfg } = await admin
    .from('meta_social_config')
    .select('ig_app_id, ig_access_token, ig_token_expires_at, ig_user_id, ig_username')
    .eq('profile_id', TEAM)
    .maybeSingle();
  if (!cfg) return json({ configured: false, error: 'Instagram sin conectar' });
  const token = await resolveToken(admin, cfg);
  if (!token) return json({ configured: false, error: 'Instagram sin conectar' });
  const igId = cfg.ig_user_id || '';

  if (body.test) {
    try {
      const me = await igGet('me', token, { fields: 'user_id,username' });
      const name = me?.username || cfg.ig_username;
      return json({ configured: true, ok: true, account: name, page: name ? `@${name}` : 'Instagram' });
    } catch (e) {
      return json({ configured: true, ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }

  if (!igId) return json({ configured: false, error: 'Sin cuenta de Instagram vinculada' });

  // ── replyComment: answer a comment in-thread (IG `replies` edge) ──────
  if (body.replyComment) {
    const commentId = String(body.replyComment.commentId || '').trim();
    const message = String(body.replyComment.message || '').trim();
    if (!commentId || !message) return json({ ok: false, error: 'commentId y message requeridos' }, 400);
    try {
      const r = await igPost(`${commentId}/replies`, token, { message });
      return json({ ok: true, id: r?.id });
    } catch (e) {
      return json({ ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }

  // ── publish: IG image/Reel/Story/carousel (immediate). Worker-compatible
  // shape: { ok, results:{ instagram } }. ───────────────────────────────────
  if (body.publish) {
    const pub = body.publish;
    const message = String(pub.message || '').trim();
    const imageUrl = String(pub.imageUrl || '').trim();
    const videoUrl = String(pub.videoUrl || '').trim();
    const carousel = (pub.carousel || []).filter((it) => it && (it.videoUrl || it.imageUrl));
    const hasMedia = !!(imageUrl || videoUrl || carousel.length);
    if (!message && !hasMedia) return json({ ok: false, error: 'Escribe un texto o adjunta una imagen/video' }, 400);

    const results: Record<string, PublishResult> = {};
    try {
      results.instagram = await publishInstagram(igId, token, { ...pub, message, imageUrl, videoUrl, carousel });
    } catch (e) {
      results.instagram = { ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) };
    }

    // First-comment automation (e.g. hashtags off the caption) — best-effort.
    const firstComment = String(pub.firstComment || '').trim();
    if (firstComment && results.instagram?.ok && results.instagram.id) {
      try { await igPost(`${results.instagram.id}/comments`, token, { message: firstComment }); } catch { /* ignore */ }
    }

    return json({ ok: !!results.instagram?.ok, results });
  }

  // ── finishPublish: publish a still-processing IG video container ──────
  if (body.finishPublish) {
    const creationId = String(body.finishPublish.creationId || '').trim();
    if (!creationId) return json({ ok: false, error: 'creationId requerido' }, 400);
    try {
      const s = await igWaitReady(creationId, token);
      if (s === 'IN_PROGRESS') return json({ ok: false, pending: true, creationId, error: 'Sigue procesando — intenta de nuevo en unos segundos.' });
      if (s !== 'FINISHED') return json({ ok: false, error: `No se pudo procesar (${s})` });
      const p = await igPost(`${igId}/media_publish`, token, { creation_id: creationId });
      return json({ ok: true, id: p?.id });
    } catch (e) {
      return json({ ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }

  if (body.snapshot) {
    const since = Math.floor((Date.now() - 28 * 86_400_000) / 1000);
    const since7 = Math.floor((Date.now() - 7 * 86_400_000) / 1000);
    const until = Math.floor(Date.now() / 1000);
    const errors: Record<string, string> = {};
    const safe = async <T>(key: string, fn: () => Promise<T>): Promise<T | null> => {
      try { return await fn(); } catch (e) {
        errors[key] = friendly(String((e as Error)?.message || e).slice(0, 160));
        return null;
      }
    };

    const [igProfile, igReach, igAudience, igProfileActions, igMedia] = await Promise.all([
      safe('ig', () => igGet(igId, token, { fields: 'username,followers_count,media_count' })),
      safe('igReach', () => igGet(`${igId}/insights`, token, {
        metric: 'reach', period: 'day', since: String(since), until: String(until),
      })),
      // Daily follower growth (time_series). Its own call: mixing metric
      // families 400s the whole insights request.
      safe('igAudience', () => igGet(`${igId}/insights`, token, {
        metric: 'follower_count', period: 'day', since: String(since), until: String(until),
      })),
      // Profile actions, 7d total (profile_links_taps — the modern total_value metric).
      safe('igProfileActions', () => igGet(`${igId}/insights`, token, {
        metric: 'profile_links_taps', metric_type: 'total_value',
        period: 'day', since: String(since7), until: String(until),
      })),
      safe('igMedia', () => igGet(`${igId}/media`, token, {
        // comments ride along nested — recent triage + the full-post peek's
        // comment list, without N+1 calls.
        fields: 'caption,like_count,comments_count,timestamp,media_type,media_url,thumbnail_url,permalink,comments.limit(10){id,text,username,timestamp}',
        limit: '6',
      })),
    ]);

    return json({
      ok: true,
      fetchedAt: Date.now(),
      igUsername: cfg.ig_username,
      hasIg: !!igId,
      hasAds: false,
      page: null,
      ig: igProfile,
      adAccount: null,
      igReach: igReach?.data || null,
      igAudience: igAudience?.data || null,
      igProfileActions: igProfileActions?.data || null,
      igMedia: igMedia?.data || null,
      pageInsights: null,
      adsDaily: null,
      adCampaigns: null,
      scheduled: null,
      businesses: null,
      errors,
    });
  }

  // ── igStudio: one consolidated read, sections fail independently ──────
  if (body.igStudio) {
    const since = Math.floor((Date.now() - 28 * 86_400_000) / 1000);
    const until = Math.floor(Date.now() / 1000);
    const errors: Record<string, string> = {};
    const safe = async <T>(key: string, fn: () => Promise<T>): Promise<T | null> => {
      try { return await fn(); } catch (e) {
        errors[key] = friendly(String((e as Error)?.message || e).slice(0, 160));
        return null;
      }
    };
    // Follower demographics — total_value+breakdown shape. One call per
    // dimension (mixing breakdowns is unreliable; ≥100 followers required).
    const demo = (breakdown: string) => safe(`demo_${breakdown}`, () => igGet(`${igId}/insights`, token, {
      metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value',
      timeframe: 'last_30_days', breakdown,
    }));

    const [profile, reach, accountTotals, profileTaps, reachByFollow, publishLimit, media, stories, mentions, gender, age, country, city] = await Promise.all([
      safe('profile', () => igGet(igId, token, {
        fields: 'username,name,biography,followers_count,follows_count,media_count,profile_picture_url',
      })),
      safe('reach', () => igGet(`${igId}/insights`, token, {
        metric: 'reach', period: 'day', since: String(since), until: String(until),
      })),
      safe('accountTotals', () => igGet(`${igId}/insights`, token, {
        metric: 'views,accounts_engaged,total_interactions', metric_type: 'total_value',
        period: 'day', since: String(since), until: String(until),
      })),
      safe('profileTaps', () => igGet(`${igId}/insights`, token, {
        metric: 'profile_links_taps', metric_type: 'total_value', period: 'day',
        since: String(since), until: String(until),
      })),
      safe('reachByFollow', () => igGet(`${igId}/insights`, token, {
        metric: 'reach', metric_type: 'total_value', period: 'day',
        breakdown: 'follow_type', since: String(since), until: String(until),
      })),
      safe('publishLimit', () => igGet(`${igId}/content_publishing_limit`, token, { fields: 'config,quota_usage' })),
      safe('media', () => igGet(`${igId}/media`, token, {
        fields: 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
        limit: '24',
      })),
      safe('stories', () => igGet(`${igId}/stories`, token, {
        fields: 'id,media_type,media_url,thumbnail_url,permalink,timestamp', limit: '20',
      })),
      safe('mentions', () => igGet(`${igId}/tags`, token, {
        fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,username,timestamp,like_count,comments_count',
        limit: '12',
      })),
      demo('gender'), demo('age'), demo('country'), demo('city'),
    ]);

    return json({
      ok: true,
      fetchedAt: Date.now(),
      igUsername: cfg.ig_username,
      profile,
      reach: reach?.data || null,
      accountTotals: accountTotals?.data || null,
      profileTaps: profileTaps?.data || null,
      reachByFollow: reachByFollow?.data || null,
      publishLimit: publishLimit?.data || null,
      media: media?.data || null,
      stories: stories?.data || null,
      mentions: mentions?.data || null,
      demographics: {
        gender: gender?.data || null,
        age: age?.data || null,
        country: country?.data || null,
        city: city?.data || null,
      },
      errors,
    });
  }

  // ── mediaInsights: per-post drill-down ───────────────────────────────
  if (body.mediaInsights) {
    const mediaId = String(body.mediaInsights.mediaId || '').trim();
    if (!mediaId) return json({ ok: false, error: 'mediaId requerido' }, 400);
    const isReel = String(body.mediaInsights.productType || '').toUpperCase() === 'REELS';
    const sets = isReel
      ? ['reach,views,total_interactions,saved,shares,ig_reels_avg_watch_time', 'reach,views,total_interactions,saved,shares', 'reach,total_interactions']
      : ['reach,views,total_interactions,saved,shares,profile_visits,follows', 'reach,views,total_interactions,saved,shares', 'reach,total_interactions'];
    try {
      const metrics = await mediaInsightValues(mediaId, token, sets);
      return json({ ok: true, metrics });
    } catch (e) {
      return json({ ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }

  // ── mediaComments: a single post's comment thread (moderation) ───────
  if (body.mediaComments) {
    const mediaId = String(body.mediaComments.mediaId || '').trim();
    if (!mediaId) return json({ ok: false, error: 'mediaId requerido' }, 400);
    try {
      const r = await igGet(`${mediaId}/comments`, token, {
        fields: 'id,text,username,timestamp,like_count,hidden,replies{id,text,username,timestamp,like_count}',
        limit: '40',
      });
      return json({ ok: true, comments: r?.data || [] });
    } catch (e) {
      return json({ ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }

  // ── setCommentVisibility / deleteComment: moderation actions ─────────
  if (body.setCommentVisibility) {
    const commentId = String(body.setCommentVisibility.commentId || '').trim();
    if (!commentId) return json({ ok: false, error: 'commentId requerido' }, 400);
    try {
      await igPost(commentId, token, { hide: body.setCommentVisibility.hide ? 'true' : 'false' });
      return json({ ok: true, hidden: !!body.setCommentVisibility.hide });
    } catch (e) {
      return json({ ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }
  if (body.deleteComment) {
    const commentId = String(body.deleteComment.commentId || '').trim();
    if (!commentId) return json({ ok: false, error: 'commentId requerido' }, 400);
    try {
      const res = await fetch(`${IG_API}/${commentId}?access_token=${encodeURIComponent(token)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) throw new Error(String(data?.error?.message || `Graph ${res.status}`).slice(0, 200));
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }

  // ── subscribeWebhooks: turn on real-time comment/mention delivery (admin) ─
  if (body.subscribeWebhooks) {
    const err = await requireAdmin();
    if (err) return json({ ok: false, error: err }, 403);
    try {
      const fields = 'comments,mentions,messages';
      const r = await igPost(`${igId}/subscribed_apps`, token, { subscribed_fields: fields });
      return json({ ok: !!r?.success, fields });
    } catch (e) {
      return json({ ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Instagram Direct (DM) inbox.
  // ════════════════════════════════════════════════════════════════════

  // ── igSendDm: reply to a contact within Meta's 24h window. Stores the
  // outbound row in ig_messages so the inbox shows it immediately. ─────────
  if (body.igSendDm) {
    const recipientId = String(body.igSendDm.recipientId || '').trim();
    const text = String(body.igSendDm.text || '').trim();
    if (!recipientId || !text) return json({ ok: false, error: 'recipientId y text requeridos' }, 400);
    try {
      const r = await igPostJson('me/messages', token, { recipient: { id: recipientId }, message: { text } });
      const messageId = String(r?.message_id || '');
      await admin.from('ig_messages').insert({
        id: crypto.randomUUID(), profile_id: TEAM, direction: 'out',
        ig_message_id: messageId || null, thread_key: recipientId,
        sender_id: igId, recipient_id: recipientId,
        kind: 'text', body: text, status: 'sent',
        created_at: new Date().toISOString(),
      });
      return json({ ok: true, id: messageId });
    } catch (e) {
      return json({ ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }

  // ── igBackfill: pull recent Direct conversations into ig_messages, so the
  // inbox has history before/independent of live webhooks. Dedupes on the
  // message id (the partial unique index the webhook also relies on). ──────
  if (body.igBackfill) {
    try {
      const convos = await igGet('me/conversations', token, {
        platform: 'instagram',
        fields: 'participants,updated_time,messages.limit(25){id,created_time,from,to,message}',
        limit: '20',
      });
      const rows: Array<Record<string, unknown>> = [];
      for (const c of (convos?.data || [])) {
        const parts = (c?.participants?.data || []) as Array<{ id?: string; username?: string }>;
        const other = parts.find((p) => String(p?.id) !== String(igId)) || parts[0] || {};
        const threadKey = String(other?.id || '');
        if (!threadKey) continue;
        for (const m of (c?.messages?.data || [])) {
          const fromId = String(m?.from?.id || '');
          const outbound = fromId === String(igId);
          rows.push({
            id: crypto.randomUUID(), profile_id: TEAM,
            direction: outbound ? 'out' : 'in',
            ig_message_id: m?.id ? String(m.id) : null,
            thread_key: threadKey,
            sender_id: fromId || null,
            recipient_id: outbound ? threadKey : igId,
            username: other?.username ? String(other.username) : null,
            kind: 'text', body: m?.message ? String(m.message) : '',
            status: outbound ? 'sent' : 'received',
            read_at: new Date().toISOString(), // history is read; never blows up unread badges
            payload: m,
            created_at: m?.created_time ? new Date(m.created_time).toISOString() : new Date().toISOString(),
          });
        }
      }
      if (rows.length) await admin.from('ig_messages').upsert(rows, { onConflict: 'ig_message_id', ignoreDuplicates: true });
      return json({ ok: true, count: rows.length });
    } catch (e) {
      return json({ ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }

  return json({ error: 'Petición no reconocida' }, 400);
});
