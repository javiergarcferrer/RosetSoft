import { useRef, useState } from 'react';
import type { ClipboardEvent, MouseEvent } from 'react';
import { Camera, X, Loader2 } from 'lucide-react';
import { saveImage, deleteImage } from '../../db/database.js';
import ImageView from '../ImageView.js';

export interface ThumbnailProps {
  imageId: string | null | undefined;
  onChange: (id: string | null) => void;
  kind: string;
  ownerId?: string | null;
  /**
   * Tailwind size class — defaults to 56 px on phones, 64 px on sm+.
   * Same square footprint regardless of fill state so the row layout
   * never reflows when an image is added or removed.
   */
  sizeClass?: string;
  /** Pop an enlarged floating preview when the filled thumbnail is hovered. */
  hoverPreview?: boolean;
}

/**
 * Compact inline image picker — fixed square footprint, three states:
 *   - Empty   : subtle dashed square with a camera glyph; tap opens picker
 *   - Loading : spinner overlay
 *   - Filled  : image with a small clear button on the corner (hover on
 *               fine pointers, always visible on touch)
 *
 * Why a separate component instead of reusing ImageDrop here: that widget
 * renders a 128-px tall empty zone with a "Choose file / From URL" footer
 * and a heading <div class="label">. It's the right primitive for hero
 * uploads (Settings logo, customer profile photo); in a list row it
 * crowds out the actual data. Thumbnail is purpose-built for inline use.
 *
 * Interaction parity with the heavy uploader:
 *   - tap / click   -> native file picker
 *   - drag and drop -> upload (desktop)
 *   - paste image   -> upload when the thumbnail has focus
 */
export default function Thumbnail({
  imageId, onChange, kind, ownerId, hoverPreview = false,
  // Tailwind size class. Sized for visibility: 80 px on phones (the
  // earlier 56 px tile got lost in the line-item card's busy
  // composition — the empty-state dashed border + tiny camera icon
  // read as "ornament" instead of "tappable photo slot", and dealers
  // missed it entirely on mobile). 96 px from sm up where the card
  // has more horizontal room.
  sizeClass = 'w-20 h-20 sm:w-24 sm:h-24',
}: ThumbnailProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function handleFiles(files: FileList | File[] | null | undefined) {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      // Fire-and-forget the prior image deletion: the new upload has a
      // fresh id so a failed cleanup never orphans the visible record.
      const prevId = imageId;
      if (prevId) deleteImage(prevId).catch(() => {});
      const id = await saveImage({ kind, ownerId, file });
      onChange(id);
    } finally {
      setBusy(false);
    }
  }

  async function handlePaste(e: ClipboardEvent<HTMLButtonElement>) {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const file = item.getAsFile();
    if (file) await handleFiles([file]);
  }

  async function clear(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    e.preventDefault();
    if (imageId) await deleteImage(imageId).catch(() => {});
    onChange(null);
  }

  return (
    <div className={`${sizeClass} relative flex-shrink-0 group/thumb`}>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        onPaste={handlePaste}
        disabled={busy}
        title={imageId ? 'Cambiar imagen' : 'Añadir imagen'}
        aria-label={imageId ? 'Cambiar imagen del artículo' : 'Añadir imagen al artículo'}
        className={`absolute inset-0 rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-900 focus-visible:ring-offset-1 ${
          imageId
            ? 'bg-white border border-ink-200 hover:border-ink-400 overflow-hidden'
            : dragging
              ? 'border-2 border-dashed border-brand-500 bg-brand-50'
              : 'border-2 border-dashed border-ink-300 bg-ink-50 hover:bg-ink-100 hover:border-ink-500 active:bg-ink-100'
        }`}
      >
        {imageId ? (
          <ImageView id={imageId} hoverPreview={hoverPreview} className="w-full h-full object-contain" />
        ) : (
          // Stack the camera icon over a small "Foto" caption so the
          // empty state reads as an explicit slot, not as a decorative
          // square. Tested on mobile sun-glare — the larger icon +
          // label is what makes the dealer realise it's tappable.
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-ink-500">
            {busy
              ? <Loader2 size={22} className="animate-spin" />
              : <Camera size={22} strokeWidth={1.5} />}
            {!busy && (
              <span className="eyebrow-xs font-medium tracking-wide select-none">
                Foto
              </span>
            )}
          </span>
        )}
        {busy && imageId && (
          <span className="absolute inset-0 flex items-center justify-center bg-white/70">
            <Loader2 size={16} className="animate-spin text-ink-700" />
          </span>
        )}
      </button>
      {imageId && !busy && (
        <button
          type="button"
          onClick={clear}
          className="absolute -top-1.5 -right-1.5 w-5 h-5 inline-flex items-center justify-center bg-white border border-ink-200 rounded-full text-ink-600 hover:text-ink-900 hover:border-ink-400 shadow-sm opacity-0 group-hover/thumb:opacity-100 focus:opacity-100 transition-opacity coarse:opacity-100"
          aria-label="Quitar imagen"
        >
          <X size={11} />
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
}
