// meta-social — Instagram + Facebook + Ads into JARVIS.
//
// Called by a signed-in team member from the JARVIS dashboard. It keeps the
// Meta token server-side (write-only meta_social_config table, service-role
// reads — same pattern as wa-send / shopify-sync) and talks to the Graph +
// Marketing APIs so the dashboard can show the social side of the business:
// follower counts, reach, ad spend/results and the publishing schedule.
//
// Body shapes (one per request):
//   { link: { token } }  → validate the pasted long-lived token, DISCOVER the
//                          Page (+ page token), its IG business account and
//                          the ad account, persist everything, stamp settings.
//   { test: true }       → verify the stored credentials still answer.
//   { publish: {...} }   → post to the FB Page (text/link/photo now or
//                          scheduled 10min–30d, or a Reel) and/or IG (image,
//                          Reel, Story or carousel; no scheduling) — one result
//                          per target, partial success allowed. A still-
//                          processing IG video comes back { pending, creationId }.
//   { finishPublish }    → publish a pending IG video container once it's done.
//   { snapshot: true }   → one consolidated read: profile counts, IG daily
//                          reach (28d), recent IG posts, daily ad results
//                          (28d) + per-campaign rollup, scheduled posts.
//                          Sections fail INDEPENDENTLY — a partial snapshot
//                          with per-section errors beats an all-or-nothing
//                          500 (the dashboard shows what's real and flags
//                          what didn't answer).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const GRAPH_VERSION = 'v23.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TEAM = 'team';

type LinkBody = { token?: string; pageId?: string; adAccountId?: string };
type CarouselItem = { imageUrl?: string; videoUrl?: string };
type PublishBody = {
  message?: string;
  link?: string;
  imageUrl?: string;
  /** A video URL → IG Reel (or video Story) and/or a Facebook Page Reel. */
  videoUrl?: string;
  /** Optional IG Reel cover image (else Meta picks a frame). */
  coverUrl?: string;
  /** IG Reel also shows in the feed grid (default true). */
  shareToFeed?: boolean;
  /** 2–10 media → an IG carousel (each item an image or a video URL). */
  carousel?: CarouselItem[];
  /** Accessibility caption for a single feed image / story image (≤1000 chars). */
  altText?: string;
  /** Up to 3 IG usernames invited as collaborators (feed image / reel / carousel). */
  collaborators?: string[];
  /** Auto-post this as the first comment after publishing (e.g. hashtags). */
  firstComment?: string;
  /** JS-ms timestamp; FB feed/photo only (10 min – 30 days out). Absent = now. */
  scheduleAt?: number;
  /** Publish the IG side as a 24h Story (image or video, no caption) instead of a feed post. */
  igStory?: boolean;
  targets?: Array<'facebook' | 'instagram'>;
};
type Body = {
  link?: LinkBody;
  test?: boolean;
  snapshot?: boolean;
  publish?: PublishBody;
  /** Resume publishing a still-processing IG video container (Reel/Story). */
  finishPublish?: { creationId?: string };
  /** Reply to a comment from the triage list (IG replies edge vs FB comments edge). */
  replyComment?: { commentId?: string; message?: string; platform?: 'instagram' | 'facebook' };
  /** Pause/resume an ad campaign (Marketing page, behind an explicit confirm). */
  setCampaignStatus?: { campaignId?: string; status?: string };
  /** Instagram Studio: one consolidated read (profile, demographics, media, stories, mentions). */
  igStudio?: boolean;
  /** Per-post insight drill-down (on click). */
  mediaInsights?: { mediaId?: string; productType?: string };
  /** Comments on a single post (the per-post moderation thread). */
  mediaComments?: { mediaId?: string };
  /** Hide/unhide an IG comment. */
  setCommentVisibility?: { commentId?: string; hide?: boolean };
  /** Delete an IG comment. */
  deleteComment?: { commentId?: string };
  /** Hashtag listening — discover top media for a tag. */
  hashtagSearch?: { q?: string };
};

/** Translate Meta's token-death message into the action that fixes it. */
function friendly(msg: string): string {
  return /session has expired|expirad[oa]|access token.*(invalid|expired)|error validating access token/i.test(msg)
    ? 'El token de Meta expiró — reconecta WhatsApp en Configuración (mismo usuario del sistema) y este panel se cura solo con el token nuevo.'
    : msg;
}

/** GET a Graph endpoint; throws the API's own error message on failure. */
async function graph(path: string, token: string, params: Record<string, string> = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    throw new Error(String(data?.error?.message || `Graph ${res.status}`).slice(0, 200));
  }
  return data;
}

/** POST a Graph endpoint (form-encoded); throws the API's error message. */
async function graphPost(path: string, token: string, params: Record<string, string>) {
  const res = await fetch(`${GRAPH}/${path}`, {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type PublishResult = { ok: boolean; id?: string; error?: string; pending?: boolean; creationId?: string };

/**
 * Poll an IG media container to FINISHED. Image containers are ready on the
 * first check; VIDEO/REELS/CAROUSEL-with-video are processed async, so we wait
 * (bounded — ~36s, comfortably under the function budget). If it's still
 * IN_PROGRESS we return that and hand the creation id back: the View finishes
 * the publish a few seconds later via `finishPublish`, rather than us blocking
 * a request for minutes.
 */
async function igWaitReady(creationId: string, token: string, tries = 9, delayMs = 4000): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const r = await graph(creationId, token, { fields: 'status_code' });
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
      const c = await graphPost(`${igId}/media`, token, params);
      if (it.videoUrl) {
        const s = await igWaitReady(String(c?.id), token);
        if (s !== 'FINISHED') return { ok: false, error: `Un video del carrusel no terminó de procesar (${s})` };
      }
      childIds.push(String(c?.id || ''));
    }
    if (childIds.length < 2) return { ok: false, error: 'El carrusel necesita al menos 2 elementos válidos' };
    const parent = await graphPost(`${igId}/media`, token, { media_type: 'CAROUSEL', caption, children: childIds.join(','), ...collabParam });
    const out = await graphPost(`${igId}/media_publish`, token, { creation_id: String(parent?.id || '') });
    return { ok: true, id: out?.id };
  }

  // REEL — a video feed post (async processing).
  if (pub.videoUrl && !pub.igStory) {
    const params: Record<string, string> = { media_type: 'REELS', video_url: String(pub.videoUrl), caption, ...collabParam };
    if (pub.coverUrl) params.cover_url = String(pub.coverUrl);
    if (pub.shareToFeed === false) params.share_to_feed = 'false';
    const c = await graphPost(`${igId}/media`, token, params);
    const s = await igWaitReady(String(c?.id), token);
    if (s === 'IN_PROGRESS') return { ok: false, pending: true, creationId: String(c?.id), error: 'El Reel sigue procesando — pulsa “Finalizar” en unos segundos.' };
    if (s !== 'FINISHED') return { ok: false, error: `El Reel no se pudo procesar (${s})` };
    const out = await graphPost(`${igId}/media_publish`, token, { creation_id: String(c?.id || '') });
    return { ok: true, id: out?.id };
  }

  // STORY — image or video, 24h, no caption.
  if (pub.igStory) {
    const params = pub.videoUrl
      ? { media_type: 'STORIES', video_url: String(pub.videoUrl) }
      : pub.imageUrl ? { media_type: 'STORIES', image_url: String(pub.imageUrl) } : null;
    if (!params) return { ok: false, error: 'La Story requiere una imagen o un video' };
    const c = await graphPost(`${igId}/media`, token, params);
    if (pub.videoUrl) {
      const s = await igWaitReady(String(c?.id), token);
      if (s === 'IN_PROGRESS') return { ok: false, pending: true, creationId: String(c?.id), error: 'La Story de video sigue procesando — pulsa “Finalizar”.' };
      if (s !== 'FINISHED') return { ok: false, error: `La Story no se pudo procesar (${s})` };
    }
    const out = await graphPost(`${igId}/media_publish`, token, { creation_id: String(c?.id || '') });
    return { ok: true, id: out?.id };
  }

  // FEED IMAGE — the original path (alt text + collaborators supported here).
  if (!pub.imageUrl) return { ok: false, error: 'Instagram requiere una imagen o un video (URL pública)' };
  const params: Record<string, string> = { image_url: String(pub.imageUrl), caption, ...collabParam };
  if (altText) params.alt_text = altText;
  const c = await graphPost(`${igId}/media`, token, params);
  const out = await graphPost(`${igId}/media_publish`, token, { creation_id: String(c?.id || '') });
  return { ok: true, id: out?.id };
}

/**
 * Publish a Facebook Page Reel from a hosted video URL — the 3-phase
 * video_reels flow (start → hosted-file upload via rupload → finish). No bytes
 * stream through us: rupload pulls the public URL we pass in the `file_url`
 * header, the same "Meta fetches your URL" model as IG.
 */
async function publishFacebookReel(pageId: string, token: string, videoUrl: string, description: string): Promise<{ id: string }> {
  const start = await graphPost(`${pageId}/video_reels`, token, { upload_phase: 'start' });
  const videoId = String(start?.video_id || '');
  if (!videoId) throw new Error('No se pudo iniciar la subida del Reel');
  const up = await fetch(`https://rupload.facebook.com/video-upload/${GRAPH_VERSION}/${videoId}`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${token}`, file_url: videoUrl },
  });
  const upData = await up.json().catch(() => ({}));
  if (!up.ok || upData?.error) throw new Error(String(upData?.error?.message || `rupload ${up.status}`).slice(0, 200));
  await graphPost(`${pageId}/video_reels`, token, {
    upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description,
  });
  return { id: videoId };
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
      const r = await graph(`${mediaId}/insights`, token, { metric });
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    return json({ error: 'Server misconfigured' }, 500);
  }

  // Verify the caller ourselves (gateway verify_jwt is off for the CORS
  // preflight) — same as wa-send / claude-chat.
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authorization header required' }, 401);
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'Invalid or expired session' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: Body = {};
  try { body = await req.json(); } catch { /* empty body → handled below */ }

  // ── link: validate + discover + persist ──────────────────────────────
  // With no token in the body, reuse the WhatsApp integration's system-user
  // token (write-only whatsapp_config) — one Meta system user runs both;
  // the Page/IG/ad account just have to be assigned to it in Meta Business.
  if (body.link) {
    // Linking PERSISTS the Meta credentials (meta_social_config) — an
    // admin-only action, like the save_* credential RPCs. The read / publish
    // modes below stay open to the whole team; only connecting is gated. The
    // caller is already authenticated above; here we also require admin.
    const { data: prof } = await caller
      .from('profiles')
      .select('role, active')
      .eq('id', userData.user.id)
      .maybeSingle();
    if (!prof || prof.role !== 'admin' || !prof.active) {
      return json({ ok: false, error: 'Solo un administrador puede conectar Meta.' }, 403);
    }
    let token = String(body.link.token || '').trim();
    let fromWhatsApp = false;
    if (!token) {
      const { data: wa } = await admin
        .from('whatsapp_config')
        .select('access_token')
        .eq('profile_id', TEAM)
        .maybeSingle();
      token = wa?.access_token || '';
      fromWhatsApp = true;
      if (!token) {
        return json({ ok: false, error: 'Sin token disponible: conecta WhatsApp primero (mismo usuario del sistema) o pega un token de Meta Business.' });
      }
    }
    try {
      // Pages the token can see, each with its page token + linked IG account.
      const pages = await graph('me/accounts', token, {
        fields: 'id,name,access_token,instagram_business_account{id,username}',
        limit: '25',
      });
      const list: Array<{
        id: string; name?: string; access_token?: string;
        instagram_business_account?: { id?: string; username?: string };
      }> = pages?.data || [];
      if (!list.length) {
        return json({
          ok: false,
          error: fromWhatsApp
            ? 'El usuario del sistema de WhatsApp no administra ninguna página — en Meta Business, asígnale la página de Facebook (y la cuenta publicitaria) a ese usuario del sistema, o pega otro token.'
            : 'El token no administra ninguna página de Facebook — usa un token de usuario del sistema con permisos de páginas.',
        });
      }
      const page = (body.link.pageId && list.find((p) => p.id === body.link?.pageId)) || list[0];

      // Ad accounts the token can read (optional — analytics work without ads).
      let adAccountId = String(body.link.adAccountId || '');
      if (!adAccountId) {
        try {
          const ads = await graph('me/adaccounts', token, { fields: 'id,name,account_status', limit: '25' });
          const active = (ads?.data || []).find((a: { account_status?: number }) => a.account_status === 1) || (ads?.data || [])[0];
          adAccountId = active?.id || '';
        } catch { adAccountId = ''; }
      }

      const ig = page.instagram_business_account || {};
      // A WhatsApp-sourced link stores EMPTY token sentinels: every later
      // call re-reads the CURRENT whatsapp_config token (and re-derives the
      // page token), so a WhatsApp re-connect heals this panel by itself.
      // Only a manually pasted token is persisted here.
      await admin.from('meta_social_config').upsert({
        profile_id: TEAM,
        access_token: fromWhatsApp ? '' : token,
        page_id: page.id,
        page_name: page.name || '',
        page_token: fromWhatsApp ? '' : (page.access_token || ''),
        ig_user_id: ig.id || '',
        ig_username: ig.username || '',
        ad_account_id: adAccountId,
        updated_at: new Date().toISOString(),
      });
      await admin.from('settings').update({
        meta_social_connected_at: new Date().toISOString(),
        meta_social_page_name: page.name || '',
        meta_social_ig_username: ig.username || '',
      }).eq('profile_id', TEAM);

      return json({
        ok: true,
        page: { id: page.id, name: page.name || '' },
        ig: ig.id ? { id: ig.id, username: ig.username || '' } : null,
        adAccountId: adAccountId || null,
      });
    } catch (e) {
      return json({ ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }

  // Everything below needs stored credentials. Tokens resolve LIVE: a row
  // linked from WhatsApp stores empty sentinels and always uses the current
  // whatsapp_config token + a freshly derived page token, so it never goes
  // stale on its own.
  const { data: cfg } = await admin
    .from('meta_social_config')
    .select('access_token, page_id, page_name, page_token, ig_user_id, ig_username, ad_account_id')
    .eq('profile_id', TEAM)
    .maybeSingle();
  if (!cfg) return json({ configured: false, error: 'Sin token de Meta' });
  let userToken = cfg.access_token || '';
  if (!userToken) {
    const { data: wa } = await admin
      .from('whatsapp_config')
      .select('access_token')
      .eq('profile_id', TEAM)
      .maybeSingle();
    userToken = wa?.access_token || '';
  }
  if (!userToken) return json({ configured: false, error: 'Sin token de Meta' });
  let pageToken = cfg.page_token || '';
  if (!pageToken && cfg.page_id) {
    try {
      const p = await graph(cfg.page_id, userToken, { fields: 'access_token' });
      pageToken = p?.access_token || '';
    } catch { /* fall through to the user token */ }
  }
  pageToken = pageToken || userToken;

  if (body.test) {
    try {
      const p = await graph(cfg.page_id, pageToken, { fields: 'name' });
      return json({ configured: true, ok: true, page: p?.name || cfg.page_name });
    } catch (e) {
      return json({ configured: true, ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }

  // ── setCampaignStatus: pause/resume a campaign — REAL MONEY moves, so
  // the UI gates this behind an explicit confirm; the server only accepts
  // the two reversible states.
  if (body.setCampaignStatus) {
    const campaignId = String(body.setCampaignStatus.campaignId || '').trim();
    const status = String(body.setCampaignStatus.status || '').toUpperCase();
    if (!campaignId || !['ACTIVE', 'PAUSED'].includes(status)) {
      return json({ ok: false, error: 'campaignId y status (ACTIVE|PAUSED) requeridos' }, 400);
    }
    try {
      await graphPost(campaignId, userToken, { status });
      return json({ ok: true, status });
    } catch (e) {
      return json({ ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }

  // ── replyComment: answer a comment in-thread. IG nests replies under the
  // comment's `replies` edge; Facebook nests them under `comments`.
  if (body.replyComment) {
    const commentId = String(body.replyComment.commentId || '').trim();
    const message = String(body.replyComment.message || '').trim();
    if (!commentId || !message) return json({ ok: false, error: 'commentId y message requeridos' }, 400);
    const edge = body.replyComment.platform === 'facebook' ? 'comments' : 'replies';
    try {
      const r = await graphPost(`${commentId}/${edge}`, pageToken, { message });
      return json({ ok: true, id: r?.id });
    } catch (e) {
      return json({ ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }

  // ── publish: FB Page (text/link/photo/Reel, now or scheduled) + IG
  // (image/Reel/Story/carousel). Per-target results: one network failing
  // doesn't waste the other's post.
  if (body.publish) {
    const pub = body.publish;
    const message = String(pub.message || '').trim();
    const targets = pub.targets?.length ? pub.targets : ['facebook' as const];
    const link = String(pub.link || '').trim();
    const imageUrl = String(pub.imageUrl || '').trim();
    const videoUrl = String(pub.videoUrl || '').trim();
    const carousel = (pub.carousel || []).filter((it) => it && (it.videoUrl || it.imageUrl));
    const scheduleAt = Number(pub.scheduleAt) || 0;

    // A media-only publish (Reel/Story/photo/carousel) needs no caption; a
    // text post still does.
    const hasMedia = !!(imageUrl || videoUrl || carousel.length);
    if (!message && !hasMedia) return json({ ok: false, error: 'Escribe un texto o adjunta una imagen/video' }, 400);

    if (scheduleAt) {
      const min = Date.now() + 10 * 60_000;
      const max = Date.now() + 30 * 86_400_000;
      if (scheduleAt < min || scheduleAt > max) {
        return json({ ok: false, error: 'La programación debe quedar entre 10 minutos y 30 días desde ahora.' });
      }
    }

    const results: Record<string, PublishResult> = {};

    if (targets.includes('facebook')) {
      try {
        if (videoUrl) {
          // FB Reel — no API scheduling for Reels, publishes now.
          const r = await publishFacebookReel(cfg.page_id, pageToken, videoUrl, message);
          results.facebook = { ok: true, id: r.id };
        } else if (imageUrl) {
          // Photo post (schedulable like a feed post).
          const params: Record<string, string> = { url: imageUrl, caption: message };
          if (scheduleAt) {
            params.published = 'false';
            params.scheduled_publish_time = String(Math.floor(scheduleAt / 1000));
          }
          const r = await graphPost(`${cfg.page_id}/photos`, pageToken, params);
          results.facebook = { ok: true, id: r?.post_id || r?.id };
        } else {
          const params: Record<string, string> = { message };
          if (link) params.link = link;
          if (scheduleAt) {
            params.published = 'false';
            params.scheduled_publish_time = String(Math.floor(scheduleAt / 1000));
          }
          const r = await graphPost(`${cfg.page_id}/feed`, pageToken, params);
          results.facebook = { ok: true, id: r?.id };
        }
      } catch (e) {
        results.facebook = { ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) };
      }
    }

    if (targets.includes('instagram')) {
      if (!cfg.ig_user_id) {
        results.instagram = { ok: false, error: 'Sin cuenta de Instagram vinculada' };
      } else if (scheduleAt) {
        // IG Content Publishing has no native scheduling.
        results.instagram = { ok: false, error: 'Instagram no admite programación por API — publícalo al momento' };
      } else {
        try {
          results.instagram = await publishInstagram(cfg.ig_user_id, pageToken, { ...pub, message, imageUrl, videoUrl, carousel });
        } catch (e) {
          results.instagram = { ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) };
        }
      }
    }

    // First-comment automation (e.g. hashtags off the caption) — best-effort;
    // a failure here never undoes the publish.
    const firstComment = String(pub.firstComment || '').trim();
    if (firstComment && results.instagram?.ok && results.instagram.id) {
      try { await graphPost(`${results.instagram.id}/comments`, pageToken, { message: firstComment }); } catch { /* ignore */ }
    }

    const anyOk = Object.values(results).some((r) => r.ok);
    return json({ ok: anyOk, results });
  }

  // ── finishPublish: publish an IG video container that was still processing
  // when `publish` returned (the View polls this for Reels/video Stories).
  if (body.finishPublish) {
    if (!cfg.ig_user_id) return json({ ok: false, error: 'Sin cuenta de Instagram vinculada' });
    const creationId = String(body.finishPublish.creationId || '').trim();
    if (!creationId) return json({ ok: false, error: 'creationId requerido' }, 400);
    try {
      const s = await igWaitReady(creationId, pageToken);
      if (s === 'IN_PROGRESS') return json({ ok: false, pending: true, creationId, error: 'Sigue procesando — intenta de nuevo en unos segundos.' });
      if (s !== 'FINISHED') return json({ ok: false, error: `No se pudo procesar (${s})` });
      const p = await graphPost(`${cfg.ig_user_id}/media_publish`, pageToken, { creation_id: creationId });
      return json({ ok: true, id: p?.id });
    } catch (e) {
      return json({ ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }

  if (body.snapshot) {
    const since = Math.floor((Date.now() - 28 * 86_400_000) / 1000);
    const until = Math.floor(Date.now() / 1000);
    const errors: Record<string, string> = {};
    const safe = async <T>(key: string, fn: () => Promise<T>): Promise<T | null> => {
      try { return await fn(); } catch (e) {
        errors[key] = friendly(String((e as Error)?.message || e).slice(0, 160));
        return null;
      }
    };

    const [profile, igProfile, igReach, igAudience, igMedia, pageInsights, adAccount, adsDaily, adCampaigns, scheduled] = await Promise.all([
      safe('page', () => graph(cfg.page_id, pageToken, { fields: 'name,fan_count,followers_count,link' })),
      cfg.ig_user_id
        ? safe('ig', () => graph(cfg.ig_user_id, pageToken, { fields: 'username,followers_count,media_count' }))
        : Promise.resolve(null),
      cfg.ig_user_id
        ? safe('igReach', () => graph(`${cfg.ig_user_id}/insights`, pageToken, {
          metric: 'reach', period: 'day', since: String(since), until: String(until),
        }))
        : Promise.resolve(null),
      // Daily audience metrics — follower growth + profile views. Separate
      // call: mixing metric families 400s the whole insights request.
      cfg.ig_user_id
        ? safe('igAudience', () => graph(`${cfg.ig_user_id}/insights`, pageToken, {
          metric: 'follower_count,profile_views',
          period: 'day', since: String(since), until: String(until),
        }))
        : Promise.resolve(null),
      cfg.ig_user_id
        ? safe('igMedia', () => graph(`${cfg.ig_user_id}/media`, pageToken, {
          // comments ride along nested — recent triage without N+1 calls
          fields: 'caption,like_count,comments_count,timestamp,media_type,permalink,comments.limit(3){id,text,username,timestamp}',
          limit: '6',
        }))
        : Promise.resolve(null),
      // Facebook Page daily engagement + unique reach (deprecation-prone
      // metric family — fails independently; the panel just omits it).
      safe('pageInsights', () => graph(`${cfg.page_id}/insights`, pageToken, {
        metric: 'page_post_engagements,page_impressions_unique',
        period: 'day', since: String(since), until: String(until),
      })),
      cfg.ad_account_id
        ? safe('adAccount', () => graph(cfg.ad_account_id, userToken, { fields: 'name,currency' }))
        : Promise.resolve(null),
      cfg.ad_account_id
        ? safe('ads', () => graph(`${cfg.ad_account_id}/insights`, userToken, {
          date_preset: 'last_28d', time_increment: '1', level: 'account',
          fields: 'spend,impressions,clicks,reach,actions,date_start',
          limit: '40',
        }))
        : Promise.resolve(null),
      // Campaigns via the campaigns edge (not insights): carries the id +
      // live status the pause/resume control needs, with 28d insights nested.
      cfg.ad_account_id
        ? safe('campaigns', () => graph(`${cfg.ad_account_id}/campaigns`, userToken, {
          fields: 'id,name,status,effective_status,insights.date_preset(last_28d){spend,impressions,clicks,actions}',
          limit: '15',
        }))
        : Promise.resolve(null),
      safe('scheduled', () => graph(`${cfg.page_id}/scheduled_posts`, pageToken, {
        fields: 'message,scheduled_publish_time', limit: '10',
      })),
    ]);

    // Product catalogs owned by the business — visibility, not sync (Shopify's
    // own Meta channel feeds them; we read counts so JARVIS can flag drift).
    const catalogs = await safe('catalogs', () => graph('me/businesses', userToken, {
      fields: 'name,owned_product_catalogs{name,product_count,vertical}',
      limit: '5',
    }));

    return json({
      ok: true,
      fetchedAt: Date.now(),
      pageName: cfg.page_name,
      igUsername: cfg.ig_username,
      hasIg: !!cfg.ig_user_id,
      hasAds: !!cfg.ad_account_id,
      page: profile,
      ig: igProfile,
      adAccount,
      igReach: igReach?.data || null,
      igAudience: igAudience?.data || null,
      igMedia: igMedia?.data || null,
      pageInsights: pageInsights?.data || null,
      adsDaily: adsDaily?.data || null,
      adCampaigns: adCampaigns?.data || null,
      scheduled: scheduled?.data || null,
      businesses: catalogs?.data || null,
      errors,
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // Instagram Studio — the advanced IG surface (separate from the Marketing
  // snapshot). All reads use the page token; every IG endpoint here is backed
  // by scopes already granted (instagram_basic / _manage_insights /
  // _manage_comments / _content_publish).
  // ════════════════════════════════════════════════════════════════════
  const igId = cfg.ig_user_id || '';
  const needIg = body.igStudio || body.mediaInsights || body.mediaComments || body.hashtagSearch;
  if (needIg && !igId) return json({ ok: false, error: 'Sin cuenta de Instagram vinculada' });

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
    // Follower demographics — the modern total_value+breakdown shape (replaces
    // the deprecated audience_* metrics). One call per dimension: mixing
    // breakdowns is unreliable, and ≥100 followers is required or it errors
    // (then the section is just absent).
    const demo = (breakdown: string) => safe(`demo_${breakdown}`, () => graph(`${igId}/insights`, pageToken, {
      metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value',
      timeframe: 'last_30_days', breakdown,
    }));

    const [profile, reach, accountTotals, profileTaps, reachByFollow, publishLimit, media, stories, mentions, gender, age, country, city] = await Promise.all([
      safe('profile', () => graph(igId, pageToken, {
        fields: 'username,name,biography,followers_count,follows_count,media_count,profile_picture_url',
      })),
      // Daily reach series, 28d (the sparkline) — the time_series shape.
      safe('reach', () => graph(`${igId}/insights`, pageToken, {
        metric: 'reach', period: 'day', since: String(since), until: String(until),
      })),
      // 28d account totals — the modern engagement metrics. `views` replaced
      // the retired `impressions`; all need metric_type=total_value.
      safe('accountTotals', () => graph(`${igId}/insights`, pageToken, {
        metric: 'views,accounts_engaged,total_interactions', metric_type: 'total_value',
        period: 'day', since: String(since), until: String(until),
      })),
      // `profile_views` was removed in v22 — `profile_links_taps` is the live
      // "people acting on your profile" metric.
      safe('profileTaps', () => graph(`${igId}/insights`, pageToken, {
        metric: 'profile_links_taps', metric_type: 'total_value', period: 'day',
        since: String(since), until: String(until),
      })),
      // Reach split follower vs non-follower — the discovery signal best tools surface.
      safe('reachByFollow', () => graph(`${igId}/insights`, pageToken, {
        metric: 'reach', metric_type: 'total_value', period: 'day',
        breakdown: 'follow_type', since: String(since), until: String(until),
      })),
      // How many of today's publish slots remain (quota_total currently 50/24h).
      safe('publishLimit', () => graph(`${igId}/content_publishing_limit`, pageToken, { fields: 'config,quota_usage' })),
      // The content grid.
      safe('media', () => graph(`${igId}/media`, pageToken, {
        fields: 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
        limit: '24',
      })),
      // Active stories (last 24h).
      safe('stories', () => graph(`${igId}/stories`, pageToken, {
        fields: 'id,media_type,media_url,thumbnail_url,permalink,timestamp', limit: '20',
      })),
      // Media the account is @-tagged in (mentions wall).
      safe('mentions', () => graph(`${igId}/tags`, pageToken, {
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
    // Richest first → leaner fallbacks (metric names drift between media kinds
    // and API versions; the helper keeps whatever answers).
    const sets = isReel
      ? ['reach,views,total_interactions,saved,shares,ig_reels_avg_watch_time', 'reach,views,total_interactions,saved,shares', 'reach,total_interactions']
      : ['reach,views,total_interactions,saved,shares,profile_visits,follows', 'reach,views,total_interactions,saved,shares', 'reach,total_interactions'];
    try {
      const metrics = await mediaInsightValues(mediaId, pageToken, sets);
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
      const r = await graph(`${mediaId}/comments`, pageToken, {
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
      await graphPost(commentId, pageToken, { hide: body.setCommentVisibility.hide ? 'true' : 'false' });
      return json({ ok: true, hidden: !!body.setCommentVisibility.hide });
    } catch (e) {
      return json({ ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }
  if (body.deleteComment) {
    const commentId = String(body.deleteComment.commentId || '').trim();
    if (!commentId) return json({ ok: false, error: 'commentId requerido' }, 400);
    try {
      const res = await fetch(`${GRAPH}/${commentId}?access_token=${encodeURIComponent(pageToken)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) throw new Error(String(data?.error?.message || `Graph ${res.status}`).slice(0, 200));
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }

  // ── hashtagSearch: discovery — top media for a tag ───────────────────
  if (body.hashtagSearch) {
    const q = String(body.hashtagSearch.q || '').trim().replace(/^#/, '');
    if (!q) return json({ ok: false, error: 'Escribe un hashtag' }, 400);
    try {
      const found = await graph('ig_hashtag_search', pageToken, { user_id: igId, q });
      const hashtagId = String(found?.data?.[0]?.id || '');
      if (!hashtagId) return json({ ok: false, error: `Sin resultados para #${q}` });
      const top = await graph(`${hashtagId}/top_media`, pageToken, {
        user_id: igId,
        fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,like_count,comments_count,timestamp',
        limit: '24',
      });
      return json({ ok: true, hashtag: { id: hashtagId, name: q }, media: top?.data || [] });
    } catch (e) {
      return json({ ok: false, error: friendly(String((e as Error)?.message || e).slice(0, 200)) });
    }
  }

  return json({ error: 'Petición no reconocida' }, 400);
});
