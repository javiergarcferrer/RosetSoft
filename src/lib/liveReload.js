/**
 * Auto-reload the SPA when a new build is deployed.
 *
 * The problem: a dealer keeps the app open across a deploy. Their tab is
 * still running the old bundle, and worse, its hashed chunk URLs no longer
 * exist on the server — so the next lazy import (Export PDF, etc.) 404s.
 * `safeDynamicImport` already recovers REACTIVELY (reload on a failed
 * import); this watcher is the PROACTIVE half: it notices the new deploy
 * and reloads before anything breaks.
 *
 * How: every build is stamped with VITE_BUILD_ID (the git commit SHA on
 * Vercel) and that same id is written to /version.json (see vite.config.js).
 * We poll version.json and, when the deployed id differs from the one this
 * tab booted with, reload.
 *
 * Safety:
 *   - Never reloads while the user is typing — the app auto-saves on a
 *     debounce, and reloading over an in-flight keystroke could drop it.
 *     We just catch the new version on the next poll / focus once they stop.
 *   - A small per-session reload budget guards against a loop if a stale
 *     CDN copy of version.json ever disagrees with the live bundle.
 *   - Silent on dev / offline (version.json 404s or fetch fails → no-op);
 *     the dev server has its own HMR.
 */

const BOOT_ID = import.meta.env.VITE_BUILD_ID || '';
const POLL_MS = 60_000;
const RELOAD_LOG_KEY = 'roset-version-reloads';

let started = false;

function isTyping() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

async function fetchDeployedId() {
  try {
    // Cache-bust + no-store so we read the live file, not an edge/browser
    // cached copy. The leading slash targets the site root (Vercel serves
    // the SPA there); version.json is excluded from the SPA rewrite.
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data.id === 'string' ? data.id : null;
  } catch {
    return null; // offline / transient — try again next tick
  }
}

/** Bail out if we've already reloaded a couple of times in the last minute. */
function reloadBudgetExhausted() {
  const now = Date.now();
  let log = [];
  try {
    log = JSON.parse(sessionStorage.getItem(RELOAD_LOG_KEY) || '[]');
  } catch {
    log = [];
  }
  log = (Array.isArray(log) ? log : []).filter((t) => now - t < 60_000);
  if (log.length >= 2) return true;
  log.push(now);
  try {
    sessionStorage.setItem(RELOAD_LOG_KEY, JSON.stringify(log));
  } catch {
    /* private mode / quota — proceed without the guard */
  }
  return false;
}

let checking = false;
async function check() {
  if (!BOOT_ID || checking) return;
  checking = true;
  try {
    const deployed = await fetchDeployedId();
    if (!deployed || deployed === BOOT_ID) return;
    if (isTyping()) return; // catch it on the next poll / focus
    if (reloadBudgetExhausted()) return;
    window.location.reload();
  } finally {
    checking = false;
  }
}

/**
 * Begin watching for new deploys. Idempotent — safe to call once at boot.
 * Checks periodically and whenever the tab regains focus / visibility, so
 * a dealer returning to a backgrounded tab lands on the fresh build.
 */
export function startVersionWatcher() {
  if (started || typeof window === 'undefined') return;
  started = true;
  setInterval(check, POLL_MS);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}
