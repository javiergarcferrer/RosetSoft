// Marketing — the acting surface for the Meta integration (Facebook Page,
// Instagram, Ads, catalogs). JARVIS stays the read-only briefing room; HERE
// is where the team publishes, schedules, answers comments and watches
// campaigns. Same data spine as the JARVIS brief: the meta-social Edge
// Function (tokens never reach the browser) projected by resolveSocialPulse.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  CalendarClock, ExternalLink, Instagram, MessageSquare, RefreshCw, Send,
} from 'lucide-react';
import MediaPicker from '../components/MediaPicker.jsx';
import Modal from '../components/Modal.jsx';
import { useApp } from '../context/AppContext.jsx';
import { supabase } from '../db/supabaseClient.js';
import { db, newId } from '../db/database.js';
import { resolveSocialPulse, resolveScheduleAgenda, describePost } from '../core/jarvis/index.js';
import { Stat, useInstagramLive } from '../components/instagram/chrome.jsx';

const deltaSub = (pct, fallback) => (pct != null
  ? `${pct >= 0 ? '+' : ''}${pct}% vs 7d anteriores`
  : fallback);

// A small, clickable post thumbnail that opens the peek popup. Renders nothing
// when there's no image (e.g. a video-only scheduled post with no preview).
//
// HOVER (fine-pointer only) pops a floating enlarged preview — no click needed,
// mirroring the materials-catalog image popup. CLICK opens the full
// publication modal. We own the preview state (not ImageView's) so we can
// dismiss it the instant the modal opens, never letting it linger on top.
function PostThumb({ src, onClick, className = 'w-11 h-11' }) {
  const ref = useRef(null);
  const [box, setBox] = useState(null);
  useEffect(() => {
    if (!box) return undefined;
    const close = () => setBox(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [box]);
  if (!src) return null;
  const canHover = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const openPreview = () => {
    if (!canHover) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 12;
    const width = Math.min(360, Math.round(vw * 0.42));
    // The thumbnails live in the right column → prefer popping to the LEFT;
    // flip right when there's no room; clamp into the viewport either way.
    let left = r.left - margin - width;
    if (left < margin) left = r.right + margin;
    if (left + width > vw - margin) left = Math.max(margin, vw - margin - width);
    const estH = Math.min(Math.round(vh * 0.7), Math.round(width * 1.25));
    let top = r.top;
    if (top + estH > vh - margin) top = Math.max(margin, vh - margin - estH);
    if (top < margin) top = margin;
    setBox({ left, top, width });
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => { setBox(null); onClick?.(); }}
        onMouseEnter={openPreview}
        onMouseLeave={() => setBox(null)}
        className={`flex-none ${className} rounded-md overflow-hidden bg-ink-100 border border-ink-100 cursor-zoom-in hover:ring-2 hover:ring-brand-300 transition`}
        aria-label="Ver la publicación"
        title="Pasa el cursor para ampliar — clic para la publicación completa"
      >
        <img src={src} alt="" className="w-full h-full object-cover" loading="lazy" />
      </button>
      {box && createPortal(
        <div
          className="fixed z-[80] pointer-events-none rounded-lg overflow-hidden bg-white shadow-2xl border border-ink-200"
          style={{ left: box.left, top: box.top, width: box.width }}
        >
          <img src={src} alt="" className="block w-full h-auto max-h-[70vh] object-contain bg-white" />
        </div>,
        document.body,
      )}
    </>
  );
}

// The full publication view (on click): the photo, engagement, caption and the
// comment thread. Built from a comment (its own comment highlighted), a recent
// post, or a scheduled item.
function PostPeek({ post, onClose }) {
  const others = (post?.commentList || []).filter((c) => !post.highlight || c.id !== post.highlight.id);
  const moreCount = post ? Math.max(0, (post.comments || 0) - (post.commentList?.length || 0)) : 0;
  return (
    <Modal open={!!post} onClose={onClose} title={post?.title || 'Publicación'} size="lg">
      {post && (
        <div className="space-y-4">
          {post.mediaUrl ? (
            <div className="flex items-center justify-center overflow-hidden rounded-xl bg-ink-50">
              <img src={post.mediaUrl} alt="" className="max-h-[52vh] w-auto max-w-full object-contain" />
            </div>
          ) : (
            <div className="flex items-center justify-center h-40 rounded-xl bg-ink-100 text-sm text-ink-400">
              Sin imagen disponible
            </div>
          )}

          {/* engagement + meta */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-500">
            {post.likes != null && <span className="tabular-nums">♥ {post.likes.toLocaleString('en-US')} me gusta</span>}
            {post.comments != null && <span className="tabular-nums">💬 {post.comments.toLocaleString('en-US')} comentarios</span>}
            {post.when && <span className="text-ink-400">{post.when}</span>}
            {post.permalink && (
              <a
                href={post.permalink}
                target="_blank"
                rel="noreferrer"
                className="ml-auto flex items-center gap-1 text-brand-700 hover:underline"
              >
                <ExternalLink size={13} /> Ver publicación
              </a>
            )}
          </div>

          {post.caption && (
            <p className="text-sm leading-relaxed text-ink-700 whitespace-pre-wrap">{post.caption}</p>
          )}

          {/* comment thread */}
          {(post.highlight || others.length > 0) && (
            <div className="border-t border-ink-100 pt-3 space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-ink-400">Comentarios</div>
              {post.highlight && (
                <div className="rounded-lg bg-brand-50 px-3 py-2 text-sm">
                  <span className="font-medium text-ink-900">@{post.highlight.username || 'Anónimo'}</span>{' '}
                  <span className="text-ink-700">{post.highlight.text}</span>
                </div>
              )}
              {others.map((c) => (
                <div key={c.id || `${c.username}-${c.at}`} className="text-sm">
                  <span className="font-medium text-ink-900">@{c.username || 'Anónimo'}</span>{' '}
                  <span className="text-ink-700">{c.text}</span>
                  {c.ago && <span className="ml-2 text-xs text-ink-400">{c.ago}</span>}
                </div>
              ))}
              {moreCount > 0 && <div className="text-xs text-ink-400">y {moreCount} más…</div>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// One comment-triage card, used for both Instagram and Facebook — same markup,
// the platform only changes the @-prefix and which edge a reply posts to. The
// reply composer is lifted to the parent so a single open editor is shared.
function CommentsCard({
  title, comments, platform, atPrefix, emptyLabel, onPeek,
  reply, openReply, replyText, setReplyText, replyBusy, replyErr, sendReply,
}) {
  return (
    <div className="card">
      <div className="card-header">
        <span className="flex items-center gap-2 font-medium"><MessageSquare size={15} /> {title}</span>
      </div>
      <div className="divide-y divide-ink-100">
        {comments.length === 0 && <div className="px-5 py-3 text-sm text-ink-400">{emptyLabel}</div>}
        {comments.map((c) => {
          const open = reply?.platform === platform && reply?.id === c.id;
          return (
            <div key={c.id || `${c.username}-${c.at}`} className="px-5 py-2.5 flex items-start gap-3">
              <PostThumb src={c.mediaUrl} onClick={() => onPeek?.(c)} />
              <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-medium text-ink-900">{atPrefix}{c.username || 'Anónimo'}</span>{' '}
                  <span className="text-ink-600">{c.text}</span>
                </span>
                <span className="ml-auto flex-none text-xs text-ink-400">{c.ago || ''}</span>
                {c.id && (
                  <button
                    type="button"
                    className="flex-none text-xs text-brand-700 hover:underline"
                    onClick={() => openReply(open ? null : { id: c.id, platform, username: c.username })}
                  >
                    Responder
                  </button>
                )}
              </div>
              {open && (
                <div className="flex gap-2 mt-2">
                  <input
                    className="input flex-1"
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') sendReply(); }}
                    placeholder={`Responder a ${atPrefix}${c.username || ''}…`}
                    maxLength={500}
                    autoFocus
                  />
                  <button type="button" className="btn-brand" onClick={sendReply} disabled={!replyText.trim() || replyBusy} aria-label="Enviar respuesta" title="Enviar respuesta">
                    {replyBusy ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
                  </button>
                </div>
              )}
              </div>
            </div>
          );
        })}
        {replyErr && reply?.platform === platform && <div className="px-5 py-2 text-sm text-red-600">{replyErr}</div>}
      </div>
    </div>
  );
}

export default function Marketing() {
  const { settings } = useApp();
  const linked = !!settings?.metaSocialConnectedAt;

  const [raw, setRaw] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);
  const busy = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', { body: { snapshot: true } });
      if (error) throw new Error(error.message || 'sin respuesta');
      if (data?.configured === false || data?.error) throw new Error(data?.error || 'sin respuesta');
      setRaw(data);
      setLoadError(null);
      setLoadedAt(Date.now());
    } catch (e) {
      // Keep the last good snapshot on screen — a transient blip shouldn't
      // blank a live dashboard; the freshness pill flags the degraded state
      // and the next poll heals it.
      setLoadError(e?.message || 'No se pudo leer Meta');
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, []);

  // Live data, no manual refresh: load on mount, poll every 45 s while the
  // tab is visible, and re-fetch the instant the user returns to it. Polling
  // pauses in a hidden tab so we don't spend Graph API calls nobody is reading.
  useEffect(() => {
    if (!linked) return undefined;
    load();
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    const poll = setInterval(onVisible, 45_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [linked, load]);

  const m = useMemo(() => (raw ? resolveSocialPulse(raw) : null), [raw]);

  // Surface this tab's fetch status to the shell header's single live pill (the
  // shell owns the freshness ticker, so the "hace 3 s" label updates there).
  useInstagramLive({ loading, hasData: !!m, error: loadError, loadedAt, onRefresh: load });

  // ── composer ─────────────────────────────────────────────────────────
  const [pubText, setPubText] = useState('');
  const [pubMedia, setPubMedia] = useState([]); // [{ url, type, key }] from device upload
  const [pubMode, setPubMode] = useState('feed'); // 'feed' | 'reel' | 'story' | 'carousel'
  const [pubBusy, setPubBusy] = useState(false);
  const [pubNote, setPubNote] = useState(null);
  // An IG video container that was still processing when publish() returned —
  // surfaced as a one-tap "Finalizar" so the user never loses the upload.
  const [pendingIg, setPendingIg] = useState(null); // { creationId }
  const [finishBusy, setFinishBusy] = useState(false);
  // Advanced options (alt text, collaborators, first comment).
  const [showAdv, setShowAdv] = useState(false);
  const [altText, setAltText] = useState('');
  const [collaborators, setCollaborators] = useState('');
  const [firstComment, setFirstComment] = useState('');
  // Schedule (our own engine — IG has no native scheduling).
  const [pubAt, setPubAt] = useState('');
  // Scheduled queue (our scheduled_posts table).
  const [agenda, setAgenda] = useState({ upcoming: [], recent: [] });
  const loadAgenda = useCallback(async () => {
    try {
      const rows = await db.scheduledPosts.where('profileId').equals('team').toArray();
      setAgenda(resolveScheduleAgenda(rows));
    } catch { /* table may not exist pre-deploy */ }
  }, []);
  useEffect(() => { if (linked) loadAgenda(); }, [linked, loadAgenda]);

  const maxMedia = pubMode === 'carousel' ? 10 : 1;
  // Drop extra media when switching from carousel to a single-item mode.
  useEffect(() => { setPubMedia((prev) => (maxMedia === 1 ? prev.slice(0, 1) : prev)); }, [maxMedia]);

  // Enough to publish: any caption, a single media, or a carousel of ≥2.
  const canPublish = !!(pubText.trim() || (pubMode === 'carousel' ? pubMedia.length >= 2 : pubMedia.length >= 1));

  const resetComposer = () => {
    setPubText(''); setPubMedia([]); setAltText(''); setCollaborators(''); setFirstComment('');
    setPubAt('');
  };

  // The meta-social `publish` body for the current composer state.
  const buildBody = () => {
    const first = pubMedia[0];
    const carousel = pubMode === 'carousel'
      ? pubMedia.map((it) => (it.type === 'video' ? { videoUrl: it.url } : { imageUrl: it.url }))
      : null;
    return {
      message: pubText.trim(),
      imageUrl: pubMode !== 'carousel' && first?.type === 'image' ? first.url : undefined,
      videoUrl: pubMode !== 'carousel' && first?.type === 'video' ? first.url : undefined,
      carousel: carousel && carousel.length ? carousel : undefined,
      igStory: pubMode === 'story',
      altText: altText.trim() || undefined,
      collaborators: collaborators.split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean).slice(0, 3),
      firstComment: firstComment.trim() || undefined,
    };
  };

  const publish = useCallback(async () => {
    if (!canPublish || pubBusy) return;
    // A still-processing IG video holds a creationId that only "Finalizar" can
    // resolve. Starting another publish used to clear it (orphaning the upload
    // with no way to finish it), so refuse until the user finishes or discards.
    if (pendingIg) { setPubNote({ ok: false, text: 'Hay un video de Instagram pendiente — finalízalo o descártalo antes de publicar otro.' }); return; }
    const pubBody = buildBody();

    // Scheduled? Queue it for the worker instead of publishing now.
    if (pubAt) {
      const at = new Date(pubAt).getTime();
      if (!at || at < Date.now() + 60_000) { setPubNote({ ok: false, text: 'Elige una hora al menos 1 minuto en el futuro.' }); return; }
      setPubBusy(true);
      setPubNote(null);
      try {
        const { kind, preview } = describePost(pubBody);
        await db.scheduledPosts.put({
          id: newId(), profileId: 'team', status: 'queued', scheduledAt: at,
          payload: pubBody, kind, preview, attempts: 0, createdAt: Date.now(), updatedAt: Date.now(),
        });
        // Best-effort: ensure the worker's per-minute cron is registered.
        supabase.functions.invoke('ig-publish-worker', { body: { ensureCron: true } }).catch(() => {});
        setPubNote({ ok: true, text: `Programado para ${new Date(at).toLocaleString('es-DO')}` });
        resetComposer();
        loadAgenda();
      } catch (e) {
        setPubNote({ ok: false, text: e?.message || 'No se pudo programar' });
      } finally {
        setPubBusy(false);
      }
      return;
    }

    setPubBusy(true);
    setPubNote(null);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', { body: { publish: pubBody } });
      if (error) throw new Error(error.message || 'sin respuesta');
      const ig = (data?.results || {}).instagram || {};
      // IG video still processing → keep the creation id for the finish button.
      if (ig.pending && ig.creationId) setPendingIg({ creationId: ig.creationId });
      setPubNote({
        ok: !!data?.ok,
        text: ig.ok ? 'Publicado en Instagram ✓'
          : ig.pending ? 'Instagram: procesando…'
            : (ig.error || data?.error || 'sin respuesta'),
      });
      if (data?.ok) { resetComposer(); load(); }
    } catch (e) {
      setPubNote({ ok: false, text: e?.message || 'Fallo al publicar' });
    } finally {
      setPubBusy(false);
    }
  }, [pubText, pubMedia, pubMode, altText, collaborators, firstComment, pubAt, canPublish, pubBusy, pendingIg, load, loadAgenda]);

  const discardPending = useCallback(() => {
    setPendingIg(null);
    setPubNote(null);
  }, []);

  const cancelScheduled = useCallback(async (id) => {
    try { await db.scheduledPosts.delete(id); loadAgenda(); } catch { /* ignore */ }
  }, [loadAgenda]);

  const finishPending = useCallback(async () => {
    if (!pendingIg?.creationId || finishBusy) return;
    setFinishBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', {
        body: { finishPublish: { creationId: pendingIg.creationId } },
      });
      if (error) throw new Error(error.message || 'sin respuesta');
      if (data?.pending) { setPubNote({ ok: false, text: 'Instagram: sigue procesando — inténtalo de nuevo en unos segundos.' }); return; }
      if (!data?.ok) throw new Error(data?.error || 'No se pudo publicar');
      setPendingIg(null);
      setPubNote({ ok: true, text: 'Instagram ✓' });
      load();
    } catch (e) {
      setPubNote({ ok: false, text: e?.message || 'No se pudo finalizar' });
    } finally {
      setFinishBusy(false);
    }
  }, [pendingIg, finishBusy, load]);

  // ── post peek popup (full publication view on click) ──────────────────
  const [peek, setPeek] = useState(null);
  const peekPost = useCallback((p) => setPeek({
    title: 'Publicación',
    mediaUrl: p.mediaUrl,
    caption: p.caption,
    permalink: p.permalink,
    likes: p.likes,
    comments: p.comments,
    when: p.ago,
    commentList: p.commentList || [],
  }), []);
  // From a comment, resolve its parent post (shared permalink) so the modal
  // shows the WHOLE publication — likes, caption, the comment thread — with the
  // clicked comment highlighted.
  const peekComment = useCallback((c) => {
    const post = (m?.posts || []).find((p) => p.permalink && p.permalink === c.permalink);
    setPeek({
      title: 'Publicación',
      mediaUrl: c.mediaUrl || post?.mediaUrl,
      caption: post?.caption ?? c.postCaption,
      permalink: c.permalink || post?.permalink,
      likes: post?.likes,
      comments: post?.comments,
      when: post?.ago,
      commentList: post?.commentList || [],
      highlight: { id: c.id, username: c.username, text: c.text },
    });
  }, [m]);
  const peekScheduled = useCallback((p) => setPeek({
    title: 'Programado',
    mediaUrl: p.mediaUrl || p.thumb,
    caption: p.text || p.preview,
    permalink: p.permalink,
    when: p.inLabel || (p.at ? new Date(p.at).toLocaleString('es-DO') : null),
  }), []);

  // ── inline comment reply (IG + FB share one open editor) ─────────────
  const [reply, setReply] = useState(null); // { id, platform, username }
  const [replyText, setReplyText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyErr, setReplyErr] = useState(null);
  const openReply = useCallback((target) => { setReply(target); setReplyText(''); setReplyErr(null); }, []);
  const sendReply = useCallback(async () => {
    const message = replyText.trim();
    if (!message || !reply?.id || replyBusy) return;
    setReplyBusy(true);
    setReplyErr(null);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', {
        body: { replyComment: { commentId: reply.id, message, platform: reply.platform } },
      });
      if (error) throw new Error(error.message || 'sin respuesta');
      if (!data?.ok) throw new Error(data?.error || 'No se pudo responder');
      setReply(null);
      setReplyText('');
    } catch (e) {
      setReplyErr(e?.message || 'No se pudo responder');
    } finally {
      setReplyBusy(false);
    }
  }, [replyText, reply, replyBusy]);

  // ── ad campaign pause/resume (Marketing API; REAL MONEY → confirm-gated) ──
  const [campBusy, setCampBusy] = useState(null);
  const [campErr, setCampErr] = useState(null);
  const toggleCampaign = useCallback(async (c) => {
    if (campBusy || !c?.id) return;
    const next = c.active ? 'PAUSED' : 'ACTIVE';
    if (!window.confirm(c.active ? `¿Pausar la campaña “${c.name}”?` : `¿Reanudar la campaña “${c.name}”?`)) return;
    setCampBusy(c.id);
    setCampErr(null);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', {
        body: { setCampaignStatus: { campaignId: c.id, status: next } },
      });
      if (error) throw new Error(error.message || 'sin respuesta');
      if (!data?.ok) throw new Error(data?.error || 'No se pudo cambiar la campaña');
      load();
    } catch (e) {
      setCampErr(e?.message || 'No se pudo cambiar la campaña');
    } finally {
      setCampBusy(null);
    }
  }, [campBusy, load]);

  return (
    <>
      {!linked ? (
        <div className="card card-pad text-sm text-ink-500">
          Conecta tu cuenta de Instagram profesional en{' '}
          <Link to="/settings" className="text-brand-700 hover:underline">Configuración → Instagram</Link>{' '}
          para publicar, programar, responder comentarios y ver estadísticas desde aquí.
        </div>
      ) : loadError && !raw ? (
        <div className="card card-pad text-sm">
          <div className="text-red-600">{loadError}</div>
          <div className="mt-1 text-xs text-ink-400">Reintentando automáticamente…</div>
          <button type="button" className="btn-brand mt-3" onClick={load}>
            <RefreshCw size={14} /> Reintentar ahora
          </button>
        </div>
      ) : !m ? (
        <div className="card card-pad text-sm text-ink-400">Leyendo Instagram…</div>
      ) : (
        <div className="space-y-4">
          {/* KPI strip — Instagram figures, same honest math as the JARVIS brief */}
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Seguidores IG"
              value={(m.kpis.igFollowers ?? 0).toLocaleString('en-US')}
              sub={`${m.kpis.newFollowers7 >= 0 ? '+' : ''}${m.kpis.newFollowers7.toLocaleString('en-US')} · 7d`}
            />
            <Stat
              label="Alcance IG · 7d"
              value={m.kpis.reach7.toLocaleString('en-US')}
              sub={deltaSub(m.kpis.reachDeltaPct, 'cuentas alcanzadas')}
            />
            <Stat
              label="Acciones en el perfil · 7d"
              value={m.kpis.profileActions7.toLocaleString('en-US')}
              sub="enlaces y botones"
            />
            <Stat
              label="Comentarios recientes"
              value={m.recentComments.length.toLocaleString('en-US')}
              sub="para responder"
            />
          </div>

          <div className="grid gap-4 grid-cols-1 lg:grid-cols-2 items-start">
            <div className="space-y-4 min-w-0">
              {/* composer — Instagram only */}
              <div className="card">
                <div className="card-header">
                  <span className="flex items-center gap-2 font-medium"><Instagram size={15} /> Publicar en Instagram</span>
                </div>
                <div className="card-pad space-y-3">
                  <textarea
                    className="input w-full min-h-20"
                    value={pubText}
                    onChange={(e) => setPubText(e.target.value)}
                    placeholder={pubMode === 'story' ? 'Texto opcional…' : 'Pie de foto…'}
                    maxLength={2200}
                  />
                  <MediaPicker
                    items={pubMedia}
                    onChange={setPubMedia}
                    max={maxMedia}
                    accept={pubMode === 'reel' ? 'video/*' : 'image/*,video/*'}
                  />

                  {/* advanced options — alt text, collaborators, first comment */}
                  <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => setShowAdv((v) => !v)}>
                    {showAdv ? 'Ocultar opciones avanzadas' : 'Opciones avanzadas'}
                  </button>
                  {showAdv && (
                    <div className="space-y-2 rounded-lg border border-ink-100 p-3">
                      <input className="input w-full" value={collaborators} onChange={(e) => setCollaborators(e.target.value)} placeholder="Colaboradores: @usuario1, @usuario2 (máx. 3)" spellCheck={false} />
                      <input className="input w-full" value={firstComment} onChange={(e) => setFirstComment(e.target.value)} placeholder="Primer comentario (p. ej. #hashtags)" />
                      <input className="input w-full" value={altText} onChange={(e) => setAltText(e.target.value)} placeholder="Texto alternativo (accesibilidad, solo imagen)" maxLength={1000} />
                    </div>
                  )}

                  {/* action bar — sticky on mobile, clears the home indicator.
                      Controls stack full-width on a phone (the datetime-local
                      input has a wide intrinsic size and won't shrink, so a
                      w-auto row overflowed and got clipped); inline from sm+. */}
                  <div className="sticky bottom-0 -mx-5 -mb-5 flex flex-col gap-2 border-t border-ink-100 bg-surface px-5 py-3 [padding-bottom:calc(0.75rem+env(safe-area-inset-bottom,0px))] sm:static sm:m-0 sm:flex-row sm:flex-wrap sm:items-center sm:border-0 sm:bg-transparent sm:p-0">
                    <select
                      className="input w-full sm:w-auto py-2 text-sm min-h-[44px]"
                      value={pubMode}
                      onChange={(e) => setPubMode(e.target.value)}
                      aria-label="Tipo de publicación"
                    >
                      <option value="feed">Feed</option>
                      <option value="reel">Reel</option>
                      <option value="story">Story (24 h)</option>
                      <option value="carousel">Carrusel</option>
                    </select>
                    <input
                      className="input w-full min-w-0 sm:w-auto py-2 text-sm min-h-[44px]"
                      type="datetime-local"
                      value={pubAt}
                      onChange={(e) => setPubAt(e.target.value)}
                      aria-label="Programar (opcional)"
                    />
                    <button
                      type="button"
                      className="btn-brand w-full justify-center sm:w-auto sm:ml-auto min-h-[44px]"
                      onClick={publish}
                      disabled={!canPublish || pubBusy}
                    >
                      {pubBusy ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
                      {pubAt ? 'Programar' : 'Publicar'}
                    </button>
                  </div>
                  <p className="text-xs text-ink-400">
                    Sube imagen o video desde tu dispositivo; el Reel necesita video y el carrusel 2–10
                    elementos. Deja la fecha vacía para publicar al momento, o elígela para programarlo.
                  </p>
                  {pendingIg && (
                    <div className="flex items-center gap-2 text-sm text-ink-600">
                      <span>El video de Instagram sigue procesando.</span>
                      <button type="button" className="btn-brand py-1 min-h-[44px]" onClick={finishPending} disabled={finishBusy}>
                        {finishBusy ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />} Finalizar
                      </button>
                      <button type="button" className="btn-ghost py-1 min-h-[44px]" onClick={discardPending} disabled={finishBusy}>
                        Descartar
                      </button>
                    </div>
                  )}
                  {pubNote && (
                    <div className={`text-sm ${pubNote.ok ? 'text-emerald-700' : 'text-red-600'}`}>{pubNote.text}</div>
                  )}
                </div>
              </div>

              {/* scheduled queue (our engine) */}
              {(agenda.upcoming.length > 0 || agenda.recent.length > 0) && (
                <div className="card">
                  <div className="card-header">
                    <span className="flex items-center gap-2 font-medium"><CalendarClock size={15} /> Programados</span>
                  </div>
                  <div className="divide-y divide-ink-100">
                    {agenda.upcoming.map((p) => (
                      <div key={p.id} className="px-5 py-2.5 flex items-center gap-3 text-sm">
                        <PostThumb src={p.thumb} onClick={() => peekScheduled(p)} className="w-9 h-9" />
                        <span className="flex-none rounded-full bg-brand-50 px-2 py-0.5 text-[11px] text-brand-800">{p.kind}</span>
                        <span className="min-w-0 truncate text-ink-700">{p.preview || '(sin texto)'}</span>
                        <span className="ml-auto flex-none text-xs text-ink-400">{new Date(p.at).toLocaleString('es-DO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                        <button type="button" className="flex-none text-xs text-red-600 hover:underline" onClick={() => cancelScheduled(p.id)}>Cancelar</button>
                      </div>
                    ))}
                    {agenda.recent.map((p) => (
                      <div key={p.id} className="px-5 py-2 flex items-center gap-3 text-xs text-ink-400">
                        <span className={`flex-none ${p.status === 'failed' ? 'text-red-600' : 'text-emerald-700'}`}>{p.statusLabel}</span>
                        <span className="min-w-0 truncate">{p.preview || p.kind}</span>
                        {p.error && <span className="ml-auto flex-none text-red-600 truncate max-w-40" title={p.error}>{p.error}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>

            <div className="space-y-4 min-w-0">
              {/* comment triage — Instagram */}
              <CommentsCard
                title="Comentarios"
                comments={m.recentComments}
                platform="instagram"
                atPrefix="@"
                emptyLabel="Sin comentarios recientes."
                onPeek={peekComment}
                reply={reply}
                openReply={openReply}
                replyText={replyText}
                setReplyText={setReplyText}
                replyBusy={replyBusy}
                replyErr={replyErr}
                sendReply={sendReply}
              />

              {/* ad campaigns — view performance + pause/resume (Marketing API) */}
              {m.hasAds && m.campaigns.length > 0 && (
                <div className="card">
                  <div className="card-header flex items-center justify-between">
                    <span className="font-medium">Campañas de anuncios</span>
                    {m.kpis.spend7 != null && (
                      <span className="text-xs text-ink-400 tabular-nums">{m.kpis.spend7.toLocaleString('en-US', { maximumFractionDigits: 0 })}{m.adCurrency ? ` ${m.adCurrency}` : ''} · 7d</span>
                    )}
                  </div>
                  {campErr && <div className="px-5 pt-2 text-xs text-red-600">{campErr}</div>}
                  <div className="divide-y divide-ink-100">
                    {m.campaigns.map((c) => (
                      <div key={c.id} className="px-5 py-2.5 flex items-center gap-3 text-sm">
                        <span className={`flex-none h-2 w-2 rounded-full ${c.active ? 'bg-emerald-500' : 'bg-ink-300'}`} title={c.status || ''} />
                        <span className="min-w-0 flex-1 truncate text-ink-800">{c.name}</span>
                        <span className="flex-none text-xs text-ink-400 tabular-nums">
                          {c.spend != null ? c.spend.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'}{m.adCurrency ? ` ${m.adCurrency}` : ''}{c.results != null ? ` · ${c.results} res.` : ''}
                        </span>
                        <button
                          type="button"
                          disabled={campBusy === c.id || !c.id}
                          onClick={() => toggleCampaign(c)}
                          className={`flex-none rounded-full px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${c.active ? 'bg-amber-50 text-amber-700 hover:bg-amber-100' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}
                        >
                          {campBusy === c.id ? '…' : c.active ? 'Pausar' : 'Reanudar'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* recent posts */}
              {m.posts.length > 0 && (
                <div className="card">
                  <div className="card-header"><span className="font-medium">Últimas publicaciones IG</span></div>
                  <div className="divide-y divide-ink-100">
                    {m.posts.slice(0, 5).map((p) => (
                      <div key={p.permalink || p.at} className="px-5 py-2.5 flex items-center gap-3 text-sm">
                        <PostThumb src={p.mediaUrl} onClick={() => peekPost(p)} className="w-9 h-9" />
                        <span className="min-w-0 truncate text-ink-800">
                          {p.mediaUrl ? (
                            <button type="button" className="text-left hover:underline" onClick={() => peekPost(p)}>{p.text}</button>
                          ) : p.permalink ? (
                            <a href={p.permalink} target="_blank" rel="noreferrer" className="hover:underline">{p.text}</a>
                          ) : p.text}
                        </span>
                        <span className="ml-auto flex-none text-xs text-ink-400 tabular-nums">
                          ♥ {p.likes} · 💬 {p.comments} · {p.ago || ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {Object.keys(m.errors).length > 0 && (
            <div className="text-xs text-amber-700">
              Secciones de Instagram sin respuesta: {Object.keys(m.errors).join(', ')} — el resto es dato real.
            </div>
          )}
        </div>
      )}
      <PostPeek post={peek} onClose={() => setPeek(null)} />
    </>
  );
}
