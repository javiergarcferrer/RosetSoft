// Marketing — the acting surface for the Meta integration (Facebook Page,
// Instagram, Ads, catalogs). JARVIS stays the read-only briefing room; HERE
// is where the team publishes, schedules, answers comments and watches
// campaigns. Same data spine as the JARVIS brief: the meta-social Edge
// Function (tokens never reach the browser) projected by resolveSocialPulse.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock, Instagram, MessageSquare, RefreshCw, Send, ShoppingBag, Zap,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import MediaPicker from '../components/MediaPicker.jsx';
import { useApp } from '../context/AppContext.jsx';
import { supabase } from '../db/supabaseClient.js';
import { db, newId } from '../db/database.js';
import { resolveSocialPulse, resolveScheduleAgenda, describePost, resolveCatalogProducts } from '../core/jarvis/index.js';

function Stat({ label, value, sub, tone }) {
  return (
    <div className="stat-card p-4">
      <div className="text-[11px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className={`font-display text-2xl font-semibold tabular-nums mt-0.5 ${tone || 'text-ink-900'}`}>{value}</div>
      {sub && <div className="text-xs text-ink-400 mt-0.5">{sub}</div>}
    </div>
  );
}

const deltaSub = (pct, fallback) => (pct != null
  ? `${pct >= 0 ? '+' : ''}${pct}% vs 7d anteriores`
  : fallback);

// One comment-triage card, used for both Instagram and Facebook — same markup,
// the platform only changes the @-prefix and which edge a reply posts to. The
// reply composer is lifted to the parent so a single open editor is shared.
function CommentsCard({
  title, comments, platform, atPrefix, emptyLabel,
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
            <div key={c.id || `${c.username}-${c.at}`} className="px-5 py-2.5">
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
          );
        })}
        {replyErr && reply?.platform === platform && <div className="px-5 py-2 text-sm text-red-600">{replyErr}</div>}
      </div>
    </div>
  );
}

// "hace 12 s" → "hace 3 min" → "hace 2 h". Drives the live freshness pill.
const freshLabel = (ms, now) => {
  if (!ms) return null;
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 4) return 'ahora mismo';
  if (s < 60) return `hace ${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `hace ${min} min`;
  return `hace ${Math.round(min / 60)} h`;
};

// Live-status pill — replaces the old "Actualizar" button. A pulsing dot +
// ticking freshness label reads as a passive "this is live" signal; it's
// still tappable to force a refresh (and shows the spinner on hover/while
// fetching), but it no longer looks like a chore the user has to perform.
function LivePill({ loading, hasData, error, sinceLabel, onRefresh }) {
  // A failed poll only counts as "degraded" when there's nothing on screen;
  // with data still showing, it's just a momentary reconnect.
  const stale = error && hasData;
  const dot = stale ? 'bg-amber-500' : 'bg-emerald-500';
  const text = loading && !hasData
    ? 'Conectando…'
    : stale
      ? 'Reconectando…'
      : loading
        ? 'Actualizando…'
        : `En vivo${sinceLabel ? ` · ${sinceLabel}` : ''}`;
  return (
    <button
      type="button"
      onClick={onRefresh}
      title="Datos en vivo — toca para actualizar ahora"
      className="group inline-flex items-center gap-2 rounded-full border border-ink-200 bg-surface px-2.5 py-1 text-xs text-ink-500 transition-colors hover:border-ink-300 hover:text-ink-800"
    >
      <span className="relative flex h-2 w-2">
        {!stale && <span className={`absolute inline-flex h-full w-full rounded-full ${dot} opacity-60 animate-ping`} />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
      </span>
      <span className="tabular-nums">{text}</span>
      <RefreshCw size={12} className={`transition-opacity ${loading ? 'animate-spin opacity-90' : 'opacity-0 group-hover:opacity-60'}`} />
    </button>
  );
}

export default function Marketing() {
  const { settings, refreshSettings } = useApp();
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

  // 1-second clock so the "hace 12 s" label actually ticks between polls
  // (paused while hidden — a background tab needn't wake to count seconds).
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!linked) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setNowTick(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [linked]);

  // Self-link from the WhatsApp system user (same path as JARVIS).
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState(null);
  const linkNow = useCallback(async () => {
    if (linking) return;
    setLinking(true);
    setLinkError(null);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', { body: { link: {} } });
      if (error) throw new Error(error.message || 'sin respuesta');
      if (!data?.ok) throw new Error(data?.error || 'No se pudo vincular');
      await refreshSettings();
    } catch (e) {
      setLinkError(e?.message || 'No se pudo vincular');
    } finally {
      setLinking(false);
    }
  }, [linking, refreshSettings]);

  const m = useMemo(() => (raw ? resolveSocialPulse(raw) : null), [raw]);

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
  // Product tags (single feed image only).
  const [tags, setTags] = useState([]); // [{ id, name, image }]
  const [tagQuery, setTagQuery] = useState('');
  const [tagResults, setTagResults] = useState([]);
  const [tagBusy, setTagBusy] = useState(false);
  // Scheduled queue (our scheduled_posts table).
  const [agenda, setAgenda] = useState({ upcoming: [], recent: [] });
  const loadAgenda = useCallback(async () => {
    try {
      const rows = await db.scheduledPosts.where('profileId').equals('team').toArray();
      setAgenda(resolveScheduleAgenda(rows));
    } catch { /* table may not exist pre-deploy */ }
  }, []);
  useEffect(() => { if (linked) loadAgenda(); }, [linked, loadAgenda]);

  const searchProducts = useCallback(async () => {
    const q = tagQuery.trim();
    setTagBusy(true);
    try {
      const { data } = await supabase.functions.invoke('meta-social', { body: { catalogSearch: { q } } });
      setTagResults(data?.ok ? resolveCatalogProducts(data) : []);
    } catch { setTagResults([]); } finally { setTagBusy(false); }
  }, [tagQuery]);

  const maxMedia = pubMode === 'carousel' ? 10 : 1;
  // Drop extra media when switching from carousel to a single-item mode.
  useEffect(() => { setPubMedia((prev) => (maxMedia === 1 ? prev.slice(0, 1) : prev)); }, [maxMedia]);

  // Enough to publish: any caption, a single media, or a carousel of ≥2.
  const canPublish = !!(pubText.trim() || (pubMode === 'carousel' ? pubMedia.length >= 2 : pubMedia.length >= 1));

  const resetComposer = () => {
    setPubText(''); setPubMedia([]); setAltText(''); setCollaborators(''); setFirstComment('');
    setTags([]); setTagResults([]); setTagQuery(''); setPubAt('');
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
      productTags: tags.length ? tags.map((t) => ({ productId: t.id })) : undefined,
      targets: ['instagram'],
    };
  };

  const publish = useCallback(async () => {
    if (!canPublish || pubBusy) return;
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
    setPendingIg(null);
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
  }, [pubText, pubMedia, pubMode, altText, collaborators, firstComment, tags, pubAt, canPublish, pubBusy, load, loadAgenda]);

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

  // ── campaign pause/resume — two-step confirm (real money moves) ──────
  const [campArm, setCampArm] = useState(null); // campaign id awaiting confirm
  const [campBusy, setCampBusy] = useState(null);
  const [campErr, setCampErr] = useState(null);
  const toggleCampaign = useCallback(async (c) => {
    if (!c.id || campBusy) return;
    if (campArm !== c.id) { setCampArm(c.id); setCampErr(null); return; }
    setCampArm(null);
    setCampBusy(c.id);
    setCampErr(null);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', {
        body: { setCampaignStatus: { campaignId: c.id, status: c.active ? 'PAUSED' : 'ACTIVE' } },
      });
      if (error) throw new Error(error.message || 'sin respuesta');
      if (!data?.ok) throw new Error(data?.error || 'No se pudo cambiar el estado');
      await load();
    } catch (e) {
      setCampErr(e?.message || 'No se pudo cambiar el estado');
    } finally {
      setCampBusy(null);
    }
  }, [campArm, campBusy, load]);

  const money = (v, digits = 2) => `${Number(v).toLocaleString('en-US', { maximumFractionDigits: digits })}${m?.adCurrency ? ` ${m.adCurrency}` : ''}`;

  return (
    <>
      <PageHeader
        title="Marketing"
        subtitle={linked
          ? (m?.igUsername ? `@${m.igUsername}` : m?.pageName || 'Instagram conectado')
          : 'Sin conectar — usa el usuario del sistema de WhatsApp'}
        actions={linked ? (
          <LivePill
            loading={loading}
            hasData={!!m}
            error={loadError}
            sinceLabel={freshLabel(loadedAt, nowTick)}
            onRefresh={load}
          />
        ) : (
          <button type="button" onClick={linkNow} disabled={linking} className="btn-brand">
            {linking ? <RefreshCw size={14} className="animate-spin" /> : <Zap size={14} />} Vincular
          </button>
        )}
      />

      {!linked ? (
        <div className="card card-pad text-sm text-ink-500">
          Marketing se conecta solo con el usuario del sistema de WhatsApp — el
          mismo que ya envía tus mensajes. Asegúrate en Meta Business de que ese
          usuario tenga asignados la página, el Instagram y la cuenta
          publicitaria, y pulsa Vincular.
          {linkError && <div className="text-red-600 mt-2">{linkError}</div>}
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
        <div className="card card-pad text-sm text-ink-400">Leyendo Meta…</div>
      ) : (
        <div className="space-y-4">
          {/* KPI strip — the same honest figures as the JARVIS brief */}
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Alcance IG · 7d"
              value={m.kpis.reach7.toLocaleString('en-US')}
              sub={deltaSub(m.kpis.reachDeltaPct, 'cuentas alcanzadas')}
            />
            <Stat
              label="Inversión ads · 7d"
              value={m.hasAds ? money(m.kpis.spend7) : '—'}
              sub={deltaSub(m.kpis.spendDeltaPct, m.hasAds ? `28d: ${money(m.kpis.spend28, 0)}` : 'sin cuenta de ads')}
            />
            <Stat
              label={m.kpis.resultsLabel ? `Resultados · 7d` : 'Clics ads · 7d'}
              value={(m.kpis.resultsLabel ? m.kpis.results7 : m.kpis.clicks7).toLocaleString('en-US')}
              sub={m.kpis.resultsLabel
                ? `${m.kpis.resultsLabel}${m.kpis.costPerResult7 != null ? ` · ${money(m.kpis.costPerResult7)} c/u` : ''}`
                : (m.kpis.cpc7 != null ? `CPC ${money(m.kpis.cpc7)}` : 'sin clics aún')}
            />
            <Stat
              label="Seguidores IG"
              value={(m.kpis.igFollowers ?? 0).toLocaleString('en-US')}
              sub={`${m.kpis.newFollowers7 >= 0 ? '+' : ''}${m.kpis.newFollowers7.toLocaleString('en-US')} · ${m.kpis.profileViews7.toLocaleString('en-US')} visitas al perfil · 7d`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2 items-start">
            <div className="space-y-4">
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
                      {/* product tags — single feed image */}
                      {pubMode === 'feed' && (
                        <div className="space-y-1.5 border-t border-ink-100 pt-2">
                          <div className="flex gap-2">
                            <input className="input flex-1" value={tagQuery} onChange={(e) => setTagQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') searchProducts(); }} placeholder="Etiquetar productos del catálogo…" />
                            <button type="button" className="btn-ghost min-h-[44px]" onClick={searchProducts} disabled={tagBusy}>{tagBusy ? <RefreshCw size={14} className="animate-spin" /> : 'Buscar'}</button>
                          </div>
                          {tags.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {tags.map((t) => (
                                <span key={t.id} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-1 text-xs text-brand-800">
                                  {t.name}
                                  <button type="button" onClick={() => setTags((p) => p.filter((x) => x.id !== t.id))} aria-label="Quitar">×</button>
                                </span>
                              ))}
                            </div>
                          )}
                          {tagResults.length > 0 && (
                            <div className="max-h-32 overflow-auto rounded border border-ink-100">
                              {tagResults.filter((r) => !tags.some((t) => t.id === r.id)).slice(0, 8).map((r) => (
                                <button key={r.id} type="button" className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-ink-50" onClick={() => { setTags((p) => [...p, r].slice(0, 5)); setTagResults((p) => p.filter((x) => x.id !== r.id)); }}>
                                  {r.image && <img src={r.image} alt="" className="h-7 w-7 rounded object-cover" />}
                                  <span className="min-w-0 truncate">{r.name}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
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

              {/* campaigns */}
              {m.campaigns.length > 0 && (
                <div className="card">
                  <div className="card-header"><span className="font-medium">Campañas · 28 días</span></div>
                  <div className="divide-y divide-ink-100">
                    {m.campaigns.map((c) => (
                      <div key={c.id || c.name} className="px-5 py-2.5 flex items-center gap-3 text-sm">
                        <span
                          className={`flex-none w-2 h-2 rounded-full ${c.active ? 'bg-emerald-500' : 'bg-ink-300'}`}
                          title={c.status || ''}
                        />
                        <span className="min-w-0 truncate text-ink-800">{c.name}</span>
                        <span className="ml-auto tabular-nums text-ink-800">{money(c.spend)}</span>
                        <span className="tabular-nums text-ink-400 text-xs w-28 text-right">
                          {c.results != null && m.kpis.resultsLabel
                            ? `${c.results} ${m.kpis.resultsLabel}`
                            : c.ctrPct != null ? `CTR ${c.ctrPct.toFixed(2)}%` : `${c.clicks} clics`}
                        </span>
                        {c.id && (
                          <button
                            type="button"
                            className={`flex-none text-xs px-2 py-1 rounded border transition-colors ${
                              campArm === c.id
                                ? 'border-red-300 bg-red-50 text-red-700 font-medium'
                                : 'border-ink-200 text-ink-500 hover:bg-ink-50'
                            }`}
                            onClick={() => toggleCampaign(c)}
                            disabled={campBusy === c.id}
                          >
                            {campBusy === c.id
                              ? '…'
                              : campArm === c.id
                                ? (c.active ? '¿Confirmar pausa?' : '¿Confirmar activar?')
                                : (c.active ? 'Pausar' : 'Activar')}
                          </button>
                        )}
                      </div>
                    ))}
                    {campErr && <div className="px-5 py-2 text-sm text-red-600">{campErr}</div>}
                  </div>
                </div>
              )}

              {/* catalogs */}
              {m.catalogs.length > 0 && (
                <div className="card">
                  <div className="card-header">
                    <span className="flex items-center gap-2 font-medium"><ShoppingBag size={15} /> Catálogos Meta</span>
                  </div>
                  <div className="divide-y divide-ink-100">
                    {m.catalogs.map((cat) => (
                      <div key={`${cat.business}-${cat.name}`} className="px-5 py-2.5 flex items-baseline gap-3 text-sm">
                        <span className="min-w-0 truncate text-ink-800">{cat.name}</span>
                        <span className="ml-auto tabular-nums text-ink-500">{cat.products.toLocaleString('en-US')} productos</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-4">
              {/* comment triage — Instagram */}
              <CommentsCard
                title="Comentarios"
                comments={m.recentComments}
                platform="instagram"
                atPrefix="@"
                emptyLabel="Sin comentarios recientes."
                reply={reply}
                openReply={openReply}
                replyText={replyText}
                setReplyText={setReplyText}
                replyBusy={replyBusy}
                replyErr={replyErr}
                sendReply={sendReply}
              />

              {/* scheduled */}
              <div className="card">
                <div className="card-header">
                  <span className="flex items-center gap-2 font-medium"><CalendarClock size={15} /> Programado</span>
                </div>
                <div className="divide-y divide-ink-100">
                  {m.scheduled.length === 0 && (
                    <div className="px-5 py-3 text-sm text-ink-400">Nada programado.</div>
                  )}
                  {m.scheduled.map((p) => (
                    <div key={p.at} className="px-5 py-2.5 flex items-baseline gap-3 text-sm">
                      <span className="min-w-0 truncate text-ink-800">{p.text}</span>
                      <span className="ml-auto flex-none text-xs text-ink-400">{p.inLabel}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* recent posts */}
              {m.posts.length > 0 && (
                <div className="card">
                  <div className="card-header"><span className="font-medium">Últimas publicaciones IG</span></div>
                  <div className="divide-y divide-ink-100">
                    {m.posts.slice(0, 5).map((p) => (
                      <div key={p.permalink || p.at} className="px-5 py-2.5 flex items-baseline gap-3 text-sm">
                        <span className="min-w-0 truncate text-ink-800">
                          {p.permalink ? (
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
              Secciones de Meta sin respuesta: {Object.keys(m.errors).join(', ')} — el resto es dato real.
            </div>
          )}
        </div>
      )}
    </>
  );
}
