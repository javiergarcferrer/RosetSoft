// Composer — the publish/schedule surface, lives inside the "Publicar" modal.
// Self-contained: holds the draft, uploads media from the device, publishes now
// or queues a scheduled post (our own engine — IG has no native scheduling),
// and surfaces the still-processing IG video as a one-tap "Finalizar". Calls
// onPublished() after a successful immediate publish so the page refreshes.
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, RefreshCw, Send } from 'lucide-react';
import MediaPicker from '../MediaPicker.jsx';
import { supabase } from '../../db/supabaseClient.js';
import { db, newId } from '../../db/database.js';
import { resolveScheduleAgenda, describePost } from '../../core/jarvis/index.js';

export default function ComposerCard({ publishLimit, onPublished }) {
  const [pubText, setPubText] = useState('');
  const [pubMedia, setPubMedia] = useState([]); // [{ url, type, key }] from device upload
  const [pubMode, setPubMode] = useState('feed'); // 'feed' | 'reel' | 'story' | 'carousel'
  const [pubBusy, setPubBusy] = useState(false);
  const [pubNote, setPubNote] = useState(null);
  // An IG video container that was still processing when publish() returned.
  const [pendingIg, setPendingIg] = useState(null); // { creationId }
  const [finishBusy, setFinishBusy] = useState(false);
  // Advanced options (alt text, collaborators, first comment).
  const [showAdv, setShowAdv] = useState(false);
  const [altText, setAltText] = useState('');
  const [collaborators, setCollaborators] = useState('');
  const [firstComment, setFirstComment] = useState('');
  // Schedule + scheduled queue (our scheduled_posts table).
  const [pubAt, setPubAt] = useState('');
  const [agenda, setAgenda] = useState({ upcoming: [], recent: [] });
  const loadAgenda = useCallback(async () => {
    try {
      const rows = await db.scheduledPosts.where('profileId').equals('team').toArray();
      setAgenda(resolveScheduleAgenda(rows));
    } catch { /* table may not exist pre-deploy */ }
  }, []);
  useEffect(() => { loadAgenda(); }, [loadAgenda]);

  const maxMedia = pubMode === 'carousel' ? 10 : 1;
  // Drop extra media when switching from carousel to a single-item mode.
  useEffect(() => { setPubMedia((prev) => (maxMedia === 1 ? prev.slice(0, 1) : prev)); }, [maxMedia]);

  // Enough to publish: any caption, a single media, or a carousel of ≥2.
  const canPublish = !!(pubText.trim() || (pubMode === 'carousel' ? pubMedia.length >= 2 : pubMedia.length >= 1));

  const resetComposer = () => {
    setPubText(''); setPubMedia([]); setAltText(''); setCollaborators(''); setFirstComment('');
    setPubAt('');
  };

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
    // resolve. Starting another publish would orphan it, so refuse first.
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
      if (ig.pending && ig.creationId) setPendingIg({ creationId: ig.creationId });
      setPubNote({
        ok: !!data?.ok,
        text: ig.ok ? 'Publicado en Instagram ✓'
          : ig.pending ? 'Instagram: procesando…'
            : (ig.error || data?.error || 'sin respuesta'),
      });
      if (data?.ok) { resetComposer(); onPublished?.(); }
    } catch (e) {
      setPubNote({ ok: false, text: e?.message || 'Fallo al publicar' });
    } finally {
      setPubBusy(false);
    }
  }, [pubText, pubMedia, pubMode, altText, collaborators, firstComment, pubAt, canPublish, pubBusy, pendingIg, onPublished, loadAgenda]);

  const discardPending = useCallback(() => { setPendingIg(null); setPubNote(null); }, []);

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
      onPublished?.();
    } catch (e) {
      setPubNote({ ok: false, text: e?.message || 'No se pudo finalizar' });
    } finally {
      setFinishBusy(false);
    }
  }, [pendingIg, finishBusy, onPublished]);

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <textarea
          className="input w-full min-h-28"
          value={pubText}
          onChange={(e) => setPubText(e.target.value)}
          placeholder={pubMode === 'story' ? 'Texto opcional…' : 'Pie de foto…'}
          maxLength={2200}
        />
        <MediaPicker
          items={pubMedia}
          onChange={setPubMedia}
          max={maxMedia}
          mode={pubMode}
          accept={pubMode === 'reel' ? 'video/*' : 'image/*,video/*'}
        />

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

        {/* action bar — stacks full-width on a phone, inline from sm+ */}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
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
          {publishLimit?.remaining != null && ` · ${publishLimit.remaining}/${publishLimit.total} disponibles hoy.`}
        </p>
        {pendingIg && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink-600">
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

      {(agenda.upcoming.length > 0 || agenda.recent.length > 0) && (
        <div className="border-t border-ink-100 pt-3">
          <div className="mb-1 flex items-center gap-2 text-sm font-medium text-ink-800"><CalendarClock size={15} /> Programados</div>
          <div className="divide-y divide-ink-100">
            {agenda.upcoming.map((p) => (
              <div key={p.id} className="py-2 flex items-center gap-3 text-sm">
                {p.thumb && <img src={p.thumb} alt="" className="w-9 h-9 flex-none rounded-md object-cover bg-ink-100" loading="lazy" />}
                <span className="flex-none rounded-full bg-brand-50 px-2 py-0.5 text-[11px] text-brand-800">{p.kind}</span>
                <span className="min-w-0 truncate text-ink-700">{p.preview || '(sin texto)'}</span>
                <span className="ml-auto flex-none text-xs text-ink-400">{new Date(p.at).toLocaleString('es-DO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                <button type="button" className="flex-none text-xs text-red-600 hover:underline" onClick={() => cancelScheduled(p.id)}>Cancelar</button>
              </div>
            ))}
            {agenda.recent.map((p) => (
              <div key={p.id} className="py-2 flex items-center gap-3 text-xs text-ink-400">
                <span className={`flex-none ${p.status === 'failed' ? 'text-red-600' : 'text-emerald-700'}`}>{p.statusLabel}</span>
                <span className="min-w-0 truncate">{p.preview || p.kind}</span>
                {p.error && <span className="ml-auto flex-none text-red-600 truncate max-w-40" title={p.error}>{p.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
