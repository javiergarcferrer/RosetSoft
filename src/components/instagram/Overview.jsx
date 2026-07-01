// Resumen — the Instagram command center's headline section: the "how is the
// account doing right now" view that the old crammed board never had. It
// composes the two reads (igStudio `st` + socialPulse `sp`) into a calm bento:
// a hero KPI row, the 28-day reach trend with its follower/discovery split,
// the top posts by engagement, the best publishing window, and the freshest
// comments to triage — each a glance, detail one tap away in its own section.
import { memo } from 'react';
import { Link } from 'react-router-dom';
import {
  Heart, MessageCircle, Clock, TrendingUp, ArrowRight, Film, Gauge,
} from 'lucide-react';
import ImageView from '../ImageView.tsx';
import { Sparkline } from '../charts/MiniCharts.jsx';
import { Stat, fmt, pctFmt } from './chrome.jsx';

// A top-post chip — thumbnail + its engagement, links out to the post.
function TopPost({ post }) {
  return (
    <a
      href={post.permalink || '#'}
      target="_blank"
      rel="noreferrer"
      className="group flex items-center gap-3 rounded-lg p-1.5 transition-colors hover:bg-ink-50"
      title={post.excerpt || post.type}
    >
      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md bg-ink-100">
        <ImageView id={null} fallbackUrl={post.thumb} alt={post.excerpt} className="h-full w-full object-cover" placeholderClassName="h-full w-full" />
        {post.isReel && <Film size={11} className="absolute right-1 top-1 text-white drop-shadow" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-ink-700">{post.excerpt || (post.isReel ? 'Reel' : 'Publicación')}</div>
        <div className="mt-0.5 flex items-center gap-3 text-xs text-ink-400">
          <span className="inline-flex items-center gap-1 tabular-nums"><Heart size={11} /> {fmt(post.likes)}</span>
          <span className="inline-flex items-center gap-1 tabular-nums"><MessageCircle size={11} /> {fmt(post.comments)}</span>
          <span className="ml-auto">{post.ago}</span>
        </div>
      </div>
    </a>
  );
}

// Benchmark-band chip colors (furniture/home is a low-engagement vertical, so
// "Bajo" is amber-informational, not red-alarming).
const BAND_CHIP = {
  exceptional: 'bg-emerald-100 text-emerald-800',
  strong: 'bg-emerald-100 text-emerald-800',
  average: 'bg-ink-100 text-ink-700',
  low: 'bg-amber-100 text-amber-800',
  unknown: 'bg-ink-100 text-ink-500',
};

// One labeled figure row in the Rendimiento card. Guards null → "—".
function KpiRow({ label, value, chip, chipBand }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-ink-500">{label}</span>
      <span className="flex items-center gap-2">
        {chip && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${BAND_CHIP[chipBand] || BAND_CHIP.unknown}`}>{chip}</span>}
        <span className="font-medium tabular-nums text-ink-900">{value}</span>
      </span>
    </div>
  );
}

const asPct = (n) => (n != null ? pctFmt(n) : '—');

// Memoized: the page re-renders every second to tick the live-freshness pill;
// the overview's data only changes on an actual load, so skip those ticks.
function Overview({ st, sp, kpis, onGoToInteraccion, onGoToContenido }) {
  // Prefer igStudio's richer 28-day KPIs; fall back to socialPulse's 7-day.
  const followers = st?.profile.followers ?? sp?.kpis.igFollowers ?? 0;
  const reach28 = st?.kpis.reach28 ?? null;
  const reachSeries = st?.reachSeries || [];
  const split = st?.kpis.hasReachSplit
    ? { fol: st.kpis.followerReach, non: st.kpis.nonFollowerReach, pct: st.kpis.followerReachPct }
    : null;
  const peak = st?.bestTimes?.peak || null;
  const comments = sp?.recentComments || [];
  const topPosts = st?.topPosts || [];

  return (
    <div className="space-y-4">
      {/* Hero KPI row — the material figures, biggest type on the board. */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="Seguidores" value={fmt(followers)} sub={st ? `${fmt(st.profile.mediaCount)} publicaciones` : 'cuenta'} />
        <Stat label="Alcance · 28d" value={reach28 != null ? fmt(reach28) : fmt(sp?.kpis.reach7 ?? 0)} sub={reach28 != null ? 'cuentas alcanzadas' : '7 días'} />
        <Stat
          label="Interacciones · 28d"
          value={st?.kpis.interactions28 != null ? fmt(st.kpis.interactions28) : '—'}
          sub={st?.kpis.engagementRatePct != null ? `tasa ${pctFmt(st.kpis.engagementRatePct)}` : 'me gusta · comentarios · guardados'}
        />
        <Stat label="Toques al perfil · 28d" value={st?.kpis.profileTaps28 != null ? fmt(st.kpis.profileTaps28) : '—'} sub="enlaces y botones" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Reach trend + discovery split */}
        <div className="card card-pad lg:col-span-2">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm font-medium"><TrendingUp size={15} /> Alcance diario · 28 días</span>
            {reach28 != null && <span className="text-xs text-ink-400 tabular-nums">{fmt(reach28)} total</span>}
          </div>
          {reachSeries.length > 1 ? (
            <div className="mt-3 text-brand-600">
              <Sparkline points={reachSeries} color="currentColor" height={56} />
            </div>
          ) : (
            <div className="mt-3 text-sm text-ink-400">Aún no hay suficiente historial de alcance.</div>
          )}
          {split && (
            <div className="mt-3">
              <div className="flex h-2 overflow-hidden rounded-full bg-ink-100">
                <div className="bg-brand-500" style={{ width: `${split.pct}%` }} title={`Seguidores ${fmt(split.fol)}`} />
                <div className="bg-ink-300" style={{ width: `${100 - split.pct}%` }} title={`Descubrimiento ${fmt(split.non)}`} />
              </div>
              <div className="mt-1.5 flex items-center justify-between text-xs text-ink-500">
                <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-brand-500" /> Seguidores {split.pct}%</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-ink-300" /> Descubrimiento {100 - split.pct}%</span>
              </div>
            </div>
          )}
        </div>

        {/* Best window + publish quota */}
        <div className="card card-pad">
          <span className="flex items-center gap-2 text-sm font-medium"><Clock size={15} /> Mejor ventana</span>
          {peak ? (
            <>
              <div className="mt-2 font-display text-2xl font-semibold tabular-nums text-ink-900">{peak.label}</div>
              <div className="text-xs text-ink-400">por interacciones · hora local</div>
            </>
          ) : (
            <div className="mt-2 text-sm text-ink-400">Publica algunas veces y verás tu mejor hora aquí.</div>
          )}
          {st?.publishLimit?.remaining != null && (
            <div className="mt-3 border-t border-ink-100 pt-3 text-xs text-ink-500">
              Cuota de publicación: <span className="font-medium tabular-nums text-ink-800">{st.publishLimit.remaining}</span> de {st.publishLimit.total} disponibles hoy
            </div>
          )}
        </div>

        {/* Rendimiento — the derived business KPIs (how am I doing vs. the sector). */}
        <div className="card card-pad">
          <span className="flex items-center gap-2 text-sm font-medium"><Gauge size={15} /> Rendimiento · 28 días</span>
          {kpis?.hasData ? (
            <div className="mt-2.5 space-y-2 text-sm">
              <KpiRow
                label="Interacción / seguidores"
                value={asPct(kpis.engagementRateByFollowersPct)}
                chip={kpis.engagementRateByFollowersPct != null ? kpis.engagementBenchmark.label : null}
                chipBand={kpis.engagementBenchmark.band}
              />
              <KpiRow label="Interacción / alcance" value={asPct(kpis.engagementRateByReachPct)} />
              <KpiRow label="Tasa de alcance" value={asPct(kpis.reachRatePct)} />
              {kpis.discoveryPct != null && <KpiRow label="Descubrimiento (no seguidores)" value={asPct(kpis.discoveryPct)} />}
              {kpis.bestFormat && (
                <KpiRow label="Mejor formato" value={kpis.bestFormat} />
              )}
            </div>
          ) : (
            <div className="mt-2 text-sm text-ink-400">Las métricas aparecen tras el primer periodo con datos.</div>
          )}
        </div>

        {/* Top posts */}
        <div className="card lg:col-span-2">
          <div className="card-header">
            <span className="text-sm font-medium">Mejores publicaciones</span>
            {onGoToContenido && (
              <button type="button" className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline" onClick={onGoToContenido}>
                Ver contenido <ArrowRight size={12} />
              </button>
            )}
          </div>
          <div className="card-pad pt-2">
            {topPosts.length === 0 ? (
              <div className="text-sm text-ink-400">Sin publicaciones todavía.</div>
            ) : (
              <div className="space-y-1">{topPosts.map((p) => <TopPost key={p.id} post={p} />)}</div>
            )}
          </div>
        </div>

        {/* Comments to triage */}
        <div className="card">
          <div className="card-header">
            <span className="flex items-center gap-2 text-sm font-medium"><MessageCircle size={15} /> Para responder</span>
            {comments.length > 0 && onGoToInteraccion && (
              <button type="button" className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline" onClick={onGoToInteraccion}>
                Todos <ArrowRight size={12} />
              </button>
            )}
          </div>
          <div className="card-pad pt-2">
            {comments.length === 0 ? (
              <div className="text-sm text-ink-400">Sin comentarios recientes.</div>
            ) : (
              <div className="space-y-2.5">
                {comments.slice(0, 4).map((c) => (
                  <button
                    key={c.id || `${c.username}-${c.at}`}
                    type="button"
                    onClick={onGoToInteraccion}
                    className="block w-full rounded-md text-left text-sm transition-colors hover:bg-ink-50"
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 truncate">
                        {c.username ? <span className="font-medium text-ink-900">@{c.username} </span> : null}
                        <span className={c.username ? 'text-ink-600' : 'text-ink-800'}>{c.text}</span>
                      </span>
                      <span className="ml-auto flex-none text-xs text-ink-400">{c.ago || ''}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <p className="text-center text-xs text-ink-400">
        ¿Buscas algo más? Usa <Link to="/settings" className="text-brand-700 hover:underline">Configuración → Instagram</Link> para la conexión y los permisos.
      </p>
    </div>
  );
}

export default memo(Overview);
