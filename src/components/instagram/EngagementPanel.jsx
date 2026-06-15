// EngagementPanel — the command center's interactive side rail. One card whose
// segmented switcher flips between three jobs that used to be three stacked
// cards: triaging recent Comentarios (reply inline), watching ad Campañas
// (pause/resume — REAL MONEY, confirm-gated), and the real-time Actividad feed
// (comments/mentions the meta-webhook writes to ig_events). Self-contained.
import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, Megaphone, Activity, RefreshCw, Send } from 'lucide-react';
import { supabase } from '../../db/supabaseClient.js';
import { db } from '../../db/database.js';
import { PostThumb, PostPeek } from './postMedia.jsx';

const money = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

export default function EngagementPanel({ comments = [], campaigns = [], hasAds, adCurrency, spend7, posts = [], onChanged }) {
  const showCampaigns = !!hasAds && campaigns.length > 0;
  const tabs = [
    { id: 'comments', label: 'Comentarios', icon: MessageSquare },
    ...(showCampaigns ? [{ id: 'campaigns', label: 'Campañas', icon: Megaphone }] : []),
    { id: 'activity', label: 'Actividad', icon: Activity },
  ];
  const [tab, setTab] = useState('comments');
  // If campaigns vanish while that tab is selected, don't strand on a hidden tab.
  const activeTab = tabs.some((t) => t.id === tab) ? tab : 'comments';

  // ── inline comment reply ─────────────────────────────────────────────
  const [reply, setReply] = useState(null); // { id, username }
  const [replyText, setReplyText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyErr, setReplyErr] = useState(null);
  const sendReply = useCallback(async () => {
    const message = replyText.trim();
    if (!message || !reply?.id || replyBusy) return;
    setReplyBusy(true);
    setReplyErr(null);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', {
        body: { replyComment: { commentId: reply.id, message, platform: 'instagram' } },
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

  // ── full-publication peek (a comment opens its parent post) ──────────
  const [peek, setPeek] = useState(null);
  const peekComment = useCallback((c) => {
    const post = posts.find((p) => p.permalink && p.permalink === c.permalink);
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
  }, [posts]);

  // ── ad campaign pause/resume (Marketing API; confirm-gated) ──────────
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
      onChanged?.();
    } catch (e) {
      setCampErr(e?.message || 'No se pudo cambiar la campaña');
    } finally {
      setCampBusy(null);
    }
  }, [campBusy, onChanged]);

  // ── real-time activity (webhooks → ig_events) ────────────────────────
  const [events, setEvents] = useState([]);
  const [rtBusy, setRtBusy] = useState(false);
  const [rtNote, setRtNote] = useState(null);
  const loadEvents = useCallback(async () => {
    try {
      const rows = await db.igEvents.where('profileId').equals('team').toArray();
      setEvents(rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 20));
    } catch { /* table may not exist pre-deploy */ }
  }, []);
  useEffect(() => {
    loadEvents();
    const onVisible = () => { if (document.visibilityState === 'visible') loadEvents(); };
    window.addEventListener('focus', onVisible);
    const id = setInterval(() => { if (document.visibilityState === 'visible') loadEvents(); }, 15000);
    return () => { window.removeEventListener('focus', onVisible); clearInterval(id); };
  }, [loadEvents]);
  const activateRealtime = useCallback(async () => {
    setRtBusy(true);
    setRtNote(null);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', { body: { subscribeWebhooks: true } });
      if (error || !data?.ok) throw new Error(data?.error || error?.message || 'No se pudo activar');
      setRtNote({ ok: true, text: 'Tiempo real activado — los comentarios y menciones aparecerán en segundos.' });
      loadEvents();
    } catch (e) {
      setRtNote({ ok: false, text: e?.message || 'No se pudo activar' });
    } finally {
      setRtBusy(false);
    }
  }, [loadEvents]);

  return (
    <div className="card flex flex-col lg:h-full">
      <div className="p-2 border-b border-ink-100 shrink-0">
        <div className="inline-flex w-full rounded-full border border-ink-200 bg-surface p-0.5 text-xs" role="tablist" aria-label="Interacción">
          {tabs.map((t) => {
            const on = activeTab === t.id;
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setTab(t.id)}
                className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-full px-2 py-1.5 font-medium transition-colors ${on ? 'bg-brand-600 text-white shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
              >
                <Icon size={13} /> {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab body — the single internal scroll region on the lg command board
          (each tab's own list drops its cap there, below); on phones it's a
          plain block and the per-tab max-heights bound the rail instead. */}
      <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">

      {/* Comentarios */}
      {activeTab === 'comments' && (
        comments.length === 0 ? (
          <div className="px-4 py-4 text-sm text-ink-400">Sin comentarios recientes.</div>
        ) : (
          <div className="max-h-[30rem] lg:max-h-none lg:overflow-visible overflow-y-auto divide-y divide-ink-100">
            {comments.map((c) => {
              const open = reply?.id === c.id;
              return (
                <div key={c.id || `${c.username}-${c.at}`} className="px-4 py-2.5 flex items-start gap-3">
                  <PostThumb src={c.mediaUrl} onClick={() => peekComment(c)} className="w-10 h-10" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 text-sm">
                      <span className="min-w-0 truncate">
                        <span className="font-medium text-ink-900">@{c.username || 'Anónimo'}</span>{' '}
                        <span className="text-ink-600">{c.text}</span>
                      </span>
                      <span className="ml-auto flex-none text-xs text-ink-400">{c.ago || ''}</span>
                    </div>
                    {c.id && (
                      <button
                        type="button"
                        className="mt-0.5 text-xs text-brand-700 hover:underline"
                        onClick={() => { setReply(open ? null : { id: c.id, username: c.username }); setReplyText(''); setReplyErr(null); }}
                      >
                        Responder
                      </button>
                    )}
                    {open && (
                      <div className="mt-1.5 flex gap-2">
                        <input
                          className="input flex-1"
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') sendReply(); }}
                          placeholder={`Responder a @${c.username || ''}…`}
                          maxLength={500}
                          autoFocus
                        />
                        <button type="button" className="btn-brand min-h-[44px]" onClick={sendReply} disabled={!replyText.trim() || replyBusy} aria-label="Enviar respuesta">
                          {replyBusy ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
                        </button>
                      </div>
                    )}
                    {replyErr && open && <div className="mt-1 text-xs text-red-600">{replyErr}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* Campañas */}
      {activeTab === 'campaigns' && (
        <div>
          {spend7 != null && <div className="px-4 pt-2 text-xs text-ink-400 tabular-nums">{money(spend7)}{adCurrency ? ` ${adCurrency}` : ''} · 7d</div>}
          {campErr && <div className="px-4 pt-2 text-xs text-red-600">{campErr}</div>}
          {campaigns.length === 0 ? (
            <div className="px-4 py-4 text-sm text-ink-400">Sin campañas activas.</div>
          ) : (
            <div className="max-h-[30rem] lg:max-h-none lg:overflow-visible overflow-y-auto divide-y divide-ink-100">
              {campaigns.map((c) => (
                <div key={c.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                  <span className={`flex-none h-2 w-2 rounded-full ${c.active ? 'bg-emerald-500' : 'bg-ink-300'}`} title={c.status || ''} />
                  <span className="min-w-0 flex-1 truncate text-ink-800">{c.name}</span>
                  <span className="flex-none text-xs text-ink-400 tabular-nums">
                    {c.spend != null ? money(c.spend) : '—'}{adCurrency ? ` ${adCurrency}` : ''}{c.results != null ? ` · ${c.results} res.` : ''}
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
          )}
        </div>
      )}

      {/* Actividad */}
      {activeTab === 'activity' && (
        <div className="p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="eyebrow-xs">Tiempo real</span>
            <button type="button" className="btn-ghost text-xs min-h-[36px]" onClick={activateRealtime} disabled={rtBusy}>
              {rtBusy ? <RefreshCw size={14} className="animate-spin" /> : 'Activar'}
            </button>
          </div>
          {rtNote && <div className={`mb-2 text-sm ${rtNote.ok ? 'text-emerald-700' : 'text-red-600'}`}>{rtNote.text}</div>}
          {events.length === 0 ? (
            <p className="text-sm text-ink-400">
              Activa el tiempo real para recibir comentarios y menciones en segundos (sin recargar).
            </p>
          ) : (
            <div className="max-h-[28rem] lg:max-h-none lg:overflow-visible overflow-y-auto divide-y divide-ink-100">
              {events.map((e) => (
                <div key={e.id} className="py-2 text-sm">
                  <span className="rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-500">{e.kind === 'mention' ? 'mención' : 'comentario'}</span>{' '}
                  {e.username && <span className="font-medium text-ink-900">@{e.username}</span>}{' '}
                  <span className="text-ink-600">{e.text || ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </div>

      <PostPeek post={peek} onClose={() => setPeek(null)} />
    </div>
  );
}
