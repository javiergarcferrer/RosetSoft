// Instagram — ONE command-center screen for the whole Meta surface (replaces
// the old Marketing/Studio tab split). It fires the two meta-social reads in
// parallel — `snapshot` (comments, ad campaigns, recent posts) and `igStudio`
// (profile, 28-day KPIs, audience, best-time, content grid, stories, mentions)
// — and lays them out as an interactive dashboard:
//   • header: the connected account + a single live pill + a "Publicar" button
//     that opens the composer in a modal (no more wasted half-screen).
//   • KPI row → content grid (click a post for insights) beside an interactive
//     rail that switches Comentarios / Campañas / Actividad → audience + best-time.
// Tokens never reach the browser; every read/action goes through the Edge
// Function. `/marketing` and `/instagram-studio` both route here (old links).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Instagram as InstagramIcon, Megaphone, Plus, RefreshCw } from 'lucide-react';
import ImageView from '../components/ImageView.tsx';
import Modal from '../components/Modal.jsx';
import { useApp } from '../context/AppContext.jsx';
import { supabase } from '../db/supabaseClient.js';
import { resolveSocialPulse, resolveIgStudio } from '../core/jarvis/index.js';
import { Stat, LivePill, freshLabel, fmt, pctFmt } from '../components/instagram/chrome.jsx';
import AudienceCard from '../components/instagram/AudienceCard.jsx';
import BestTimeCard from '../components/instagram/BestTimeCard.jsx';
import ContentGrid from '../components/instagram/ContentGrid.jsx';
import EngagementPanel from '../components/instagram/EngagementPanel.jsx';
import ComposerCard from '../components/instagram/ComposerCard.jsx';
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

  if (!linked) {
    return (
      <>
        <header className="mb-5 pb-4 border-b border-ink-100 flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight">Instagram</h1>
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
      {/* Command board — a viewport-height cockpit on lg+ (the page itself never
          scrolls; each region scrolls inside its own panel), folding back to a
          natural stacked flow below lg where scrolling a phone is expected. The
          height subtracts only <main>'s md:py-6 padding (3rem); the header + KPI
          strip are flex rows inside, so the board fills whatever's left. */}
      <div className="lg:flex lg:flex-col lg:h-[calc(100dvh-3rem)] lg:overflow-hidden">
        <header className="lg:shrink-0 mb-4 pb-4 border-b border-ink-100">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full ring-2 ring-brand-200 bg-ink-100">
                <ImageView id={null} fallbackUrl={st?.profile?.avatarUrl} alt="" className="h-full w-full object-cover" placeholderClassName="h-full w-full" />
              </div>
              <div className="min-w-0">
                <h1 className="font-display text-xl sm:text-2xl font-semibold tracking-tight leading-tight truncate">{st?.profile?.name || 'Instagram'}</h1>
                <p className="text-sm text-ink-500 leading-snug truncate">
                  {username ? `@${username}` : 'Instagram'}
                  {st?.profile?.followers != null ? ` · ${fmt(st.profile.followers)} seguidores` : ''}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <LivePill loading={loading} hasData={anyData} error={error} sinceLabel={freshLabel(loadedAt, nowTick)} onRefresh={load} />
              <button type="button" className="btn-secondary" onClick={() => setAdsOpen(true)}>
                <Megaphone size={15} /> Anuncios
              </button>
              <button type="button" className="btn-brand" onClick={() => setComposerOpen(true)}>
                <Plus size={15} /> Publicar
              </button>
            </div>
          </div>
        </header>

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
          <div className="space-y-4 lg:space-y-0 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:gap-4">
            {/* KPI strip — pinned at the top of the board (28-day figures from
                igStudio, snapshot's 7-day as fallback) */}
            {st ? (
              <div className="grid gap-3 grid-cols-2 lg:shrink-0 lg:grid-cols-4">
                <Stat label="Seguidores" value={fmt(st.profile.followers)} sub={`${fmt(st.profile.mediaCount)} publicaciones`} />
                <Stat label="Alcance · 28d" value={fmt(st.kpis.reach28)} sub={st.kpis.hasReachSplit ? `${st.kpis.followerReachPct}% seguidores` : 'cuentas alcanzadas'} />
                <Stat label="Interacciones · 28d" value={st.kpis.interactions28 != null ? fmt(st.kpis.interactions28) : '—'} sub={`tasa ${pctFmt(st.kpis.engagementRatePct)}`} />
                <Stat label="Toques al perfil · 28d" value={st.kpis.profileTaps28 != null ? fmt(st.kpis.profileTaps28) : '—'} sub="enlaces y botones" />
              </div>
            ) : sp ? (
              <div className="grid gap-3 grid-cols-2 lg:shrink-0 lg:grid-cols-4">
                <Stat label="Seguidores IG" value={fmt(sp.kpis.igFollowers ?? 0)} sub={`${sp.kpis.newFollowers7 >= 0 ? '+' : ''}${fmt(sp.kpis.newFollowers7)} · 7d`} />
                <Stat label="Alcance IG · 7d" value={fmt(sp.kpis.reach7)} sub="cuentas alcanzadas" />
                <Stat label="Acciones perfil · 7d" value={fmt(sp.kpis.profileActions7)} sub="enlaces y botones" />
                <Stat label="Comentarios" value={fmt(sp.recentComments.length)} sub="para responder" />
              </div>
            ) : null}

            {/* Board: Contenido · Interacción · Analítica — three columns that
                fill the remaining height and each scroll independently on lg, so
                the whole command center stays on one screen. Below lg they stack
                (single-column grid) and the page flows normally. When igStudio is
                missing (snapshot-only) there's no analytics, so content + rail
                widen to fill the row. */}
            <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-12">
              <div className={`min-w-0 lg:min-h-0 ${st ? 'lg:col-span-5' : 'lg:col-span-7'}`}>
                {st ? (
                  <ContentGrid grid={st.grid} mentions={st.mentions} stories={st.stories} />
                ) : (
                  <div className="card card-pad text-sm text-ink-400 lg:h-full">Cargando contenido…</div>
                )}
              </div>
              <div className={`min-w-0 lg:min-h-0 ${st ? 'lg:col-span-3' : 'lg:col-span-5'}`}>
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
              {st && (
                <div className="min-w-0 lg:col-span-4 lg:min-h-0">
                  {/* Analytics stack — audience + best-time, scrolling as one
                      inside the column if together they outrun the board height. */}
                  <div className="space-y-4 lg:h-full lg:space-y-4 lg:overflow-y-auto lg:pr-0.5">
                    <AudienceCard audience={st.audience} errors={st.errors} />
                    <BestTimeCard bestTimes={st.bestTimes} />
                  </div>
                </div>
              )}
            </div>

            {st && Object.keys(st.errors).length > 0 && (
              <div className="text-xs text-amber-700 lg:shrink-0">
                Secciones sin respuesta: {Object.keys(st.errors).join(', ')} — el resto es dato real.
              </div>
            )}
          </div>
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
