import { useEffect } from 'react';

/**
 * Close-on-outside-click + close-on-Escape for the desktop popover / menu
 * surfaces in the search header (SortMenu, FilterPopover's desktop form).
 *
 * Why a shared hook: both menus need the exact same dismiss semantics, and
 * getting them subtly different (one closes on Esc, the other doesn't; one
 * treats a click on its own trigger as "outside" and immediately reopens)
 * is the kind of papercut that makes a hand-rolled menu feel cheap next to
 * the native <select> we use elsewhere. Centralising it keeps every menu in
 * the header behaving identically.
 *
 * `ref` is the menu's outermost wrapper (trigger + panel live inside it, so
 * a click on the trigger is NOT "outside" and won't fight the toggle). The
 * listeners only mount while `open` is true, so a page with several closed
 * menus pays nothing.
 *
 * pointerdown (not click) so the dismiss fires before a click lands on
 * whatever is underneath — matches the feel of iOS sheets dismissing the
 * instant your finger touches outside, and avoids the "click selected the
 * thing behind the menu I was only trying to close" surprise.
 */
export default function useDismissable(open, onClose, ref) {
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, ref]);
}
