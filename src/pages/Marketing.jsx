// Marketing — the acting surface for the Meta integration (Facebook Page,
// Instagram, Ads, catalogs). JARVIS stays the read-only briefing room; HERE
// is where the team publishes, schedules, answers comments and watches
// campaigns. Same data spine as the JARVIS brief: the meta-social Edge
// Function (tokens never reach the browser) projected by resolveSocialPulse.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock, Megaphone, MessageSquare, RefreshCw, Send, ShoppingBag, Zap,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import { useApp } from '../context/AppContext.jsx';
import { supabase } from '../db/supabaseClient.js';
import { resolveSocialPulse } from '../core/jarvis/index.js';

function Stat({ label, value, sub, tone }) {
  return (
    <div className="stat-card p-4">
      <div className="text-[11px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums mt-0.5 ${tone || 'text-ink-900'}`}>{value}</div>
      {sub && <div className="text-xs text-ink-400 mt-0.5">{sub}</div>}
    </div>
  );
}

const deltaSub = (pct, fallback) => (pct != null
  ? `${pct >= 0 ? '+' : ''}${pct}% vs 7d anteriores`
  : fallback);

export default function Marketing() {
  const { settings, refreshSettings } = useApp();
  const linked = !!settings?.metaSocialConnectedAt;

  const [raw, setRaw] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const busy = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', { body: { snapshot: true } });
      if (error) throw new Error(error.message || 'sin respuesta');
      if (data?.configured === false || data?.error) throw new Error(data?.error || 'sin respuesta');
      setRaw(data);
    } catch (e) {
      setLoadError(e?.message || 'No se pudo leer Meta');
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, []);
  useEffect(() => { if (linked) load(); }, [linked, load]);

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
  const [pubImageUrl, setPubImageUrl] = useState('');
  const [pubAt, setPubAt] = useState('');
  const [pubIg, setPubIg] = useState(false);
  const [pubBusy, setPubBusy] = useState(false);
  const [pubNote, setPubNote] = useState(null);
  const publish = useCallback(async () => {
    const message = pubText.trim();
    if (!message || pubBusy) return;
    setPubBusy(true);
    setPubNote(null);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', {
        body: {
          publish: {
            message,
            imageUrl: pubImageUrl.trim() || undefined,
            scheduleAt: pubAt ? new Date(pubAt).getTime() : undefined,
            targets: pubIg ? ['facebook', 'instagram'] : ['facebook'],
          },
        },
      });
      if (error) throw new Error(error.message || 'sin respuesta');
      const parts = Object.entries(data?.results || {}).map(([t, r]) => (
        r.ok ? `${t === 'facebook' ? 'Facebook' : 'Instagram'} ✓` : `${t === 'facebook' ? 'Facebook' : 'Instagram'}: ${r.error}`
      ));
      setPubNote({ ok: !!data?.ok, text: parts.join(' · ') || data?.error || 'sin respuesta' });
      if (data?.ok) {
        setPubText(''); setPubImageUrl(''); setPubAt('');
        load();
      }
    } catch (e) {
      setPubNote({ ok: false, text: e?.message || 'Fallo al publicar' });
    } finally {
      setPubBusy(false);
    }
  }, [pubText, pubImageUrl, pubAt, pubIg, pubBusy, load]);

  // ── inline comment reply ─────────────────────────────────────────────
  const [replyTo, setReplyTo] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyErr, setReplyErr] = useState(null);
  const sendReply = useCallback(async () => {
    const message = replyText.trim();
    if (!message || !replyTo || replyBusy) return;
    setReplyBusy(true);
    setReplyErr(null);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', {
        body: { replyComment: { commentId: replyTo, message } },
      });
      if (error) throw new Error(error.message || 'sin respuesta');
      if (!data?.ok) throw new Error(data?.error || 'No se pudo responder');
      setReplyTo(null);
      setReplyText('');
    } catch (e) {
      setReplyErr(e?.message || 'No se pudo responder');
    } finally {
      setReplyBusy(false);
    }
  }, [replyText, replyTo, replyBusy]);

  const money = (v, digits = 2) => `${Number(v).toLocaleString('en-US', { maximumFractionDigits: digits })}${m?.adCurrency ? ` ${m.adCurrency}` : ''}`;

  return (
    <>
      <PageHeader
        title="Marketing"
        subtitle={linked
          ? [m?.pageName, m?.igUsername && `@${m.igUsername}`].filter(Boolean).join(' · ') || 'Meta conectado'
          : 'Sin conectar — usa el usuario del sistema de WhatsApp'}
        actions={linked ? (
          <button type="button" onClick={load} disabled={loading} className="btn-brand">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Actualizar
          </button>
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
      ) : loadError ? (
        <div className="card card-pad text-sm">
          <div className="text-red-600">{loadError}</div>
          <button type="button" className="btn-brand mt-3" onClick={load}>
            <RefreshCw size={14} /> Reintentar
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
              label="Audiencia"
              value={(m.kpis.igFollowers ?? 0).toLocaleString('en-US')}
              sub={`IG · FB ${(m.kpis.fbFollowers ?? 0).toLocaleString('en-US')} · perfil 7d: ${m.kpis.profileViews7.toLocaleString('en-US')}`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2 items-start">
            <div className="space-y-4">
              {/* composer */}
              <div className="card">
                <div className="card-header">
                  <span className="flex items-center gap-2 font-medium"><Megaphone size={15} /> Publicar</span>
                </div>
                <div className="card-pad space-y-2.5">
                  <textarea
                    className="input w-full min-h-20"
                    value={pubText}
                    onChange={(e) => setPubText(e.target.value)}
                    placeholder="Texto de la publicación…"
                    maxLength={2000}
                  />
                  <div className="flex flex-wrap gap-2">
                    <input
                      className="input flex-1 min-w-44"
                      value={pubImageUrl}
                      onChange={(e) => setPubImageUrl(e.target.value)}
                      placeholder="URL de imagen (obligatoria para IG)"
                      spellCheck={false}
                    />
                    <input
                      className="input w-52"
                      type="datetime-local"
                      value={pubAt}
                      onChange={(e) => setPubAt(e.target.value)}
                      aria-label="Programar (solo Facebook)"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 text-sm text-ink-500">
                      <input type="checkbox" checked={pubIg} onChange={(e) => setPubIg(e.target.checked)} />
                      También en Instagram
                    </label>
                    <button
                      type="button"
                      className="btn-brand ml-auto"
                      onClick={publish}
                      disabled={!pubText.trim() || pubBusy}
                    >
                      {pubBusy ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
                      {pubAt ? 'Programar' : 'Publicar'}
                    </button>
                  </div>
                  <p className="text-xs text-ink-400">
                    Facebook admite programar (10 min – 30 días). Instagram publica al momento y requiere imagen.
                  </p>
                  {pubNote && (
                    <div className={`text-sm ${pubNote.ok ? 'text-emerald-700' : 'text-red-600'}`}>{pubNote.text}</div>
                  )}
                </div>
              </div>

              {/* campaigns */}
              {m.campaigns.length > 0 && (
                <div className="card">
                  <div className="card-header"><span className="font-medium">Campañas · 28 días</span></div>
                  <div className="divide-y divide-ink-100">
                    {m.campaigns.map((c) => (
                      <div key={c.name} className="px-5 py-2.5 flex items-baseline gap-3 text-sm">
                        <span className="min-w-0 truncate text-ink-800">{c.name}</span>
                        <span className="ml-auto tabular-nums text-ink-800">{money(c.spend)}</span>
                        <span className="tabular-nums text-ink-400 text-xs w-28 text-right">
                          {c.results != null && m.kpis.resultsLabel
                            ? `${c.results} ${m.kpis.resultsLabel}`
                            : c.ctrPct != null ? `CTR ${c.ctrPct.toFixed(2)}%` : `${c.clicks} clics`}
                        </span>
                      </div>
                    ))}
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
              {/* comments + reply */}
              <div className="card">
                <div className="card-header">
                  <span className="flex items-center gap-2 font-medium"><MessageSquare size={15} /> Comentarios IG</span>
                </div>
                <div className="divide-y divide-ink-100">
                  {m.recentComments.length === 0 && (
                    <div className="px-5 py-3 text-sm text-ink-400">Sin comentarios recientes.</div>
                  )}
                  {m.recentComments.map((c) => (
                    <div key={c.id || `${c.username}-${c.at}`} className="px-5 py-2.5">
                      <div className="flex items-baseline gap-2 text-sm">
                        <span className="min-w-0 truncate">
                          <span className="font-medium text-ink-900">@{c.username}</span>{' '}
                          <span className="text-ink-600">{c.text}</span>
                        </span>
                        <span className="ml-auto flex-none text-xs text-ink-400">{c.ago || ''}</span>
                        {c.id && (
                          <button
                            type="button"
                            className="flex-none text-xs text-brand-700 hover:underline"
                            onClick={() => { setReplyTo(replyTo === c.id ? null : c.id); setReplyText(''); setReplyErr(null); }}
                          >
                            Responder
                          </button>
                        )}
                      </div>
                      {replyTo === c.id && (
                        <div className="flex gap-2 mt-2">
                          <input
                            className="input flex-1"
                            value={replyText}
                            onChange={(e) => setReplyText(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') sendReply(); }}
                            placeholder={`Responder a @${c.username}…`}
                            maxLength={500}
                            autoFocus
                          />
                          <button type="button" className="btn-brand" onClick={sendReply} disabled={!replyText.trim() || replyBusy}>
                            {replyBusy ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {replyErr && <div className="px-5 py-2 text-sm text-red-600">{replyErr}</div>}
                </div>
              </div>

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
