import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Sheet-on-mobile, dialog-on-desktop. Below sm we anchor to the bottom and
 * fill the width edge-to-edge with a grab handle — feels native on iOS and
 * keeps controls in thumb reach. From sm up it reverts to the centered
 * dialog. Body scroll is locked while open so iOS doesn't rubber-band the
 * page underneath, and the close button is sized to a 44pt touch target.
 */
export default function Modal({ open, onClose, title, children, footer, size = 'md' }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;
  const widths = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl' };
  // Render at <body> via a portal. A modal must NOT live inside the DOM of
  // whatever opened it: an ancestor with `opacity` (e.g. a dimmed
  // non-selected alternative line, opacity-70) tints its whole subtree —
  // including this fixed overlay — making the dialog translucent with the
  // page bleeding through; and an ancestor with `container-type` (the
  // quote-line container queries) or `transform` re-bases `position: fixed`
  // to that box instead of the viewport. Portaling to body escapes both.
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center sm:p-4 animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Refined backdrop: warm dark + subtle blur so content behind reads as
          "there" but clearly behind — same technique as Linear and Stripe. */}
      <div
        className="fixed inset-0 bg-ink-900/50 backdrop-blur-[2px] transition-opacity"
        onClick={onClose}
        aria-hidden
      />
      <div
        className={`relative w-full ${widths[size] || widths.md} bg-white shadow-pop border border-ink-100/60 flex flex-col rounded-t-2xl sm:rounded-2xl max-h-[92vh] sm:max-h-[88vh] pb-[env(safe-area-inset-bottom)] sm:pb-0 animate-in slide-in-from-bottom-2 sm:slide-in-from-bottom-0 sm:zoom-in-95 duration-200`}
      >
        {/* iOS-style grab handle (decorative — pointer doesn't drag, but the
            visual cue makes the sheet read as dismissible). */}
        <div className="sm:hidden pt-3 pb-1 flex justify-center" aria-hidden>
          <div className="w-10 h-[3px] rounded-full bg-ink-200" />
        </div>
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-ink-100">
          <h2 className="font-display text-lg font-semibold text-ink-900 break-words leading-snug pr-3 min-w-0">{title}</h2>
          <button
            onClick={onClose}
            className="btn-icon -mr-1.5 text-ink-400 hover:text-ink-600 hover:bg-ink-100 transition-colors"
            aria-label="Cerrar"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="overflow-y-auto overflow-x-hidden overscroll-contain px-4 sm:px-6 py-5 flex-1 min-w-0">{children}</div>
        {footer && (
          <div className="px-4 sm:px-6 py-4 border-t border-ink-100 bg-ink-50/50 sm:rounded-b-2xl flex flex-wrap items-center justify-end gap-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
