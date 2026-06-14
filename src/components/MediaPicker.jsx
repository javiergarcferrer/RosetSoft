// Device-media picker for the Instagram composer. Uploads files to the public
// `social` bucket (images re-encoded to IG-spec JPEG) and hands the parent an
// ordered list of { url, type }. Single-media modes keep one item; carousel
// allows 2–10 with up/down/remove reordering (an accessible, touch-safe
// alternative to drag-and-drop per the responsive-UX research).
import { useCallback, useRef, useState } from 'react';
import { ImagePlus, Film, X, ArrowUp, ArrowDown, RefreshCw } from 'lucide-react';
import { uploadSocialMedia, removeSocialMedia } from '../db/socialUpload.js';

let keySeq = 0;

export default function MediaPicker({ items, onChange, max = 1, accept = 'image/*,video/*' }) {
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const addFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setError(null);
    const room = Math.max(0, max - items.length);
    const take = files.slice(0, room === 0 ? max : room);
    setBusy((b) => b + take.length);
    for (const file of take) {
      try {
        const media = await uploadSocialMedia(file);
        onChange((prev) => {
          const next = [...prev, { ...media, key: `m${keySeq++}` }];
          // Single-media modes keep only the latest pick.
          return max === 1 ? next.slice(-1) : next.slice(0, max);
        });
      } catch (e) {
        setError(e?.message || 'No se pudo subir el archivo');
      } finally {
        setBusy((b) => Math.max(0, b - 1));
      }
    }
  }, [items.length, max, onChange]);

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

  const full = items.length >= max;

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
        {!full && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="grid h-24 w-24 place-items-center rounded-lg border-2 border-dashed border-ink-200 text-ink-400 hover:border-brand-400 hover:text-brand-600"
          >
            {busy > 0 ? <RefreshCw size={20} className="animate-spin" /> : <ImagePlus size={20} />}
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
        <span>{max > 1 ? `${items.length}/${max} · imágenes o videos` : 'Imagen o video desde tu dispositivo'}</span>
        {busy > 0 && <span className="text-ink-500">Subiendo…</span>}
      </div>
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}
