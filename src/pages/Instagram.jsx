// Instagram — ONE sectioned command center for the whole Meta surface (replaces
// the old Marketing/Studio split AND the crammed 3-column board). It fires the
// two meta-social reads in parallel — `snapshot` (comments, ad campaigns, recent
// posts) and `igStudio` (profile, 28-day KPIs, audience, best-time, content grid,
// stories, mentions) — and lays them out as a NO-SCROLL, swipeable board deck:
//   • a compact header (account + live pill + Publicar / Anuncios), then
//   • a segmented navigator — Resumen · Contenido · Audiencia · Interacción —
//     over a viewport-locked deck where each section is ONE focused board you
//     reach by tapping a tab or swiping. The page never scrolls; only a board's
//     own body does. The lock height is measured (the page lives INSIDE the app
//     shell, so it can't own 100dvh like JARVIS does).
// Tokens never reach the browser; every read/action goes through the Edge
// Function. `/marketing` and `/instagram-studio` both route here (old links).
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { Link } from 'react-router-dom';
import {
  Instagram as InstagramIcon, RefreshCw,
  Gauge, LayoutGrid, Megaphone, Users, MessageCircle,
} from 'lucide-react';
import ImageView from '../components/ImageView.tsx';
import Modal from '../components/Modal.jsx';
import { useApp } from '../context/AppContext.jsx';
import { supabase } from '../db/supabaseClient.js';
import { resolveSocialPulse, resolveIgStudio } from '../core/jarvis/index.js';
import { LivePill, freshLabel, fmt } from '../components/instagram/chrome.jsx';
import Overview from '../components/instagram/Overview.jsx';
import AudienceCard from '../components/instagram/AudienceCard.jsx';
import BestTimeCard from '../components/instagram/BestTimeCard.jsx';
import ContentGrid from '../components/instagram/ContentGrid.jsx';
import EngagementPanel from '../components/instagram/EngagementPanel.jsx';
import ComposerCard from '../components/instagram/ComposerCard.jsx';
import CampaignsCard from '../components/instagram/CampaignsCard.jsx';
import AdsManager from '../components/instagram/AdsManager.jsx';

// Settle one meta-social result into { raw } or { error }. okGuard flags a 200
// body that still carries a failure (e.g. { configured:false } / { ok:false }).
function pick(res, okGuard) {
  if (res.status !== 'fulfilled') return { error: res.reason?.message || 'sin respuesta' };
  const { data, error } = res.value;
  if (error) return { error: error.message || 'sin respuesta' };
  if (!data || okGuard(data)) return { error: data?.error || 'sin respuesta' };
  return { raw: data };
}

export default function Instagram() {
  const { settings } = useApp();
  const linked = !!settings?.metaSocialConnectedAt;
  const username = settings?.metaSocialIgUsername;

  // Two independent reads, kept apart so one failing never blanks the other.
  const [snap, setSnap] = useState({ raw: null, error: null, at: null });
  const [stud, setStud] = useState({ raw: null, error: null, at: null });
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    const [snapRes, studRes] = await Promise.allSettled([
      supabase.functions.invoke('meta-social', { body: { snapshot: true } }),
      supabase.functions.invoke('meta-social', { body: { igStudio: true } }),
    ]);
    const s = pick(snapRes, (d) => d.configured === false || d.error);
    setSnap((prev) => (s.raw ? { raw: s.raw, error: null, at: Date.now() } : { ...prev, error: s.error }));
    const t = pick(studRes, (d) => d.ok === false || d.error);
    setStud((prev) => (t.raw ? { raw: t.raw, error: null, at: Date.now() } : { ...prev, error: t.error }));
    busy.current = false;
    setLoading(false);
  }, []);

  // Live data: load on mount, poll every 45 s while visible, refetch on return.
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

  // 1-second clock so the freshness label ticks between polls (paused hidden).
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') setNowTick(Date.now()); }, 1000);
    return () => clearInterval(id);
  }, []);

  const sp = useMemo(() => (snap.raw ? resolveSocialPulse(snap.raw) : null), [snap.raw]);
  const st = useMemo(() => (stud.raw ? resolveIgStudio(stud.raw) : null), [stud.raw]);

  const [composerOpen, setComposerOpen] = useState(false);
  const [adsOpen, setAdsOpen] = useState(false);

  const anyData = !!(sp || st);
  const bothError = !!snap.error && !!stud.error;
  const loadedAt = Math.max(snap.at || 0, stud.at || 0) || null;
  const error = snap.error || stud.error;

  // ── sections — Contenido + Audiencia need igStudio; the rest fall back to
  // socialPulse, so the deck only offers boards it can actually fill. ──────
  const sections = useMemo(() => {
    const list = [{ id: 'resumen', label: 'Resumen', icon: Gauge }];
    if (st) list.push({ id: 'contenido', label: 'Contenido', icon: LayoutGrid });
    if (sp) list.push({ id: 'anuncios', label: 'Anuncios', icon: Megaphone });
    if (st) list.push({ id: 'audiencia', label: 'Audiencia', icon: Users });
    list.push({ id: 'interaccion', label: 'Interacción', icon: MessageCircle });
    return list;
  }, [st, sp]);

  // ── the swipe/tap board deck ─────────────────────────────────────────
  const deckRef = useRef(null);
  const [active, setActive] = useState(0);
  // While a tap-driven smooth scroll animates, suppress the observer so the
  // active tab doesn't strobe through every board it passes over.
  const suppressUntil = useRef(0);
  const goToSection = useCallback((i) => {
    const deck = deckRef.current;
    setActive(i);
    suppressUntil.current = Date.now() + 600;
    if (deck) deck.scrollTo({ left: i * deck.clientWidth, behavior: 'smooth' });
  }, []);
  // Keep the active tab synced to whichever board is centered (robust to swipe).
  useEffect(() => {
    const deck = deckRef.current;
    if (!deck || !anyData) return undefined;
    const boards = Array.from(deck.children);
    const io = new IntersectionObserver(
      (entries) => {
        if (Date.now() < suppressUntil.current) return; // let a tap-scroll settle
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= 0.55) {
            const i = boards.indexOf(e.target);
            if (i >= 0) setActive(i);
          }
        }
      },
      { root: deck, threshold: [0.55] },
    );
    boards.forEach((b) => io.observe(b));
    return () => io.disconnect();
  }, [anyData, sections.length]);
  // If sections shrink under the cursor (igStudio drops out), clamp to the
  // last surviving section rather than bouncing all the way to Resumen.
  useEffect(() => {
    if (active > sections.length - 1) goToSection(sections.length - 1);
  }, [sections.length, active, goToSection]);
  const goToId = useCallback((id) => {
    const i = sections.findIndex((s) => s.id === id);
    if (i >= 0) goToSection(i);
  }, [sections, goToSection]);
  const goInteraccion = useCallback(() => goToId('interaccion'), [goToId]);
  const goContenido = useCallback(() => goToId('contenido'), [goToId]);

  // ── viewport lock — measure the room below the app-shell chrome so the
  // page fills it exactly and never scrolls (works on mobile too, where a
  // sticky topbar sits above us; JARVIS could hard-code 100dvh, we can't). ─
  const shellRef = useRef(null);
  const [shellH, setShellH] = useState(null);
  useLayoutEffect(() => {
    if (!linked) return undefined;
    const measure = () => {
      const el = shellRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      // Sum the bottom padding of every wrapper between the shell and the app
      // scroll container (<main>): the shell sits at the end of those padded
      // wrappers, so their bottom padding is the real gap beneath it. (The
      // immediate parent is an unpadded max-w wrapper — the inset lives on the
      // grandparent, so reading only the parent under-counts and overshoots.)
      let pb = 0;
      const mainEl = el.closest('main');
      for (let node = el.parentElement; node; node = node.parentElement) {
        pb += parseFloat(getComputedStyle(node).paddingBottom) || 0;
        if (node === mainEl) break;
      }
      setShellH(Math.max(320, Math.round(window.innerHeight - top - pb)));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [linked, anyData]);

  if (!linked) {
    return (
      <>
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 pb-4">
          <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">Instagram</h1>
          <Link to="/settings" className="btn-brand"><InstagramIcon size={14} /> Conectar Instagram</Link>
        </header>
        <div className="card card-pad text-sm text-ink-500">
          Conecta tu cuenta de Instagram profesional en{' '}
          <Link to="/settings" className="text-brand-700 hover:underline">Configuración → Instagram</Link>{' '}
          para publicar, programar, responder comentarios y ver estadísticas desde aquí.
        </div>
      </>
    );
  }

  return (
    <>
      <div
        ref={shellRef}
        className="flex flex-col overflow-hidden"
        style={shellH ? { height: `${shellH}px` } : undefined}
      >
        {/* Header — compact identity + live pill + the two primary actions. */}
        <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 pb-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-ink-100 ring-2 ring-brand-200">
              <ImageView id={null} fallbackUrl={st?.profile?.avatarUrl} alt="" className="h-full w-full object-cover" placeholderClassName="h-full w-full" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate font-display text-lg font-semibold leading-tight tracking-tight sm:text-xl">{st?.profile?.name || 'Instagram'}</h1>
              <p className="truncate text-xs text-ink-500 sm:text-sm">
                {username ? `@${username}` : 'Instagram'}
                {st?.profile?.followers != null ? ` · ${fmt(st.profile.followers)} seguidores` : ''}
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <LivePill loading={loading} hasData={anyData} error={error} sinceLabel={freshLabel(loadedAt, nowTick)} onRefresh={load} />
          </div>
        </header>

        {/* Section navigator — the primary control on desktop (the deck's
            indicator + jump). Tap to go, or swipe the boards below. On phones
            this top control gives way to the bottom bar (see below), which is
            the thumb-reachable switcher. */}
        {anyData && (
          <nav className="mb-3 hidden shrink-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:block" aria-label="Secciones de Instagram">
            <div className="inline-flex min-w-full rounded-full border border-ink-200 bg-ink-100 p-1 text-sm" role="tablist">
              {sections.map((sec, i) => {
                const on = active === i;
                return (
                  <button
                    key={sec.id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => goToSection(i)}
                    className={`flex-1 whitespace-nowrap rounded-full px-4 py-1.5 font-medium transition-colors ${on ? 'bg-surface text-brand-700 shadow-sm ring-1 ring-black/5' : 'text-ink-500 hover:text-ink-800'}`}
                  >
                    {sec.label}
                  </button>
                );
              })}
            </div>
          </nav>
        )}

        {!anyData ? (
          bothError ? (
            <div className="card card-pad text-sm">
              <div className="text-red-600">{error}</div>
              <div className="mt-1 text-xs text-ink-400">Reintentando automáticamente…</div>
              <button type="button" className="btn-brand mt-3" onClick={load}><RefreshCw size={14} /> Reintentar ahora</button>
            </div>
          ) : (
            <div className="card card-pad text-sm text-ink-400">Leyendo Instagram…</div>
          )
        ) : (
          <div
            ref={deckRef}
            className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden scroll-smooth [overscroll-behavior:contain] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {sections.map((sec) => (
              <section
                key={sec.id}
                className="min-w-0 h-full shrink-0 basis-full snap-start overflow-y-auto overscroll-contain pb-4 [scroll-snap-stop:always]"
                aria-label={sec.label}
              >
                {sec.id === 'resumen' && (
                  <Overview st={st} sp={sp} onGoToInteraccion={goInteraccion} onGoToContenido={goContenido} />
                )}
                {sec.id === 'contenido' && st && (
                  <div className="h-full">
                    <ContentGrid grid={st.grid} mentions={st.mentions} stories={st.stories} profile={st.profile} />
                  </div>
                )}
                {sec.id === 'anuncios' && (
                  <div className="mx-auto h-full max-w-3xl lg:max-w-none">
                    <CampaignsCard
                      campaigns={sp?.campaigns || []}
                      adCurrency={sp?.adCurrency}
                      spend7={sp?.kpis?.spend7}
                      hasAds={!!sp?.hasAds}
                      onChanged={load}
                      onPublish={() => setComposerOpen(true)}
                      onCreateAd={() => setAdsOpen(true)}
                    />
                  </div>
                )}
                {sec.id === 'audiencia' && st && (
                  <div className="grid gap-4 lg:grid-cols-2">
                    <AudienceCard audience={st.audience} errors={st.errors} />
                    <BestTimeCard bestTimes={st.bestTimes} />
                  </div>
                )}
                {sec.id === 'interaccion' && (
                  <div className="mx-auto h-full max-w-2xl lg:max-w-none">
                    <EngagementPanel
                      comments={sp?.recentComments || []}
                      campaigns={sp?.campaigns || []}
                      hasAds={!!sp?.hasAds}
                      adCurrency={sp?.adCurrency}
                      spend7={sp?.kpis?.spend7}
                      posts={sp?.posts || []}
                      onChanged={load}
                      onOpenAds={() => setAdsOpen(true)}
                    />
                  </div>
                )}
              </section>
            ))}
          </div>
        )}

        {st && Object.keys(st.errors).length > 0 && active === 0 && (
          <div className="shrink-0 pt-1 text-xs text-amber-700">
            Secciones sin respuesta: {Object.keys(st.errors).join(', ')} — el resto es dato real.
          </div>
        )}

        {/* Mobile bottom bar — the thumb-reachable section switcher. Lives at
            the foot of the height-locked shell (which already ends above the
            home indicator, since <main>'s bottom inset is excluded from the
            measured height), so it reads as a native bottom tab bar without
            covering content. Desktop uses the top segmented navigator instead. */}
        {anyData && (
          <nav
            className="mt-2 grid shrink-0 grid-flow-col auto-cols-fr gap-1 rounded-2xl border border-ink-200 bg-surface p-1 shadow-sm md:hidden"
            role="tablist"
            aria-label="Secciones de Instagram"
          >
            {sections.map((sec, i) => {
              const on = active === i;
              const Icon = sec.icon;
              return (
                <button
                  key={sec.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => goToSection(i)}
                  className={`flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1.5 text-[10px] font-medium transition-colors ${
                    on ? 'bg-brand-50 text-brand-700' : 'text-ink-400 hover:text-ink-700'
                  }`}
                >
                  <Icon size={18} className="shrink-0" />
                  <span className="max-w-full truncate leading-none">{sec.label}</span>
                </button>
              );
            })}
          </nav>
        )}
      </div>

      <Modal open={composerOpen} onClose={() => setComposerOpen(false)} title="Publicar en Instagram" size="lg">
        <ComposerCard publishLimit={st?.publishLimit} onPublished={load} />
      </Modal>

      <Modal open={adsOpen} onClose={() => setAdsOpen(false)} title="Anuncios de Instagram" size="xl">
        <AdsManager onChanged={load} />
      </Modal>
    </>
  );
}
