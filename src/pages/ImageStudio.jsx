import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles, Loader2, Upload, Wand2, Download, X, ImageIcon, AlertTriangle, Maximize2,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { db, newId, TEAM_PROFILE_ID } from '../db/database.js';
import { useLiveQueryStatus } from '../db/hooks.js';
import { uploadSocialMedia } from '../db/socialUpload.js';
import { generateImages, describeInspiration } from '../lib/imageGen.js';
import {
  DALLE_SIZES, nearestDalleAspect, buildGenerationPlan, resolveImageStudio,
} from '../core/jarvis/index.js';
import { userMessageFor } from '../lib/errorMessages.js';

// Dimension presets the dealer reaches for most (label + exact target pixels).
const PRESETS = [
  { label: 'Post 1080×1080', w: 1080, h: 1080 },
  { label: 'Story 1080×1920', w: 1080, h: 1920 },
  { label: 'Anuncio 1200×628', w: 1200, h: 628 },
  { label: 'Banner 1792×1024', w: 1792, h: 1024 },
];

const ASPECT_LABEL = { square: 'Cuadrada', portrait: 'Vertical', landscape: 'Horizontal' };

/**
 * Estudio de imágenes — the gpt-image-1 ad/artwork pane. The dealer writes a
 * prompt, optionally drops "inspiration" reference photos (turned into an
 * editable style brief by the `describe` mode, since the generator takes no
 * image input), sets exact target pixels (we pick the nearest native aspect; the
 * Edge Function crops/resizes to the exact dims), chooses how many images to
 * generate, and gets a grid of downloadable results. Every result is persisted
 * best-effort into `generated_images` for the history gallery below.
 */
export default function ImageStudio() {
  const [prompt, setPrompt] = useState('');
  const [styleNote, setStyleNote] = useState('');
  const [inspiration, setInspiration] = useState([]); // [{ url }]
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [width, setWidth] = useState(1080);
  const [height, setHeight] = useState(1080);
  const [count, setCount] = useState(2);
  const [quality, setQuality] = useState('standard'); // standard | hd
  const [style, setStyle] = useState('vivid'); // vivid | natural
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState([]); // newest batch
  const [expanded, setExpanded] = useState(null); // a result with revisedPrompt shown
  const fileRef = useRef(null);

  const aspect = useMemo(() => nearestDalleAspect(width, height), [width, height]);

  // The expanded lightbox closes on Escape, like every overlay in the app.
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setExpanded(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const { data: history } = useLiveQueryStatus(
    () => db.generatedImages.where('profileId').equals(TEAM_PROFILE_ID).toArray().catch(() => []),
    [],
    [],
  );
  const gallery = useMemo(() => resolveImageStudio(history || []), [history]);

  const onFiles = useCallback(async (files) => {
    const list = Array.from(files || []).filter((f) => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name));
    if (!list.length) return;
    setUploading(true);
    setError('');
    try {
      const uploaded = await Promise.all(list.map((f) => uploadSocialMedia(f)));
      setInspiration((prev) => [...prev, ...uploaded.map((u) => ({ url: u.url }))]);
    } catch (e) {
      setError(userMessageFor(e));
    } finally {
      setUploading(false);
    }
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    onFiles(e.dataTransfer?.files);
  }, [onFiles]);

  const removeInspiration = (url) => setInspiration((prev) => prev.filter((i) => i.url !== url));

  const analyze = useCallback(async () => {
    if (!inspiration.length) return;
    setAnalyzing(true);
    setError('');
    try {
      const res = await describeInspiration(inspiration.map((i) => i.url));
      const brief = res?.styleNote || res?.brief || '';
      if (brief) setStyleNote(brief);
    } catch (e) {
      setError(userMessageFor(e));
    } finally {
      setAnalyzing(false);
    }
  }, [inspiration]);

  const applyPreset = (p) => { setWidth(p.w); setHeight(p.h); };

  const generate = useCallback(async () => {
    setError('');
    const plan = buildGenerationPlan({
      prompt, styleNote, count, targetWidth: width, targetHeight: height, quality, style,
    });
    if (!plan.ok) {
      setError(plan.error);
      return;
    }
    setBusy(true);
    setResults([]);
    try {
      const res = await generateImages(plan.request);
      const images = res?.images || [];
      setResults(images);
      // Persist each result best-effort — a missing table must never break the
      // generation the dealer just paid OpenAI for.
      const now = Date.now();
      await Promise.all(images.map((img) => db.generatedImages.put({
        id: newId(),
        profileId: TEAM_PROFILE_ID,
        prompt: plan.request.prompt,
        styleNote: plan.request.styleNote || null,
        status: 'completed',
        imageUrl: img.url || null,
        width: img.width || plan.request.targetWidth,
        height: img.height || plan.request.targetHeight,
        count: plan.request.count,
        revisedPrompt: img.revisedPrompt || null,
        model: res?.model || 'gpt-image-1',
        inspiration: inspiration.map((i) => i.url),
        error: null,
        createdAt: now,
        updatedAt: now,
      }).catch(() => {})));
    } catch (e) {
      setError(userMessageFor(e));
    } finally {
      setBusy(false);
    }
  }, [prompt, styleNote, count, width, height, quality, style, inspiration]);

  const native = DALLE_SIZES[aspect];

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        title="Estudio de imágenes"
        subtitle="Genera anuncios y arte con IA: describe la escena, arrastra imágenes de inspiración y elige el tamaño."
      />

      {error && (
        <div className="card mb-4 px-4 py-3 border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-200 flex items-start gap-2 text-sm">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid md:grid-cols-[1fr_320px] gap-5 items-start">
        {/* ── Composer ── */}
        <div className="space-y-5">
          <div className="card card-pad space-y-4">
            <div>
              <label className="label" htmlFor="ig-prompt">Descripción</label>
              <textarea
                id="ig-prompt"
                className="input min-h-[110px] resize-y"
                placeholder="Sala de estar minimalista con un sofá Togo de Ligne Roset, luz cálida de atardecer, estilo editorial…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>

            {/* Inspiration dropzone */}
            <div>
              <label className="label">Inspiración (opcional)</label>
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}
                className="rounded-lg border border-dashed border-ink-200 p-3 text-center cursor-pointer hover:border-brand-400 transition-colors"
                onClick={() => fileRef.current?.click()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
                role="button"
                tabIndex={0}
                aria-label="Subir imágenes de inspiración"
              >
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }}
                />
                {inspiration.length === 0 ? (
                  <div className="text-ink-400 text-sm flex flex-col items-center gap-1.5 py-3">
                    {uploading ? <Loader2 size={18} className="animate-spin" /> : <Upload size={18} />}
                    <span>{uploading ? 'Subiendo…' : 'Arrastra imágenes o haz clic para subir'}</span>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2 justify-center py-1">
                    {inspiration.map((i) => (
                      <div key={i.url} className="relative group">
                        <img src={i.url} alt="" className="h-16 w-16 object-cover rounded-md border border-ink-100" />
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); removeInspiration(i.url); }}
                          className="absolute -top-1.5 -right-1.5 bg-ink-900 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                          aria-label="Quitar"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                    {uploading && <Loader2 size={18} className="animate-spin text-ink-400 self-center" />}
                  </div>
                )}
              </div>
              {inspiration.length > 0 && (
                <button
                  type="button"
                  onClick={analyze}
                  disabled={analyzing}
                  className="btn-ghost text-xs mt-2 inline-flex items-center gap-1.5"
                >
                  {analyzing ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
                  Analizar inspiración
                </button>
              )}
            </div>

            {/* Editable style brief */}
            <div>
              <label className="label" htmlFor="ig-style">Estilo (editable)</label>
              <textarea
                id="ig-style"
                className="input min-h-[70px] resize-y"
                placeholder="Brief de estilo: paleta, iluminación, encuadre, acabado…"
                value={styleNote}
                onChange={(e) => setStyleNote(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* ── Controls ── */}
        <div className="card card-pad space-y-4">
          <div>
            <label className="label">Tamaño</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className={`text-xs px-2 py-1 rounded-md border transition-colors ${
                    width === p.w && height === p.h
                      ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : 'border-ink-200 text-ink-600 hover:border-ink-300'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <label className="label text-[11px]" htmlFor="ig-w">Ancho (px)</label>
                <input
                  id="ig-w"
                  type="number"
                  className="input"
                  min={256}
                  max={2048}
                  value={width}
                  onChange={(e) => setWidth(Number(e.target.value) || 0)}
                />
              </div>
              <div className="flex-1">
                <label className="label text-[11px]" htmlFor="ig-h">Alto (px)</label>
                <input
                  id="ig-h"
                  type="number"
                  className="input"
                  min={256}
                  max={2048}
                  value={height}
                  onChange={(e) => setHeight(Number(e.target.value) || 0)}
                />
              </div>
            </div>
            <p className="text-[11px] text-ink-400 mt-1.5">
              Generada en {native.api} ({ASPECT_LABEL[aspect]}) y recortada a {width || '?'}×{height || '?'} px.
            </p>
          </div>

          <div>
            <span className="label block">Cantidad</span>
            <div className="flex gap-1.5">
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setCount(n)}
                  className={`flex-1 text-sm py-1.5 rounded-md border transition-colors ${
                    count === n ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-ink-200 text-ink-600 hover:border-ink-300'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Calidad</label>
              <div className="flex rounded-md border border-ink-200 overflow-hidden text-xs">
                {[['standard', 'Estándar'], ['hd', 'HD']].map(([v, l]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setQuality(v)}
                    className={`flex-1 py-1.5 ${quality === v ? 'bg-brand-50 text-brand-700' : 'text-ink-500'}`}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Estilo</label>
              <div className="flex rounded-md border border-ink-200 overflow-hidden text-xs">
                {[['vivid', 'Vívido'], ['natural', 'Natural']].map(([v, l]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setStyle(v)}
                    className={`flex-1 py-1.5 ${style === v ? 'bg-brand-50 text-brand-700' : 'text-ink-500'}`}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={generate}
            disabled={busy}
            className="btn-primary w-full inline-flex items-center justify-center gap-2"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {busy ? 'Generando…' : `Generar ${count > 1 ? `(${count})` : ''}`}
          </button>
        </div>
      </div>

      {/* ── Results grid ── */}
      {(busy || results.length > 0) && (
        <section className="mt-7">
          <h2 className="font-display text-lg font-semibold mb-3">Resultados</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {busy && results.length === 0 && Array.from({ length: count }).map((_, i) => (
              <div key={i} className="aspect-square rounded-lg bg-ink-100 animate-pulse" />
            ))}
            {results.map((img, i) => (
              <ResultCard key={img.url || i} img={img} onExpand={() => setExpanded(img)} />
            ))}
          </div>
        </section>
      )}

      {/* ── History gallery ── */}
      {gallery.items.length > 0 && (
        <section className="mt-8">
          <h2 className="font-display text-lg font-semibold mb-3">Historial</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {gallery.items.filter((it) => it.imageUrl).map((it) => (
              <ResultCard
                key={it.id}
                img={{ url: it.imageUrl, revisedPrompt: it.revisedPrompt, width: it.width, height: it.height }}
                onExpand={() => setExpanded({ url: it.imageUrl, revisedPrompt: it.revisedPrompt })}
              />
            ))}
          </div>
        </section>
      )}

      {gallery.items.length === 0 && !busy && results.length === 0 && (
        <div className="mt-8">
          <EmptyState
            icon={ImageIcon}
            title="Aún no has generado imágenes"
            description="Escribe una descripción y pulsa Generar para crear tu primer anuncio."
          />
        </div>
      )}

      {/* Expanded view with revised prompt */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setExpanded(null)}
          role="presentation"
        >
          <div className="bg-surface rounded-xl max-w-2xl w-full overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <img src={expanded.url} alt="Imagen generada ampliada" className="w-full max-h-[70vh] object-contain bg-ink-50" />
            <div className="p-4 flex items-start justify-between gap-3">
              <p className="text-xs text-ink-500 leading-snug">{expanded.revisedPrompt || 'Sin prompt revisado.'}</p>
              <div className="flex gap-2 shrink-0">
                <a href={expanded.url} download className="btn-ghost text-xs inline-flex items-center gap-1.5">
                  <Download size={13} /> Descargar
                </a>
                <button type="button" onClick={() => setExpanded(null)} className="btn-ghost text-xs">Cerrar</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultCard({ img, onExpand }) {
  // The action chips are white KNOCKOUTS floating over the artwork, so the
  // glyph must stay literally dark in both themes (text-ink-900 would invert
  // to white-on-white in dark mode). Focus also reveals the overlay, so the
  // actions are reachable by keyboard/touch, not just mouse hover.
  return (
    <div className="relative group rounded-lg overflow-hidden border border-ink-100 bg-ink-50">
      <img src={img.url} alt="Imagen generada" className="w-full aspect-square object-cover" />
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-end justify-end p-2 gap-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          onClick={onExpand}
          className="bg-white/90 text-black rounded-md p-1.5 hover:bg-white"
          aria-label="Ampliar"
        >
          <Maximize2 size={14} />
        </button>
        <a
          href={img.url}
          download
          className="bg-white/90 text-black rounded-md p-1.5 hover:bg-white"
          aria-label="Descargar"
        >
          <Download size={14} />
        </a>
      </div>
    </div>
  );
}
