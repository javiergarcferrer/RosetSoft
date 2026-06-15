// PostThumb + PostPeek — the shared post-preview primitives for the Instagram
// command center. A thumbnail that hover-pops an enlarged preview and clicks
// into the full publication modal (photo, engagement, caption, comment thread).
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink } from 'lucide-react';
import Modal from '../Modal.jsx';

// A small, clickable post thumbnail that opens the peek popup. Renders nothing
// when there's no image (e.g. a video-only scheduled post with no preview).
//
// HOVER (fine-pointer only) pops a floating enlarged preview — no click needed,
// mirroring the materials-catalog image popup. CLICK opens the full
// publication modal. We own the preview state (not ImageView's) so we can
// dismiss it the instant the modal opens, never letting it linger on top.
export function PostThumb({ src, onClick, className = 'w-11 h-11' }) {
  const ref = useRef(null);
  const [box, setBox] = useState(null);
  useEffect(() => {
    if (!box) return undefined;
    const close = () => setBox(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [box]);
  if (!src) return null;
  const canHover = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const openPreview = () => {
    if (!canHover) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 12;
    const width = Math.min(360, Math.round(vw * 0.42));
    // The thumbnails live in the right column → prefer popping to the LEFT;
    // flip right when there's no room; clamp into the viewport either way.
    let left = r.left - margin - width;
    if (left < margin) left = r.right + margin;
    if (left + width > vw - margin) left = Math.max(margin, vw - margin - width);
    const estH = Math.min(Math.round(vh * 0.7), Math.round(width * 1.25));
    let top = r.top;
    if (top + estH > vh - margin) top = Math.max(margin, vh - margin - estH);
    if (top < margin) top = margin;
    setBox({ left, top, width });
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => { setBox(null); onClick?.(); }}
        onMouseEnter={openPreview}
        onMouseLeave={() => setBox(null)}
        className={`flex-none ${className} rounded-md overflow-hidden bg-ink-100 border border-ink-100 cursor-zoom-in hover:ring-2 hover:ring-brand-300 transition`}
        aria-label="Ver la publicación"
        title="Pasa el cursor para ampliar — clic para la publicación completa"
      >
        <img src={src} alt="" className="w-full h-full object-cover" loading="lazy" />
      </button>
      {box && createPortal(
        <div
          className="fixed z-[80] pointer-events-none rounded-lg overflow-hidden bg-white shadow-2xl border border-ink-200"
          style={{ left: box.left, top: box.top, width: box.width }}
        >
          <img src={src} alt="" className="block w-full h-auto max-h-[70vh] object-contain bg-white" />
        </div>,
        document.body,
      )}
    </>
  );
}

// The full publication view (on click): the photo, engagement, caption and the
// comment thread. Built from a comment (its own comment highlighted) or a post.
export function PostPeek({ post, onClose }) {
  const others = (post?.commentList || []).filter((c) => !post.highlight || c.id !== post.highlight.id);
  const moreCount = post ? Math.max(0, (post.comments || 0) - (post.commentList?.length || 0)) : 0;
  return (
    <Modal open={!!post} onClose={onClose} title={post?.title || 'Publicación'} size="lg">
      {post && (
        <div className="space-y-4">
          {post.mediaUrl ? (
            <div className="flex items-center justify-center overflow-hidden rounded-xl bg-ink-50">
              <img src={post.mediaUrl} alt="" className="max-h-[52vh] w-auto max-w-full object-contain" />
            </div>
          ) : (
            <div className="flex items-center justify-center h-40 rounded-xl bg-ink-100 text-sm text-ink-400">
              Sin imagen disponible
            </div>
          )}

          {/* engagement + meta */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-500">
            {post.likes != null && <span className="tabular-nums">♥ {post.likes.toLocaleString('en-US')} me gusta</span>}
            {post.comments != null && <span className="tabular-nums">💬 {post.comments.toLocaleString('en-US')} comentarios</span>}
            {post.when && <span className="text-ink-400">{post.when}</span>}
            {post.permalink && (
              <a
                href={post.permalink}
                target="_blank"
                rel="noreferrer"
                className="ml-auto flex items-center gap-1 text-brand-700 hover:underline"
              >
                <ExternalLink size={13} /> Ver publicación
              </a>
            )}
          </div>

          {post.caption && (
            <p className="text-sm leading-relaxed text-ink-700 whitespace-pre-wrap">{post.caption}</p>
          )}

          {/* comment thread */}
          {(post.highlight || others.length > 0) && (
            <div className="border-t border-ink-100 pt-3 space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-ink-400">Comentarios</div>
              {post.highlight && (
                <div className="rounded-lg bg-brand-50 px-3 py-2 text-sm">
                  {post.highlight.username ? <span className="font-medium text-ink-900">@{post.highlight.username} </span> : null}
                  <span className="text-ink-700">{post.highlight.text}</span>
                </div>
              )}
              {others.map((c) => (
                <div key={c.id || `${c.username}-${c.at}`} className="text-sm">
                  {c.username ? <span className="font-medium text-ink-900">@{c.username} </span> : null}
                  <span className="text-ink-700">{c.text}</span>
                  {c.ago && <span className="ml-2 text-xs text-ink-400">{c.ago}</span>}
                </div>
              ))}
              {moreCount > 0 && <div className="text-xs text-ink-400">y {moreCount} más…</div>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
