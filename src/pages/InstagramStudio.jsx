// Instagram Studio — the advanced, interactive Instagram surface. Where the
// Marketing page is a quick publisher, THIS is the studio: audience
// intelligence (demographics), a content-performance grid you click into for
// per-post insights and comment moderation, a best-time-to-post heatmap mined
// from your own engagement, live stories, a mentions wall, and hashtag
// listening. Tokens never reach the browser — every read/action goes through
// the meta-social Edge Function, projected by the core/jarvis VMs.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Instagram, RefreshCw, Send, Search, Heart, MessageCircle, Eye, EyeOff,
  Trash2, X, Clock, Film, AtSign, Sparkles, ExternalLink,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import ImageView from '../components/ImageView.tsx';
import { useApp } from '../context/AppContext.jsx';
import { supabase } from '../db/supabaseClient.js';
import {
  resolveIgStudio, resolveMediaInsights, resolveMediaComments, resolveHashtagMedia,
} from '../core/jarvis/index.js';
import { Donut, BulletBar, Sparkline, Legend } from '../components/charts/MiniCharts.jsx';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const pctFmt = (n) => (n == null ? '—' : `${n.toFixed(1)}%`);

const freshLabel = (ms, now) => {
  if (!ms) return null;
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 4) return 'ahora mismo';
  if (s < 60) return `hace ${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `hace ${min} min`;
  return `hace ${Math.round(min / 60)} h`;
};

function Stat({ label, value, sub, tone }) {
  return (
    <div className="stat-card p-4">
      <div className="text-[11px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className={`font-display text-2xl font-semibold tabular-nums mt-0.5 ${tone || 'text-ink-900'}`}>{value}</div>
      {sub && <div className="text-xs text-ink-400 mt-0.5">{sub}</div>}
    </div>
  );
}

// A ranked horizontal-bar list (age / countries / cities) — label, bar, value.
function BarList({ rows, max, accent = '#c96a2a' }) {
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <div className="w-28 shrink-0 truncate text-sm text-ink-700" title={r.label}>{r.label}</div>
          <div className="flex-1 min-w-0"><BulletBar value={r.value} max={max} color={accent} /></div>
          <div className="w-16 shrink-0 text-right tabular-nums text-xs text-ink-500">
            {r.pct != null ? `${r.pct}%` : fmt(r.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

// Best-time-to-post heatmap. Desktop renders the full 7×24 (weekday × hour);
// a phone can't fit 24 columns at a usable size, so below md it folds into the
// VM's 7×6 four-hour buckets — reduce density rather than scroll sideways.
const heatBg = (norm) => (norm > 0 ? `rgb(var(--brand-500) / ${(0.15 + norm * 0.85).toFixed(2)})` : 'rgb(var(--ink-100))');

function Heatmap({ bestTimes }) {
  const cellByKey = useMemo(() => {
    const m = new Map();
    for (const c of bestTimes.cells) m.set(`${c.day}:${c.hour}`, c);
    return m;
  }, [bestTimes]);
  const bucketByKey = useMemo(() => {
    const m = new Map();
    for (const b of bestTimes.buckets) m.set(`${b.day}:${b.bucket}`, b);
    return m;
  }, [bestTimes]);
  return (
    <>
      {/* desktop — 7×24 */}
      <div className="hidden md:block space-y-[3px]">
        {bestTimes.dayLabels.map((label, day) => (
          <div key={day} className="flex items-center gap-1.5">
            <div className="w-8 shrink-0 text-[10px] uppercase tracking-wide text-ink-400">{label}</div>
            <div className="flex gap-[2px] flex-1">
              {Array.from({ length: 24 }, (_, hour) => {
                const c = cellByKey.get(`${day}:${hour}`);
                const norm = c?.norm || 0;
                const isPeak = bestTimes.peak && bestTimes.peak.day === day && bestTimes.peak.hour === hour;
                return (
                  <div
                    key={hour}
                    className={`h-4 flex-1 rounded-[2px] ${isPeak ? 'ring-2 ring-brand-600' : ''}`}
                    style={{ backgroundColor: heatBg(norm) }}
                    title={c && c.count ? `${label} ${String(hour).padStart(2, '0')}:00 · ${c.count} post${c.count > 1 ? 's' : ''} · ${fmt(c.engagement)} interacciones` : `${label} ${String(hour).padStart(2, '0')}:00`}
                  />
                );
              })}
            </div>
          </div>
        ))}
        <div className="flex items-center gap-1.5 pl-9 text-[10px] text-ink-400">
          <span>0h</span><span className="flex-1 text-center">6h</span><span className="flex-1 text-center">12h</span><span className="flex-1 text-center">18h</span><span>23h</span>
        </div>
      </div>
      {/* mobile — 7×6 four-hour buckets */}
      <div className="md:hidden space-y-1">
        {bestTimes.dayLabels.map((label, day) => (
          <div key={day} className="flex items-center gap-1.5">
            <div className="w-8 shrink-0 text-[10px] uppercase tracking-wide text-ink-400">{label}</div>
            <div className="flex gap-1 flex-1">
              {Array.from({ length: 6 }, (_, bucket) => {
                const b = bucketByKey.get(`${day}:${bucket}`);
                const norm = b?.norm || 0;
                return (
                  <div
                    key={bucket}
                    className="h-6 flex-1 rounded-[3px]"
                    style={{ backgroundColor: heatBg(norm) }}
                    title={b && b.count ? `${label} ${bestTimes.bucketLabels[bucket]}h · ${fmt(b.engagement)} interacciones` : `${label} ${bestTimes.bucketLabels[bucket]}h`}
                  />
                );
              })}
            </div>
          </div>
        ))}
        <div className="flex gap-1 pl-9 text-[9px] text-ink-400">
          {bestTimes.bucketLabels.map((l) => <span key={l} className="flex-1 text-center">{l}</span>)}
        </div>
      </div>
    </>
  );
}

// A media tile in the content grid / mentions / discovery walls.
function MediaTile({ item, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative aspect-square overflow-hidden rounded-lg bg-ink-100 text-left"
      title={item.excerpt || item.type}
    >
      <ImageView id={null} fallbackUrl={item.thumb} alt={item.excerpt} className="h-full w-full object-cover transition-transform group-hover:scale-105" placeholderClassName="h-full w-full" />
      {item.isReel && <Film size={14} className="absolute top-1.5 right-1.5 text-white drop-shadow" />}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
        <span className="inline-flex items-center gap-1"><Heart size={11} /> {fmt(item.likes)}</span>
        <span className="inline-flex items-center gap-1"><MessageCircle size={11} /> {fmt(item.comments)}</span>
      </div>
    </button>
  );
}

export default function InstagramStudio() {
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
      const { data, error } = await supabase.functions.invoke('meta-social', { body: { igStudio: true } });
      if (error) throw new Error(error.message || 'sin respuesta');
      if (data?.ok === false || data?.error) throw new Error(data?.error || 'sin respuesta');
      setRaw(data);
      setLoadError(null);
      setLoadedAt(Date.now());
    } catch (e) {
      setLoadError(e?.message || 'No se pudo leer Instagram');
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!linked) return undefined;
    load();
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    window.addEventListener('focus', onVisible);
    return () => window.removeEventListener('focus', onVisible);
  }, [linked, load]);

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') setNowTick(Date.now()); }, 1000);
    return () => clearInterval(id);
  }, []);

  const m = useMemo(() => (raw ? resolveIgStudio(raw) : null), [raw]);

  // ── per-post drill-down ──────────────────────────────────────────────
  const [selected, setSelected] = useState(null); // grid item
  const [insights, setInsights] = useState({ loading: false, rows: [], error: null });
  const [comments, setComments] = useState({ loading: false, rows: [], error: null });

  const openPost = useCallback(async (item) => {
    setSelected(item);
    setInsights({ loading: true, rows: [], error: null });
    setComments({ loading: true, rows: [], error: null });
    const [iRes, cRes] = await Promise.all([
      supabase.functions.invoke('meta-social', { body: { mediaInsights: { mediaId: item.id, productType: item.productType } } }),
      supabase.functions.invoke('meta-social', { body: { mediaComments: { mediaId: item.id } } }),
    ]);
    const iData = iRes.data;
    setInsights(iData?.ok
      ? { loading: false, rows: resolveMediaInsights(iData.metrics), error: null }
      : { loading: false, rows: [], error: iData?.error || iRes.error?.message || 'Sin métricas' });
    const cData = cRes.data;
    setComments(cData?.ok
      ? { loading: false, rows: resolveMediaComments(cData.comments), error: null }
      : { loading: false, rows: [], error: cData?.error || cRes.error?.message || 'Sin comentarios' });
  }, []);

  // ── comment moderation (reply / hide / delete), optimistic ───────────
  const [replyId, setReplyId] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [modBusy, setModBusy] = useState(null); // comment id being acted on
  const patchComment = (id, patch) => setComments((s) => ({ ...s, rows: s.rows.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));

  const sendReply = useCallback(async (commentId) => {
    const message = replyText.trim();
    if (!message) return;
    setModBusy(commentId);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', {
        body: { replyComment: { commentId, message, platform: 'instagram' } },
      });
      if (error || !data?.ok) throw new Error(data?.error || error?.message || 'No se pudo responder');
      patchComment(commentId, { replyCount: 0 });
      setReplyId(null);
      setReplyText('');
    } catch (e) {
      patchComment(commentId, { modError: e?.message || 'Error' });
    } finally {
      setModBusy(null);
    }
  }, [replyText]);

  const toggleHide = useCallback(async (c) => {
    setModBusy(c.id);
    const next = !c.hidden;
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', {
        body: { setCommentVisibility: { commentId: c.id, hide: next } },
      });
      if (error || !data?.ok) throw new Error(data?.error || error?.message || 'No se pudo ocultar');
      patchComment(c.id, { hidden: next, modError: null });
    } catch (e) {
      patchComment(c.id, { modError: e?.message || 'Error' });
    } finally {
      setModBusy(null);
    }
  }, []);

  const removeComment = useCallback(async (c) => {
    setModBusy(c.id);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', {
        body: { deleteComment: { commentId: c.id } },
      });
      if (error || !data?.ok) throw new Error(data?.error || error?.message || 'No se pudo eliminar');
      setComments((s) => ({ ...s, rows: s.rows.filter((r) => r.id !== c.id) }));
    } catch (e) {
      patchComment(c.id, { modError: e?.message || 'Error' });
    } finally {
      setModBusy(null);
    }
  }, []);

  // ── hashtag listening ────────────────────────────────────────────────
  const [hq, setHq] = useState('');
  const [hState, setHState] = useState({ loading: false, result: null, error: null });
  const searchHashtag = useCallback(async () => {
    const q = hq.trim().replace(/^#/, '');
    if (!q || hState.loading) return;
    setHState({ loading: true, result: null, error: null });
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', { body: { hashtagSearch: { q } } });
      if (error || !data?.ok) throw new Error(data?.error || error?.message || 'Sin resultados');
      setHState({ loading: false, result: resolveHashtagMedia(data), error: null });
    } catch (e) {
      setHState({ loading: false, result: null, error: e?.message || 'Sin resultados' });
    }
  }, [hq, hState.loading]);

  const audienceMax = useMemo(() => {
    if (!m) return 1;
    return Math.max(1, ...m.audience.age.map((a) => a.value), ...m.audience.topCountries.map((c) => c.value), ...m.audience.topCities.map((c) => c.value));
  }, [m]);

  if (!linked) {
    return (
      <>
        <PageHeader title="Instagram Studio" subtitle="Sin conectar" />
        <div className="card card-pad text-sm text-ink-500">
          Conéctate primero desde <span className="font-medium">Marketing</span> (usa el usuario del sistema de
          WhatsApp). El Studio comparte esa conexión.
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Instagram Studio"
        subtitle={m?.profile.username ? `@${m.profile.username}` : 'Instagram'}
        actions={(
          <button
            type="button"
            onClick={load}
            className="group inline-flex items-center gap-2 rounded-full border border-ink-200 bg-surface px-2.5 py-1 text-xs text-ink-500 transition-colors hover:border-ink-300 hover:text-ink-800"
            title="Datos en vivo — toca para actualizar"
          >
            <span className="relative flex h-2 w-2">
              {!loadError && <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60 animate-ping" />}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${loadError ? 'bg-amber-500' : 'bg-emerald-500'}`} />
            </span>
            <span className="tabular-nums">{loading && !m ? 'Conectando…' : `En vivo${loadedAt ? ` · ${freshLabel(loadedAt, nowTick)}` : ''}`}</span>
            <RefreshCw size={12} className={`transition-opacity ${loading ? 'animate-spin opacity-90' : 'opacity-0 group-hover:opacity-60'}`} />
          </button>
        )}
      />

      {loadError && !m ? (
        <div className="card card-pad text-sm">
          <div className="text-red-600">{loadError}</div>
          <button type="button" className="btn-brand mt-3" onClick={load}><RefreshCw size={14} /> Reintentar</button>
        </div>
      ) : !m ? (
        <div className="card card-pad text-sm text-ink-400">Leyendo Instagram…</div>
      ) : (
        <div className="space-y-4">
          {/* hero — profile + KPIs */}
          <div className="card card-pad">
            <div className="flex items-center gap-4">
              <div className="h-16 w-16 shrink-0 overflow-hidden rounded-full ring-2 ring-brand-200">
                <ImageView id={null} fallbackUrl={m.profile.avatarUrl} alt={m.profile.username} className="h-full w-full object-cover" placeholderClassName="h-full w-full" />
              </div>
              <div className="min-w-0">
                <div className="font-display text-lg font-semibold text-ink-900 truncate">{m.profile.name || `@${m.profile.username}`}</div>
                <div className="text-sm text-ink-500">
                  <span className="tabular-nums font-medium text-ink-700">{fmt(m.profile.followers)}</span> seguidores ·{' '}
                  <span className="tabular-nums">{fmt(m.profile.mediaCount)}</span> publicaciones
                </div>
                {m.profile.biography && <div className="text-xs text-ink-400 truncate max-w-md mt-0.5">{m.profile.biography}</div>}
              </div>
              <div className="ml-auto hidden sm:block w-40 text-right">
                {m.reachSeries.length > 1 && (
                  <>
                    <div className="text-[11px] uppercase tracking-wider text-ink-400 mb-1">Alcance · 28d</div>
                    <Sparkline points={m.reachSeries} color="rgb(var(--brand-500))" height={34} />
                  </>
                )}
                {m.publishLimit?.remaining != null && (
                  <div className="text-[11px] text-ink-400 mt-1">{m.publishLimit.remaining}/{m.publishLimit.total} publicaciones hoy</div>
                )}
              </div>
            </div>
            <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mt-4">
              <Stat label="Alcance · 28d" value={fmt(m.kpis.reach28)} sub={m.kpis.hasReachSplit ? `${m.kpis.followerReachPct}% seguidores` : 'cuentas alcanzadas'} />
              <Stat label="Visualizaciones · 28d" value={m.kpis.views28 != null ? fmt(m.kpis.views28) : '—'} sub="impresiones" />
              <Stat label="Interacciones · 28d" value={m.kpis.interactions28 != null ? fmt(m.kpis.interactions28) : '—'} sub={`tasa ${pctFmt(m.kpis.engagementRatePct)}`} />
              <Stat label="Toques al perfil · 28d" value={m.kpis.profileTaps28 != null ? fmt(m.kpis.profileTaps28) : '—'} sub="enlaces y botones" />
            </div>
            {m.kpis.hasReachSplit && (
              <div className="mt-3">
                <div className="flex items-center justify-between text-xs text-ink-500 mb-1">
                  <span>Alcance por audiencia</span>
                  <span className="tabular-nums">{fmt(m.kpis.followerReach)} seguidores · {fmt(m.kpis.nonFollowerReach)} nuevos</span>
                </div>
                <BulletBar value={m.kpis.followerReach} max={m.kpis.reach28} color="#c96a2a" height={8} />
                <div className="mt-1 flex items-center gap-4 text-[11px] text-ink-400">
                  <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: '#c96a2a' }} /> Seguidores {m.kpis.followerReachPct}%</span>
                  <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-ink-200" /> No seguidores {100 - m.kpis.followerReachPct}%</span>
                </div>
              </div>
            )}
          </div>

          {/* selected-post drill-down — bottom sheet on mobile, modal on desktop */}
          {selected && (
            <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
              <div className="absolute inset-0 bg-black/40" onClick={() => setSelected(null)} />
              <div className="relative max-h-[88vh] w-full overflow-auto rounded-t-2xl bg-surface shadow-2xl sm:max-w-3xl sm:rounded-2xl">
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-ink-100 bg-surface px-5 py-3">
                  <span className="flex items-center gap-2 font-medium"><Sparkles size={15} /> Rendimiento de la publicación</span>
                  <button type="button" className="ml-auto grid h-9 w-9 place-items-center rounded-full text-ink-400 hover:bg-ink-50 hover:text-ink-700" onClick={() => setSelected(null)} aria-label="Cerrar"><X size={18} /></button>
                </div>
                <div className="grid gap-4 p-5 md:grid-cols-2 [padding-bottom:calc(1.25rem+env(safe-area-inset-bottom,0px))]">
                  <div>
                    <div className="aspect-square w-full overflow-hidden rounded-lg bg-ink-100">
                      <ImageView id={null} fallbackUrl={selected.thumb} alt={selected.excerpt} className="h-full w-full object-cover" placeholderClassName="h-full w-full" />
                    </div>
                    <div className="mt-2 flex items-center gap-3 text-sm text-ink-500">
                      <span className="inline-flex items-center gap-1"><Heart size={13} /> {fmt(selected.likes)}</span>
                      <span className="inline-flex items-center gap-1"><MessageCircle size={13} /> {fmt(selected.comments)}</span>
                      <span className="text-xs text-ink-400">{selected.ago}</span>
                      {selected.permalink && <a href={selected.permalink} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-brand-700 hover:underline"><ExternalLink size={13} /> Ver</a>}
                    </div>
                    {selected.caption && <p className="mt-2 text-sm text-ink-600 line-clamp-3">{selected.caption}</p>}
                    {/* insights */}
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {insights.loading && <div className="col-span-2 text-sm text-ink-400">Cargando métricas…</div>}
                      {insights.error && <div className="col-span-2 text-xs text-amber-700">{insights.error}</div>}
                      {insights.rows.map((r) => (
                        <div key={r.key} className="rounded-lg border border-ink-100 px-3 py-2">
                          <div className="text-[11px] uppercase tracking-wider text-ink-400">{r.label}</div>
                          <div className="font-display text-lg font-semibold tabular-nums text-ink-900">{fmt(r.value)}{r.unit ? ` ${r.unit}` : ''}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  {/* comments + moderation */}
                  <div className="min-w-0">
                    <div className="mb-2 text-[11px] uppercase tracking-wider text-ink-400">Comentarios</div>
                    {comments.loading && <div className="text-sm text-ink-400">Cargando…</div>}
                    {comments.error && <div className="text-xs text-amber-700">{comments.error}</div>}
                    {!comments.loading && !comments.error && comments.rows.length === 0 && <div className="text-sm text-ink-400">Sin comentarios.</div>}
                    <div className="max-h-80 space-y-2.5 overflow-auto pr-1">
                      {comments.rows.map((c) => (
                        <div key={c.id} className={`text-sm ${c.hidden ? 'opacity-50' : ''}`}>
                          <div className="flex items-baseline gap-2">
                            <span className="min-w-0">
                              <span className="font-medium text-ink-900">@{c.username || 'usuario'}</span>{' '}
                              <span className="text-ink-600">{c.text}</span>
                            </span>
                            <span className="ml-auto shrink-0 text-[11px] text-ink-400">{c.ago}</span>
                          </div>
                          <div className="mt-1 flex items-center gap-1 text-[11px] text-ink-400">
                            {c.replyCount > 0 && <span className="mr-1">{c.replyCount} resp.</span>}
                            <button type="button" className="rounded px-2 py-1 hover:bg-ink-50 hover:text-brand-700" onClick={() => { setReplyId(replyId === c.id ? null : c.id); setReplyText(''); }} disabled={modBusy === c.id}>Responder</button>
                            <button type="button" className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-ink-50 hover:text-ink-800" onClick={() => toggleHide(c)} disabled={modBusy === c.id}>
                              {c.hidden ? <Eye size={12} /> : <EyeOff size={12} />} {c.hidden ? 'Mostrar' : 'Ocultar'}
                            </button>
                            <button type="button" className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-ink-50 hover:text-red-600" onClick={() => removeComment(c)} disabled={modBusy === c.id}>
                              <Trash2 size={12} /> Eliminar
                            </button>
                            {modBusy === c.id && <RefreshCw size={12} className="animate-spin" />}
                          </div>
                          {c.modError && <div className="mt-0.5 text-[11px] text-red-600">{c.modError}</div>}
                          {replyId === c.id && (
                            <div className="mt-1.5 flex gap-2">
                              <input className="input flex-1" value={replyText} onChange={(e) => setReplyText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendReply(c.id); }} placeholder={`Responder a @${c.username}…`} maxLength={500} autoFocus />
                              <button type="button" className="btn-brand min-h-[44px]" onClick={() => sendReply(c.id)} disabled={!replyText.trim() || modBusy === c.id} aria-label="Enviar"><Send size={14} /></button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2 items-start">
            {/* audience intelligence */}
            <div className="card">
              <div className="card-header"><span className="flex items-center gap-2 font-medium"><Instagram size={15} /> Audiencia</span></div>
              <div className="card-pad">
                {!m.audience.hasData ? (
                  <div className="text-sm text-ink-400">
                    Las estadísticas de audiencia aparecen al superar 100 seguidores
                    {m.errors.demo_gender ? ' (Meta aún no las devuelve).' : '.'}
                  </div>
                ) : (
                  <div className="space-y-5">
                    {m.audience.gender.length > 0 && (
                      <div className="flex items-center gap-4">
                        <Donut size={108} thickness={14} segments={m.audience.gender.map((g) => ({ value: g.value, color: g.color }))}>
                          <span className="text-[11px] uppercase tracking-wider text-ink-400">Género</span>
                        </Donut>
                        <div className="min-w-0">
                          <Legend items={m.audience.gender.map((g) => ({ label: `${g.label} ${g.pct}%`, color: g.color }))} />
                        </div>
                      </div>
                    )}
                    {m.audience.age.length > 0 && (
                      <div>
                        <div className="eyebrow-xs mb-2">Edad</div>
                        <BarList rows={m.audience.age} max={audienceMax} />
                      </div>
                    )}
                    {m.audience.topCountries.length > 0 && (
                      <div>
                        <div className="eyebrow-xs mb-2">Países</div>
                        <BarList rows={m.audience.topCountries} max={audienceMax} accent="#3b3830" />
                      </div>
                    )}
                    {m.audience.topCities.length > 0 && (
                      <div>
                        <div className="eyebrow-xs mb-2">Ciudades</div>
                        <BarList rows={m.audience.topCities} max={audienceMax} accent="#6b8f71" />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* best time to post */}
            <div className="card">
              <div className="card-header">
                <span className="flex items-center gap-2 font-medium"><Clock size={15} /> Mejor hora para publicar</span>
              </div>
              <div className="card-pad">
                {!m.bestTimes.hasData ? (
                  <div className="text-sm text-ink-400">Publica algunas veces y aquí verás cuándo tu audiencia responde mejor.</div>
                ) : (
                  <>
                    <Heatmap bestTimes={m.bestTimes} />
                    {m.bestTimes.peak && (
                      <div className="mt-3 text-sm text-ink-600">
                        Tu mejor ventana histórica: <span className="font-medium text-ink-900">{m.bestTimes.peak.label}</span>{' '}
                        <span className="text-ink-400">(por interacciones, hora local).</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* content grid */}
          <div className="card">
            <div className="card-header"><span className="flex items-center gap-2 font-medium"><Instagram size={15} /> Publicaciones</span></div>
            <div className="card-pad">
              {m.grid.length === 0 ? (
                <div className="text-sm text-ink-400">Sin publicaciones.</div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                  {m.grid.map((item) => <MediaTile key={item.id} item={item} onClick={() => openPost(item)} />)}
                </div>
              )}
            </div>
          </div>

          {/* stories */}
          {m.stories.length > 0 && (
            <div className="card">
              <div className="card-header"><span className="flex items-center gap-2 font-medium"><Film size={15} /> Historias activas</span></div>
              <div className="card-pad">
                <div className="flex gap-3 overflow-x-auto pb-1">
                  {m.stories.map((s) => (
                    <a key={s.id} href={s.permalink || '#'} target="_blank" rel="noreferrer" className="shrink-0 text-center" title={s.ago}>
                      <div className="h-16 w-16 overflow-hidden rounded-full p-[2px] bg-gradient-to-tr from-brand-400 to-brand-700">
                        <div className="h-full w-full overflow-hidden rounded-full bg-surface">
                          <ImageView id={null} fallbackUrl={s.thumb} alt="" className="h-full w-full object-cover" placeholderClassName="h-full w-full" />
                        </div>
                      </div>
                      <div className="mt-1 text-[10px] text-ink-400">{s.ago}</div>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* mentions wall */}
          {m.mentions.length > 0 && (
            <div className="card">
              <div className="card-header"><span className="flex items-center gap-2 font-medium"><AtSign size={15} /> Te etiquetaron</span></div>
              <div className="card-pad">
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                  {m.mentions.map((item) => <MediaTile key={item.id} item={item} onClick={() => openPost(item)} />)}
                </div>
              </div>
            </div>
          )}

          {/* hashtag listening */}
          <div className="card">
            <div className="card-header"><span className="flex items-center gap-2 font-medium"><Search size={15} /> Escucha de hashtags</span></div>
            <div className="card-pad">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400">#</span>
                  <input className="input w-full pl-6" value={hq} onChange={(e) => setHq(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') searchHashtag(); }} placeholder="lignerosetdr" spellCheck={false} />
                </div>
                <button type="button" className="btn-brand" onClick={searchHashtag} disabled={!hq.trim() || hState.loading}>
                  {hState.loading ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />} Buscar
                </button>
              </div>
              {hState.error && <div className="mt-2 text-sm text-amber-700">{hState.error}</div>}
              {hState.result && (
                <div className="mt-3">
                  <div className="text-sm text-ink-500 mb-2">Top de <span className="font-medium text-ink-800">#{hState.result.name}</span></div>
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                    {hState.result.media.map((item) => <MediaTile key={item.id} item={item} onClick={() => (item.permalink ? window.open(item.permalink, '_blank') : null)} />)}
                  </div>
                </div>
              )}
              <p className="mt-2 text-xs text-ink-400">Meta permite consultar hasta 30 hashtags distintos cada 7 días.</p>
            </div>
          </div>

          {Object.keys(m.errors).length > 0 && (
            <div className="text-xs text-amber-700">
              Secciones sin respuesta: {Object.keys(m.errors).join(', ')} — el resto es dato real.
            </div>
          )}
        </div>
      )}
    </>
  );
}
