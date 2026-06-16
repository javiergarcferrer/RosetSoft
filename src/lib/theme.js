/**
 * Theme (light / dark / system) — the runtime half of the variable-driven
 * theming system. The COLORS live in CSS (src/index.css `:root` vs `.dark`,
 * surfaced through Tailwind in tailwind.config.js); this module only decides
 * WHEN the `.dark` class sits on <html>.
 *
 * Two cooperating pieces:
 *   1. The inline boot script in index.html sets `.dark` BEFORE first paint so
 *      there's no flash of the wrong theme (FOUC). It is the source of truth at
 *      load; this module must agree with it exactly (same key, same rules).
 *   2. This module owns the live behaviour after boot: applying the dealer's
 *      choice, persisting it, and — while on "system" — following the OS as it
 *      flips (e.g. macOS auto night shift) without a reload.
 *
 * Preference model (mirrors Tailwind's documented convention):
 *   'light' | 'dark'  → explicit override, persisted.
 *   'system'          → follow `prefers-color-scheme`; persisted as the absence
 *                       of an override so a fresh device inherits the OS.
 *
 * Public client surfaces (the shared quote link `/#/q/…` and the storefront
 * `/#/tienda`) are deliberately pinned to light: they're the dealer's printed
 * "paper", shown on a customer's device, and must read identically to the PDF
 * regardless of anyone's theme. `isPublicRoute()` gates that, matched in the
 * boot script too.
 */

const KEY = 'rs.theme';
const VALUES = new Set(['light', 'dark', 'system']);

/** The customer-facing, always-light routes (HashRouter paths). */
export function isPublicRoute(hash = (typeof location !== 'undefined' ? location.hash : '')) {
  return hash.indexOf('#/q/') === 0
    || hash.indexOf('#/tienda') === 0
    || hash.indexOf('#/embed') === 0
    || hash.indexOf('#/eliminar-datos') === 0;
}

function systemPrefersDark() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** The stored preference, defaulting to 'system' (and self-healing bad values). */
export function getThemePreference() {
  try {
    const v = localStorage.getItem(KEY);
    return VALUES.has(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Does a given preference resolve to dark right now (honouring the OS)? */
export function resolveIsDark(pref = getThemePreference()) {
  if (isPublicRoute()) return false;
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  return systemPrefersDark();
}

/** Toggle the `.dark` class to match a resolved dark/light decision. */
function paint(isDark) {
  try {
    document.documentElement.classList.toggle('dark', isDark);
  } catch {
    /* SSR / no document — no-op */
  }
}

/**
 * Persist + apply a preference. 'system' is stored as the *absence* of a key so
 * the next device with no choice inherits the OS, matching the boot script.
 */
export function setThemePreference(pref) {
  const next = VALUES.has(pref) ? pref : 'system';
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    /* private mode / quota — apply anyway, just don't persist */
  }
  paint(resolveIsDark(next));
  return next;
}

let installed = false;
/**
 * Idempotent boot. Re-applies the stored preference (the inline script already
 * did the first paint; this re-affirms it after the bundle loads) and wires the
 * OS listener so a "system" user follows night/day shifts live. Returns a
 * disposer, though in practice it lives for the tab's lifetime.
 */
export function initTheme() {
  if (installed || typeof window === 'undefined') return () => {};
  installed = true;
  paint(resolveIsDark());
  let mq;
  try {
    mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (getThemePreference() === 'system') paint(resolveIsDark('system'));
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  } catch {
    return () => {};
  }
}
