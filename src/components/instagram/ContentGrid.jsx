// Content grid — the visual centerpiece. A square-tile grid of your posts you
// click into for per-post insights + comment moderation (bottom sheet on
// mobile, modal on desktop). A toggle flips the grid to the posts that mention
// you, and any active stories ride a strip on top. Self-contained: the
// drill-down reads/acts straight through the meta-social Edge Function.
import { useCallback, useState } from 'react';
import {
  Images, Heart, MessageCircle, Eye, EyeOff, Trash2, Film,
  ExternalLink, RefreshCw, Send, Plus,
} from 'lucide-react';
import ImageView from '../ImageView.tsx';
import Modal from '../Modal.jsx';
import StoryViewer from './StoryViewer.jsx';
import { supabase } from '../../db/supabaseClient.js';
import { resolveMediaInsights, resolveMediaComments } from '../../core/jarvis/index.js';
import { fmt, fmtCompact } from './chrome.jsx';
import { ScaleBar } from './IgCharts.jsx';

// A media tile in the content grid / mentions wall.
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

// Compact per-format comparison (Reels vs carruseles vs fotos) — average
// interacciones per post on one shared scale, each row direct-labeled. The VM
// (resolveIgStudio.formatMix) already derived it; this only draws.
function FormatStrip({ formatMix }) {
  if ((formatMix?.length || 0) < 2) return null;
  const maxAvg = Math.max(1, ...formatMix.map((f) => f.avgEngagement));
  return (
    <div className="rounded-xl bg-ink-50 px-3.5 py-2.5">
      <div className="text-[11px] uppercase tracking-wider text-ink-400">Interacción media por formato</div>
      <div className="mt-1.5 space-y-1.5">
        {formatMix.map((f) => (
          <div key={f.key} className="flex items-center gap-2 text-xs">
            <span className="w-20 shrink-0 truncate text-ink-500">{f.label}</span>
            <ScaleBar value={f.avgEngagement} max={maxAvg} className="min-w-0 flex-1" />
            <span className="w-14 shrink-0 text-right tabular-nums text-ink-700">{fmtCompact(f.avgEngagement)}</span>
            <span className="w-12 shrink-0 text-right tabular-nums text-ink-400">{f.posts} pub.</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ContentGrid({ grid = [], mentions = [], stories = [], profile = null, formatMix = [], onPublish }) {
  const [view, setView] = useState('posts'); // 'posts' | 'mentions'
  // Index of the story the full-screen viewer is open on (null = closed).
  const [storyAt, setStoryAt] = useState(null);
  // Guard a dead state: if a refresh empties mentions while that tab is active,
  // fall back to posts (the toggle hides itself when there are no mentions).
  const showMentions = view === 'mentions' && mentions.length > 0;
  const items = showMentions ? mentions : grid;

  // ── per-post drill-down ──────────────────────────────────────────────
  const [selected, setSelected] = useState(null);
  const [insights, setInsights] = useState({ loading: false, rows: [], error: null });
  const [comments, setComments] = useState({ loading: false, rows: [], error: null });

  const openPost = useCallback(async (item) => {
    setSelected(item);
    // Mentions are other accounts' posts that tagged us — we don't own them, so
    // the owner-only insights/comments endpoints reject the media id ("object
    // does not exist / missing permissions"). Show the post + a note instead of
    // firing two calls that can only fail; the permalink still opens it on IG.
    if (item.isMention) {
      setInsights({ loading: false, rows: [], error: 'Las métricas solo están disponibles en tus publicaciones.' });
      setComments({ loading: false, rows: [], error: 'No puedes moderar los comentarios de una mención.' });
      return;
    }
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
  const [modBusy, setModBusy] = useState(null);
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
      setComments((s) => ({ ...s, rows: s.rows.map((c) => (c.id === commentId ? { ...c, replyCount: (c.replyCount || 0) + 1 } : c)) }));
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

  return (
    <div className="card lg:flex lg:h-full lg:flex-col">
      <div className="card-header flex-wrap gap-y-2 lg:flex-nowrap lg:shrink-0">
        <span className="flex items-center gap-2 font-medium"><Images size={15} /> Contenido</span>
        <div className="flex min-w-0 items-center gap-2">
          {mentions.length > 0 && (
            <div className="inline-flex rounded-full border border-ink-200 bg-ink-100 p-1 text-xs" role="tablist" aria-label="Vista de contenido">
              {[['posts', 'Publicaciones'], ['mentions', 'Menciones']].map(([id, label]) => {
                const on = view === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setView(id)}
                    className={`rounded-full px-3 py-1 font-medium transition-colors ${on ? 'bg-surface text-brand-700 shadow-sm ring-1 ring-black/5' : 'text-ink-500 hover:text-ink-800'}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          {onPublish && (
            <button type="button" className="btn-brand text-xs" onClick={onPublish}>
              <Plus size={14} /> Publicar
            </button>
          )}
        </div>
      </div>
      <div className="card-pad space-y-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {!showMentions && <FormatStrip formatMix={formatMix} />}
        {stories.length > 0 && !showMentions && (
          <div className="flex gap-3 overflow-x-auto pb-1">
            {stories.map((s, i) => (
              <button key={s.id} type="button" onClick={() => setStoryAt(i)} className="shrink-0 text-center" title="Ver historia">
                <div className="h-14 w-14 overflow-hidden rounded-full p-[2px] bg-gradient-to-tr from-brand-400 to-brand-700">
                  <div className="h-full w-full overflow-hidden rounded-full bg-surface">
                    <ImageView id={null} fallbackUrl={s.thumb} alt="" className="h-full w-full object-cover" placeholderClassName="h-full w-full" />
                  </div>
                </div>
                <div className="mt-1 text-[10px] text-ink-400">{s.ago}</div>
              </button>
            ))}
          </div>
        )}
        {items.length === 0 ? (
          <div className="text-sm text-ink-400">{showMentions ? 'Nadie te ha etiquetado todavía.' : 'Sin publicaciones.'}</div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4 gap-2">
            {items.map((item) => <MediaTile key={item.id} item={item} onClick={() => openPost(item)} />)}
          </div>
        )}
      </div>

      {/* selected-post drill-down — the shared Modal (Esc + focus/backdrop,
          sheet-on-mobile) instead of a hand-rolled inset-0 overlay. */}
      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title="Rendimiento de la publicación"
        size="lg"
      >
        {selected && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
                          {c.username ? <span className="font-medium text-ink-900">@{c.username} </span> : null}
                          <span className={c.username ? 'text-ink-600' : 'text-ink-800'}>{c.text}</span>
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
        )}
      </Modal>

      {storyAt != null && (
        <StoryViewer
          stories={stories}
          startIndex={storyAt}
          profile={profile}
          onClose={() => setStoryAt(null)}
        />
      )}
    </div>
  );
}
