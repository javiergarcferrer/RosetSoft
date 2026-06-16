// Device-media picker for the Instagram composer. Picks files, runs every IMAGE
// through the IG cropper (frame it exactly as Instagram will show it), uploads
// the result to the public `social` bucket, and hands the parent an ordered list
// of { url, type }. Videos skip the cropper and upload as-is. Single-media modes
// keep one item; carousel allows 2–10 with up/down/remove reordering (an
// accessible, touch-safe alternative to drag-and-drop) and locks every slide to
// the first slide's ratio, since IG renders a carousel at one shared aspect.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, Film, X, ArrowUp, ArrowDown, RefreshCw, Crop } from 'lucide-react';
import { uploadSocialMedia, uploadSocialImage, removeSocialMedia } from '../db/socialUpload.js';
import ImageCropper from './instagram/ImageCropper.jsx';

let keySeq = 0;
const isVideoFile = (f) => /^video\//.test(f?.type || '');

export default function MediaPicker({ items, onChange, max = 1, accept = 'image/*,video/*', mode = 'feed' }) {
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState(null);
  const [queue, setQueue] = useState([]); // files awaiting processing (crop/upload)
  const [pending, setPending] = useState(null); // { file, key } currently in the cropper
  const [carouselRatioId, setCarouselRatioId] = useState(null); // locked across slides
  const inputRef = useRef(null);

  // Append a finished upload, honoring the per-mode cap (single modes replace).
  const commitMedia = useCallback((media) => {
    onChange((prev) => {
      const next = [...prev, { ...media, key: `m${keySeq++}` }];
      return max === 1 ? next.slice(-1) : next.slice(0, max);
    });
  }, [max, onChange]);

  // Pull the next queued file: videos upload straight away, images open the
  // cropper (which blocks the queue until the dealer confirms or cancels).
  useEffect(() => {
    if (pending || !queue.length) return;
    const [next, ...rest] = queue;
    if (isVideoFile(next)) {
      setQueue(rest);
      setBusy((b) => b + 1);
      uploadSocialMedia(next)
        .then(commitMedia)
        .catch((e) => setError(e?.message || 'No se pudo subir el archivo'))
        .finally(() => setBusy((b) => Math.max(0, b - 1)));
    } else {
      setQueue(rest);
      setPending({ file: next, key: keySeq++ });
    }
  }, [pending, queue, commitMedia]);

  // Free the carousel ratio lock once the set empties or the mode leaves carousel.
  useEffect(() => {
    if (mode !== 'carousel' || items.length === 0) setCarouselRatioId(null);
  }, [mode, items.length]);

  const inflight = queue.length + (pending ? 1 : 0);

  const addFiles = useCallback((fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setError(null);
    if (max === 1) { setQueue([files[files.length - 1]]); return; } // single → last pick replaces
    const room = Math.max(0, max - items.length - inflight);
    if (room <= 0) return;
    setQueue((q) => [...q, ...files.slice(0, room)]);
  }, [max, items.length, inflight]);

  const onCropConfirm = useCallback(async (croppedFile, ratioId) => {
    setPending(null);
    if (mode === 'carousel' && !carouselRatioId) setCarouselRatioId(ratioId);
    setBusy((b) => b + 1);
    try {
      commitMedia(await uploadSocialImage(croppedFile));
    } catch (e) {
      setError(e?.message || 'No se pudo subir la imagen');
    } finally {
      setBusy((b) => Math.max(0, b - 1));
    }
  }, [mode, carouselRatioId, commitMedia]);

  // Cancelling the cropper drops the rest of this pick batch — a clean "stop".
  const onCropCancel = useCallback(() => { setPending(null); setQueue([]); }, []);

  const removeAt = useCallback((i) => {
    const it = items[i];
    if (it?.url) removeSocialMedia(it.url);
    onChange((prev) => prev.filter((_, idx) => idx !== i));
  }, [items, onChange]);

  const move = useCallback((i, dir) => {
    onChange((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, [onChange]);

  const full = max > 1 && items.length + inflight >= max;
  const working = busy > 0 || inflight > 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {items.map((it, i) => (
          <div key={it.key} className="relative h-24 w-24 overflow-hidden rounded-lg bg-ink-100 ring-1 ring-ink-200">
            {it.type === 'video'
              ? <video src={it.url} className="h-full w-full object-cover" muted playsInline />
              : <img src={it.url} alt="" className="h-full w-full object-cover" />}
            {it.type === 'video' && <Film size={13} className="absolute top-1 left-1 text-white drop-shadow" />}
            <button type="button" onClick={() => removeAt(i)} aria-label="Quitar" className="absolute top-1 right-1 grid h-6 w-6 place-items-center rounded-full bg-black/55 text-white hover:bg-black/75">
              <X size={13} />
            </button>
            {max > 1 && (
              <div className="absolute bottom-1 left-1 right-1 flex justify-between">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Mover antes" className="grid h-6 w-6 place-items-center rounded-full bg-black/55 text-white disabled:opacity-30"><ArrowUp size={12} /></button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label="Mover después" className="grid h-6 w-6 place-items-center rounded-full bg-black/55 text-white disabled:opacity-30"><ArrowDown size={12} /></button>
              </div>
            )}
          </div>
        ))}
        {/* in-flight placeholder so the grid doesn't jump while uploading */}
        {working && (
          <div className="grid h-24 w-24 place-items-center rounded-lg bg-ink-100 ring-1 ring-ink-200 text-ink-400">
            <RefreshCw size={18} className="animate-spin" />
          </div>
        )}
        {!full && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="grid h-24 w-24 place-items-center rounded-lg border-2 border-dashed border-ink-200 text-ink-400 hover:border-brand-400 hover:text-brand-600"
            aria-label="Añadir imagen o video"
          >
            <ImagePlus size={20} />
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={max > 1}
        className="hidden"
        onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
      />
      <div className="flex items-center justify-between text-xs text-ink-400">
        <span className="inline-flex items-center gap-1">
          <Crop size={12} />
          {max > 1 ? `${items.length}/${max} · recorta cada imagen al formato de IG` : 'Imagen (con recorte de IG) o video'}
        </span>
        {working && <span className="text-ink-500">Procesando…</span>}
      </div>
      {error && <div className="text-xs text-red-600">{error}</div>}

      {pending && (
        <ImageCropper
          key={pending.key}
          file={pending.file}
          mode={mode}
          lockedRatioId={mode === 'carousel' ? carouselRatioId : null}
          onConfirm={onCropConfirm}
          onCancel={onCropCancel}
        />
      )}
    </div>
  );
}
