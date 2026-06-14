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
 *   • `--rs-keyboard`      — the OVERLAY inset in px (only the Safari-tab case;
 *                            see below), for the lift transform and scroll pad.
 *
 * TWO ENGINES, TWO SIGNALS. The inset above (`innerHeight − vv.height`) only
 * works in a Safari TAB, where the layout viewport stays full and the keyboard
 * just overlays it. In an installed iOS PWA the WKWebView itself RESIZES when
 * the keyboard opens, so `window.innerHeight` shrinks in lockstep with
 * `vv.height` and that subtraction collapses to ~0 — `kb-open` would never fire
 * and the bottom ModeBar stays wedged between the composer and the keyboard.
 * So we ALSO track a baseline (the tallest `vv.height` seen with no field
 * focused = keyboard closed) and treat any drop from it as the keyboard. We
 * detect on max(overlay, drop), but publish only the OVERLAY into
 * `--rs-keyboard`: in a resized webview the layout already excludes the
 * keyboard, so a lift transform would overshoot — there the resize itself does
 * the work and 0 lift is correct.
 *
 * The CSS that consumes these lives in index.css (search "kb-open").
 */

// Ignore small viewport changes — the Safari URL bar collapsing, a hardware
// keyboard accessory bar, sub-pixel jitter. A real soft keyboard is far taller.
const KB_OPEN_THRESHOLD = 120;

// The overlay inset = how much of the layout viewport the keyboard COVERS.
// Real in a Safari tab; ~0 in a resized PWA webview (handled via the baseline).
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

  // Baseline = the tallest visualViewport.height seen while NO field is focused
  // (keyboard closed), reset whenever the width changes (orientation flip). In a
  // resized PWA webview the live height drops below this when the keyboard opens,
  // which is the only reliable signal there. Tracked per width so a rotate that
  // legitimately changes the height doesn't read as a stuck keyboard.
  let baseHeight = 0;
  let baseWidth = 0;

  const apply = () => {
    const overlay = computeInset();
    const editable = isEditableFocused();
    // Only sample the baseline with the keyboard down; a focused field means it
    // may be up, so the current height can't be trusted as "full".
    if (!editable) {
      if (vv.width !== baseWidth) { baseWidth = vv.width; baseHeight = 0; }
      baseHeight = Math.max(baseHeight, vv.height);
    }
    const drop = baseHeight ? Math.max(0, baseHeight - vv.height) : 0;
    const inset = Math.max(overlay, drop);
    const open = inset > KB_OPEN_THRESHOLD && editable;
    const keep = open && focusInsideKeepZone();
    root.classList.toggle('kb-open', open && !keep);
    root.classList.toggle('kb-keep-open', keep);
    // Publish only the OVERLAY — in a resized webview (overlay ~0) the layout
    // already sits above the keyboard, so the lift must stay 0, not `inset`.
    root.style.setProperty('--rs-keyboard', `${open ? overlay : 0}px`);
    // Publish the live visual-viewport HEIGHT — the one signal that is correct
    // in BOTH engines: in a Safari tab it shrinks as the keyboard overlays, in a
    // PWA it shrinks as the webview resizes. A viewport-locked surface (the
    // WhatsApp inbox) sizes its column to this so the composer always rests flush
    // on the keyboard's top edge, with no dvh guesswork and no dead gap. We don't
    // gate it on `open`: it must stay accurate while the keyboard is down too, so
    // the column is full-height at rest. (`offsetTop` is folded in so a Safari
    // tab that pushes the visual viewport down still measures the visible band.)
    root.style.setProperty('--rs-vvh', `${Math.round(vv.height + vv.offsetTop)}px`);
    // The visual viewport as a fixed-positioning RECTANGLE: its top edge
    // (`offsetTop`, non-zero when a Safari tab pushes the viewport down) and its
    // raw height (NOT folded with offsetTop). A surface that pins itself
    // `position: fixed; top: var(--rs-vv-top); height: var(--rs-vv-height)` then
    // covers EXACTLY the area not hidden by the keyboard, on every engine — so a
    // composer at its bottom rests flush on the keyboard with zero magic-number
    // height math (the mobile WhatsApp thread, see .rs-thread-mobile in index.css).
    root.style.setProperty('--rs-vv-top', `${Math.round(vv.offsetTop)}px`);
    root.style.setProperty('--rs-vv-height', `${Math.round(vv.height)}px`);
    // Record the keyboard's own height the moment it's up, so the WhatsApp-style
    // attachment tray (ChatThread) can take its EXACT footprint when the box is
    // blurred to raise it. Only published on a real measurement (open) and left
    // sticky otherwise — the tray reads the last-known height; before the
    // keyboard has ever opened the var is unset and CSS falls back to a sheet.
    if (open) root.style.setProperty('--rs-kb-height', `${Math.round(inset)}px`);
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
