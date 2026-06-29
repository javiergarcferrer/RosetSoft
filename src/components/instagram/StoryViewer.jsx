// StoryViewer — a real, full-screen 9:16 story player (the "preview in the
// right manner" the dashboard was missing; the old strip just linked out to
// instagram.com in a new tab). Tap/keyboard to navigate, hold to pause,
// segmented progress bars that auto-advance, native image + video playback,
// and live per-story insights (reach / views / replies) loaded on demand.
// Self-contained: it reads insights straight through the meta-social Edge
// Function and renders over a portal so the app shell never clips it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, ChevronLeft, ChevronRight, Pause, Volume2, VolumeX, ExternalLink, Eye, Heart, MessageCircle,
} from 'lucide-react';
import { supabase } from '../../db/supabaseClient.js';
import { resolveMediaInsights } from '../../core/jarvis/index.js';
import { fmt } from './chrome.jsx';

const IMAGE_MS = 5000; // a still story holds for 5s, like Instagram

const METRIC_ICON = { reach: Eye, views: Eye, total_interactions: Heart, replies: MessageCircle };

export default function StoryViewer({ stories = [], startIndex = 0, profile, onClose }) {
  const [idx, setIdx] = useState(() => Math.min(Math.max(0, startIndex), Math.max(0, stories.length - 1)));
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);
  const [insights, setInsights] = useState({}); // id → { loading, rows, error }

  const story = stories[idx] || null;
  const isVideo = !!story?.isVideo;

  const videoRef = useRef(null);
  const rafRef = useRef(0);
  const lastRef = useRef(0);
  const progRef = useRef(0);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const close = useCallback(() => { cancelAnimationFrame(rafRef.current); onClose?.(); }, [onClose]);
  const go = useCallback((next) => {
    setIdx((i) => {
      const n = i + next;
      if (n < 0) return 0;            // already first → stay (restart below)
      if (n >= stories.length) { close(); return i; }
      return n;
    });
  }, [stories.length, close]);
  const next = useCallback(() => go(1), [go]);
  const prev = useCallback(() => { if (progRef.current > 0.02 && idx >= 0) { progRef.current = 0; setProgress(0); lastRef.current = 0; } else go(-1); }, [go, idx]);

  // ── the segmented-progress ticker — image accumulates wall-clock, video
  // tracks its own currentTime; pausing freezes either without a jump. ─────
  useEffect(() => {
    progRef.current = 0;
    setProgress(0);
    lastRef.current = 0;
    let alive = true;
    const tick = (now) => {
      if (!alive) return;
      if (!lastRef.current) lastRef.current = now;
      if (!pausedRef.current) {
        if (isVideo && videoRef.current) {
          const d = videoRef.current.duration;
          if (d && Number.isFinite(d)) progRef.current = Math.min(1, videoRef.current.currentTime / d);
        } else {
          progRef.current = Math.min(1, progRef.current + (now - lastRef.current) / IMAGE_MS);
        }
        setProgress(progRef.current);
        if (progRef.current >= 1) { next(); return; }
      }
      lastRef.current = now;
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(rafRef.current); };
  }, [idx, isVideo, next]);

  // Keep the <video> element's play state in lock-step with `paused`/`muted`.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = muted;
    if (paused) v.pause();
    else v.play?.().catch(() => { /* autoplay race — harmless */ });
  }, [paused, muted, idx]);

  // ── keyboard ─────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === ' ') { e.preventDefault(); setPaused((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, next, prev]);

  // ── per-story insights, on demand + cached ───────────────────────────
  // The effect deps are only [story?.id], so it can't read the latest `insights`
  // without a stale closure. A ref-backed set of ids that have already started
  // loading is the source of truth for "already in flight / done", so advancing
  // through stories never refetches an id (and never refetches because a sibling
  // story's fetch resolved and re-rendered). The state map still drives render.
  const requestedRef = useRef(new Set());
  useEffect(() => {
    const id = story?.id;
    if (!id || requestedRef.current.has(id)) return;
    requestedRef.current.add(id);
    setInsights((m) => ({ ...m, [id]: { loading: true, rows: [], error: null } }));
    supabase.functions.invoke('meta-social', { body: { mediaInsights: { mediaId: id, story: true } } })
      .then(({ data, error }) => {
        setInsights((m) => ({
          ...m,
          [id]: data?.ok
            ? { loading: false, rows: resolveMediaInsights(data.metrics), error: null }
            : { loading: false, rows: [], error: data?.error || error?.message || 'sin datos' },
        }));
      })
      .catch(() => {
        // A network reject still resolves the cell so it doesn't spin forever;
        // it stays in `requested` so we don't hammer a failing id on every nav.
        setInsights((m) => ({ ...m, [id]: { loading: false, rows: [], error: 'sin datos' } }));
      });
  }, [story?.id]);

  // ── tap vs hold-to-pause on the media ────────────────────────────────
  const holdRef = useRef({ t: 0, held: false });
  const onDown = useCallback(() => {
    holdRef.current = { t: Date.now(), held: false };
    holdRef.current.timer = setTimeout(() => { holdRef.current.held = true; setPaused(true); }, 220);
  }, []);
  const onUp = useCallback((e) => {
    clearTimeout(holdRef.current.timer);
    if (holdRef.current.held) { setPaused(false); return; }
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX ?? r.left + r.width / 2) - r.left;
    if (x < r.width * 0.32) prev(); else next();
  }, [prev, next]);

  if (!story) return null;
  const ins = insights[story.id] || null;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/90 [padding:env(safe-area-inset-top,0px)_0_env(safe-area-inset-bottom,0px)]" role="dialog" aria-modal="true" aria-label="Historias">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Cerrar" onClick={close} />

      {/* desktop side arrows */}
      {idx > 0 && (
        <button type="button" onClick={prev} aria-label="Anterior" className="absolute left-2 z-10 hidden h-11 w-11 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20 sm:grid"><ChevronLeft size={22} /></button>
      )}
      {idx < stories.length - 1 && (
        <button type="button" onClick={next} aria-label="Siguiente" className="absolute right-2 z-10 hidden h-11 w-11 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20 sm:grid"><ChevronRight size={22} /></button>
      )}

      {/* the 9:16 stage */}
      <div className="relative z-[1] flex aspect-[9/16] max-h-[94vh] w-auto max-w-[min(440px,96vw)] flex-col overflow-hidden rounded-xl bg-black shadow-2xl">
        {/* progress segments */}
        <div className="absolute inset-x-2 top-2 z-20 flex gap-1">
          {stories.map((s, i) => (
            <div key={s.id || i} className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/30">
              <div className="h-full rounded-full bg-white" style={{ width: `${i < idx ? 100 : i === idx ? progress * 100 : 0}%`, transition: i === idx ? 'none' : undefined }} />
            </div>
          ))}
        </div>

        {/* header */}
        <div className="absolute inset-x-0 top-4 z-20 flex items-center gap-2 px-3 pt-1 [background:linear-gradient(to_bottom,rgba(0,0,0,0.5),transparent)]">
          <div className="h-7 w-7 overflow-hidden rounded-full ring-1 ring-white/40">
            {profile?.avatarUrl ? <img src={profile.avatarUrl} alt="" className="h-full w-full object-cover" /> : <div className="h-full w-full bg-white/20" />}
          </div>
          <span className="text-sm font-medium text-white drop-shadow">{profile?.username ? `@${profile.username}` : 'Historia'}</span>
          <span className="text-xs text-white/70">{story.ago}</span>
          <div className="ml-auto flex items-center gap-1">
            {paused && <Pause size={15} className="text-white/80" />}
            {isVideo && (
              <button type="button" onClick={() => setMuted((m) => !m)} aria-label={muted ? 'Activar sonido' : 'Silenciar'} className="grid h-8 w-8 place-items-center rounded-full text-white hover:bg-white/15">
                {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
              </button>
            )}
            <button type="button" onClick={close} aria-label="Cerrar" className="grid h-8 w-8 place-items-center rounded-full text-white hover:bg-white/15"><X size={18} /></button>
          </div>
        </div>

        {/* media + tap surface */}
        <div className="relative flex-1 select-none" onPointerDown={onDown} onPointerUp={onUp} onPointerLeave={() => { clearTimeout(holdRef.current.timer); if (holdRef.current.held) { holdRef.current.held = false; setPaused(false); } }}>
          {isVideo ? (
            <video ref={videoRef} key={story.id} src={story.url || undefined} poster={story.thumb || undefined} className="h-full w-full object-contain" autoPlay muted={muted} playsInline onEnded={next} />
          ) : (
            <img src={story.url || story.thumb || undefined} alt="" className="h-full w-full object-contain" draggable={false} />
          )}
        </div>

        {/* insights footer */}
        <div className="absolute inset-x-0 bottom-0 z-20 flex items-center gap-4 px-4 pb-3 pt-6 [background:linear-gradient(to_top,rgba(0,0,0,0.6),transparent)]">
          {ins?.loading && <span className="text-xs text-white/60">Cargando estadísticas…</span>}
          {ins && !ins.loading && ins.rows.length === 0 && <span className="text-xs text-white/50">{ins.error ? '' : 'Sin estadísticas todavía'}</span>}
          {ins?.rows?.map((r) => {
            const Icon = METRIC_ICON[r.key] || Eye;
            return (
              <span key={r.key} className="inline-flex items-center gap-1.5 text-sm text-white" title={r.label}>
                <Icon size={15} className="text-white/70" />
                <span className="tabular-nums font-medium">{fmt(r.value)}{r.unit ? ` ${r.unit}` : ''}</span>
                <span className="text-xs text-white/60">{r.label.toLowerCase()}</span>
              </span>
            );
          })}
          {story.permalink && (
            <a href={story.permalink} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="ml-auto inline-flex items-center gap-1 text-xs text-white/80 hover:text-white">
              <ExternalLink size={13} /> Instagram
            </a>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
