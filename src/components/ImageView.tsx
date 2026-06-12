import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { db } from '../db/database.js';
import { publicImageUrl } from '../db/supabaseClient.js';
import { sizedExternalUrl, SCREEN_IMG_WIDTH } from '../lib/catalogImages.js';
import { ImageOff } from 'lucide-react';

export interface ImageViewProps {
  id: string | null | undefined;
  /**
   * Rendered when `id` is absent or resolves to nothing — e.g. a Ligne Roset
   * swatch URL derived from a color code. A loaded `id` (an uploaded photo)
   * always wins; if the chosen URL fails to load we fall to the placeholder.
   */
  fallbackUrl?: string | null;
  alt?: string;
  className?: string;
  placeholderClassName?: string;
  style?: CSSProperties;
  /**
   * When true, hovering the (small) image on a fine-pointer device pops up an
   * enlarged floating preview next to it. No-op on touch (no real hover) — the
   * customer-facing preview keeps its tap-to-zoom Modal there.
   */
  hoverPreview?: boolean;
}

interface PreviewBox { left: number; top: number; width: number }

function canHover(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

/**
 * Renders an image stored in Supabase Storage by its image-table id.
 * Falls back to a neutral placeholder when missing.
 */
export default function ImageView({ id, fallbackUrl = null, alt = '', className = '', placeholderClassName = '', style, hoverPreview = false }: ImageViewProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [errored, setErrored] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [preview, setPreview] = useState<PreviewBox | null>(null);

  useEffect(() => {
    let active = true;
    setErrored(false);
    if (!id) {
      setUrl(fallbackUrl);
      setMissing(!fallbackUrl);
      return () => { active = false; };
    }
    setMissing(false);
    db.images.get(id).then((rec: { storagePath?: string | null; externalUrl?: string | null } | null | undefined) => {
      if (!active) return;
      // A CDN pointer row (LSG catalog photo) serves straight from the store's
      // CDN — width-capped; bytes never live in our bucket.
      const u = (rec?.externalUrl ? sizedExternalUrl(rec.externalUrl, SCREEN_IMG_WIDTH) : null)
        || (rec?.storagePath ? publicImageUrl(rec.storagePath) : null)
        || fallbackUrl;
      setUrl(u);
      setMissing(!u);
    }).catch(() => {
      if (!active) return;
      setUrl(fallbackUrl);
      setMissing(!fallbackUrl);
    });
    return () => { active = false; };
  }, [id, fallbackUrl]);

  // Dismiss the floating preview if the page scrolls or resizes underneath it.
  useEffect(() => {
    if (!preview) return undefined;
    const close = () => setPreview(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [preview]);

  function openPreview() {
    if (!hoverPreview || !url || !canHover()) return;
    const el = imgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 12;
    const width = Math.min(420, Math.round(vw * 0.4));
    // Prefer to the right of the thumbnail; flip to the left when it would
    // overflow; clamp into the viewport either way.
    let left = r.right + margin;
    if (left + width > vw - margin) left = r.left - margin - width;
    if (left < margin) left = margin;
    // Keep the (variable-height) box on screen: reserve a generous estimate
    // and clamp the top edge so it never spills past the bottom.
    const estH = Math.min(Math.round(vh * 0.7), Math.round(width * 1.4));
    let top = r.top;
    if (top + estH > vh - margin) top = Math.max(margin, vh - margin - estH);
    if (top < margin) top = margin;
    setPreview({ left, top, width });
  }

  if (missing || !url || errored) {
    return (
      <div className={`flex items-center justify-center bg-ink-100 text-ink-400 ${placeholderClassName || className}`}>
        <ImageOff size={18} />
      </div>
    );
  }
  return (
    <>
      <img
        ref={imgRef}
        src={url}
        alt={alt}
        className={className}
        style={style}
        loading="lazy"
        onError={() => setErrored(true)}
        onMouseEnter={hoverPreview ? openPreview : undefined}
        onMouseLeave={hoverPreview ? () => setPreview(null) : undefined}
      />
      {preview && createPortal(
        <div
          className="fixed z-[80] pointer-events-none rounded-lg overflow-hidden bg-white shadow-2xl border border-ink-200"
          style={{ left: preview.left, top: preview.top, width: preview.width }}
        >
          <img src={url} alt={alt} className="block w-full h-auto max-h-[70vh] object-contain bg-white" />
        </div>,
        document.body,
      )}
    </>
  );
}
