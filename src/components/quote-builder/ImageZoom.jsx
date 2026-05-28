import { useState } from 'react';
import ImageView from '../ImageView.jsx';
import Modal from '../Modal.jsx';

/**
 * A displayed image that ENLARGES ON HOVER (a floating preview, via
 * ImageView's `hoverPreview`) on fine-pointer devices — no click needed. On
 * touch (no real hover) and for keyboard users, clicking/Enter still opens a
 * centered lightbox (the shared Modal) so the photo / swatch is reachable
 * everywhere. Falls back to a plain, non-interactive ImageView when there's no
 * image id (the placeholder box).
 */
export default function ImageZoom({ id, fallbackUrl = null, className, alt = '' }) {
  const [open, setOpen] = useState(false);
  if (!id && !fallbackUrl) return <ImageView id={id} className={className} alt={alt} />;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex-shrink-0 block appearance-none p-0 bg-transparent border-0 cursor-zoom-in rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-900 focus-visible:ring-offset-1"
        aria-label="Ampliar imagen"
        title="Pasa el cursor para ampliar — o toca para verla en grande"
      >
        <ImageView id={id} fallbackUrl={fallbackUrl} className={className} alt={alt} hoverPreview />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} size="xl">
        <div className="flex items-center justify-center">
          <ImageView id={id} fallbackUrl={fallbackUrl} alt={alt} className="max-h-[78vh] w-auto max-w-full object-contain rounded-md" />
        </div>
      </Modal>
    </>
  );
}
