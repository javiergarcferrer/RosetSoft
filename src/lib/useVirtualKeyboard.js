import { useEffect, useState } from 'react';

/**
 * Virtual-keyboard (soft keyboard) choreography for mobile.
 *
 * THE PROBLEM. On iOS the layout viewport does NOT shrink when the on-screen
 * keyboard opens; instead Safari shoves any `position: fixed; bottom: 0` chrome
 * UP to sit just above the keyboard — landing it right on top of the field the
 * user is editing (the quote TotalsDock, the client "Personalizar" pill, the
 * save toast). That covering/jumping is the "keyboard keeps getting in the way"
 * complaint.
 *
 * THE SIGNAL. `window.visualViewport` reports the area NOT covered by the
 * keyboard (its `height` shrinks; on some engines it `offsetTop`s instead), so
 * the hidden bottom inset = innerHeight − visualViewport.height − offsetTop.
 *
 * WHAT WE PUBLISH (one global listener, installed once from main.jsx):
 *   • `html.kb-open`       — keyboard up AND the focused field is OUT in the
 *                            page → bottom chrome slides away (`.kb-hide-when-open`).
 *   • `html.kb-keep-open`  — keyboard up AND the focused field lives INSIDE a
 *                            `[data-kb-keep]` container (e.g. the dock's own
 *                            discount/shipping inputs) → that chrome is LIFTED
 *                            above the keyboard instead of hidden, so you can
 *                            still see what you're typing.
 *   • `--rs-keyboard`      — the inset height in px, for the lift transform and
 *                            scroll padding.
 *
 * The CSS that consumes these lives in index.css (search "kb-open").
 */

// Ignore small viewport changes — the Safari URL bar collapsing, a hardware
// keyboard accessory bar, sub-pixel jitter. A real soft keyboard is far taller.
const KB_OPEN_THRESHOLD = 120;

function computeInset() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return 0;
  const inset = window.innerHeight - vv.height - vv.offsetTop;
  return inset > 0 ? inset : 0;
}

function focusInsideKeepZone() {
  const ae = document.activeElement;
  return !!(ae && typeof ae.closest === 'function' && ae.closest('[data-kb-keep]'));
}

// The soft keyboard can only be up while an editable field holds focus. We gate
// `kb-open` on this (not on the viewport inset alone) so the state clears the
// instant focus leaves the field — even when iOS fails to shrink visualViewport
// back to full on dismissal, or the focused field unmounts (e.g. switching the
// quote workspace away from the WhatsApp tab). Without it a stale inset could
// keep `kb-open` latched, stranding the bottom ModeBar off-screen with no way
// to bring it back.
function isEditableFocused() {
  const ae = document.activeElement;
  if (!ae) return false;
  const tag = ae.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae.isContentEditable === true;
}

let installed = false;

/**
 * Install the single global keyboard watcher. Idempotent — safe to call from
 * multiple entry points; only the first call wires listeners. No-ops where
 * `visualViewport` is unavailable (older browsers just keep the old behavior).
 */
export function installVirtualKeyboardWatcher() {
  if (installed || typeof window === 'undefined' || !window.visualViewport) return;
  installed = true;

  const root = document.documentElement;
  const vv = window.visualViewport;

  const apply = () => {
    const inset = computeInset();
    const open = inset > KB_OPEN_THRESHOLD && isEditableFocused();
    const keep = open && focusInsideKeepZone();
    root.classList.toggle('kb-open', open && !keep);
    root.classList.toggle('kb-keep-open', keep);
    root.style.setProperty('--rs-keyboard', `${open ? inset : 0}px`);
  };

  // `focusout` fires with document.activeElement momentarily on <body> even when
  // focus is just hopping to the next field — re-checking on the next frame lets
  // it settle, so moving between two inputs never flickers the bottom chrome
  // back in for a frame. A genuine dismissal (focus → nothing) clears it.
  let rafId = 0;
  const scheduleApply = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => { rafId = 0; apply(); });
  };

  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  // Focus can move between the page and a keep-zone WITHOUT a viewport resize
  // (the keyboard stays up), so re-evaluate on focus changes too.
  document.addEventListener('focusin', apply);
  document.addEventListener('focusout', scheduleApply);
  apply();
}

/**
 * React accessor for components that need the keyboard state in JS rather than
 * via the CSS classes (rare — prefer the `.kb-hide-when-open` / `[data-kb-keep]`
 * CSS hooks). Returns `{ open, height }`.
 */
export function useVirtualKeyboard() {
  const [state, setState] = useState({ open: false, height: 0 });
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return undefined;
    const apply = () => {
      const inset = computeInset();
      const open = inset > KB_OPEN_THRESHOLD;
      setState({ open, height: open ? inset : 0 });
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    apply();
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
    };
  }, []);
  return state;
}
