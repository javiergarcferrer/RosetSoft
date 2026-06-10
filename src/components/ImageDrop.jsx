import { useRef, useState } from 'react';
import { Upload, X, Link as LinkIcon } from 'lucide-react';
import { saveImage, deleteImage } from '../db/database.js';
import ImageView from './ImageView.jsx';

/**
 * Image upload widget that stores blobs in IndexedDB and returns the image id.
 * Supports: file picker, drag-and-drop, paste, and "fetch from URL"
 * (URL fetch only works when the remote allows CORS — useful for swatch URLs).
 */
export default function ImageDrop({
  imageId,
  onChange,
  kind,
  ownerId,
  label = 'Image',
  className = '',
  imgClassName = 'h-32 w-full object-cover rounded-md',
  allowUrl = true,
}) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleFiles(files) {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      // Fire-and-forget the old-image delete: the new upload uses a fresh id
      // so deletion only affects storage cleanup and never the new record.
      // Awaiting it serialised every replacement upload behind a network
      // round-trip; running it in parallel cuts perceived latency in half
      // for replace-image flows.
      const prevId = imageId;
      if (prevId) deleteImage(prevId).catch(() => {});
      const id = await saveImage({ kind, ownerId, file });
      onChange(id);
    } finally {
      setBusy(false);
    }
  }

  async function handlePaste(e) {
    const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    await handleFiles([item.getAsFile()]);
  }

  async function fetchFromUrl() {
    const url = prompt('Paste image URL (works if the site allows cross-origin loading):');
    if (!url) return;
    setBusy(true);
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error('Fetch failed: ' + res.status);
      const blob = await res.blob();
      const prevId = imageId;
      if (prevId) deleteImage(prevId).catch(() => {});
      const id = await saveImage({ kind, ownerId, file: blob });
      onChange(id);
    } catch (e) {
      alert('Could not fetch image. The website may block cross-origin downloads.\n\nTip: open the image in a new tab, save it locally, then drop the file here.\n\nDetails: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (imageId) await deleteImage(imageId).catch(() => {});
    onChange(null);
  }

  return (
    <div className={className}>
      <div className="label">{label}</div>
      <div
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        onPaste={handlePaste}
        tabIndex={0}
        className={`relative rounded-md border-2 border-dashed transition-colors group focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
          dragging ? 'border-brand-500 bg-brand-50' : 'border-ink-200 bg-ink-50'
        }`}
      >
        {imageId ? (
          <>
            <ImageView id={imageId} className={imgClassName} />
            <button
              type="button"
              onClick={clear}
              className="absolute top-1.5 right-1.5 inline-flex items-center justify-center w-8 h-8 coarse:w-11 coarse:h-11 bg-white/95 hover:bg-white active:bg-ink-50 text-ink-900 rounded-md shadow-sm border border-ink-200 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 coarse:opacity-100 transition-opacity"
              title="Remove image"
            >
              <X size={14} />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="w-full h-32 min-h-[44px] flex flex-col items-center justify-center gap-1 text-ink-500 hover:text-ink-700 text-xs"
          >
            <Upload size={20} />
            <span>{busy ? 'Uploading…' : 'Click, drop, or paste'}</span>
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-1.5">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="text-xs font-medium text-ink-500 hover:text-ink-900 min-h-8 coarse:min-h-11 inline-flex items-center transition-colors"
        >
          Choose file
        </button>
        {allowUrl && (
          <>
            <span className="text-ink-300">·</span>
            <button
              type="button"
              onClick={fetchFromUrl}
              className="text-xs font-medium text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 min-h-8 coarse:min-h-11 transition-colors"
            >
              <LinkIcon size={11} /> From URL
            </button>
          </>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}
