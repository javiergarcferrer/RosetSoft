/**
 * Safe dynamic-import wrapper for code-split chunks (currently just the
 * pdf-lib bundle behind Export PDF).
 *
 * The failure mode this defends against: the dealer keeps the SPA open
 * across a deploy, so their cached index.html still references the old
 * hashed chunk filenames. When they tap Export PDF, the browser asks
 * for `/assets/quotePdf-<oldHash>.js` — that file doesn't exist in the
 * new deploy, so the request either 404s (post the vercel.json fix
 * that stops rewriting asset paths to index.html) or, on pre-fix
 * deploys, returns the SPA fallback HTML with a `text/html` content
 * type. Either way the dynamic `import()` rejects with a
 * "Failed to fetch dynamically imported module" / "MIME type" /
 * "Importing a module script failed" error, and the export silently
 * blows up.
 *
 * Resolution: detect the shape of the failure, set a sessionStorage
 * flag so a permanent outage doesn't loop reloads, then hard cache-bust
 * to a NEW versioned URL. That pulls the fresh index.html (with the new
 * hashed chunk URLs) and a second tap succeeds.
 *
 * Why navigate to a versioned URL instead of `location.reload()`? Same
 * reason `startVersionWatcher` (lib/liveReload.js) does: an installed iOS
 * PWA serves its start_url shell (index.html) from the WebKit app-shell
 * cache, and a plain `reload()` can hand back that SAME stale HTML — so
 * the tab reloads, re-requests the very chunk hash that just 404'd, fails
 * again, and the second failure surfaces to the user as the dreaded
 * "Failed to fetch dynamically imported module" crash. Navigating to a
 * brand-new `?cb=` URL has no cache entry, so the browser MUST hit the
 * network and pull the fresh index.html + hashed bundle. HashRouter keeps
 * the route in the hash, so the search param is inert for routing.
 *
 * Why not just retry the import inline? Because the browser caches
 * the failed module-record by URL — re-asking for the same hashed
 * filename gives the same 404. The only way to recover is to reload
 * the entry document so the browser sees the new chunk URLs.
 */
const STALE_CHUNK_KEY = 'roset-stale-chunk-reload';

function isStaleChunkError(err: unknown): boolean {
  if (!err) return false;
  const msg = String((err as { message?: unknown })?.message || err).toLowerCase();
  return (
    msg.includes('dynamically imported module') ||
    msg.includes('mime type') ||
    msg.includes('importing a module script failed') ||
    msg.includes('failed to fetch')
  );
}

export async function safeDynamicImport<T>(loader: () => Promise<T>): Promise<T> {
  try {
    const mod = await loader();
    // Clear the recovery flag on success so a future stale-chunk
    // event gets a fresh reload chance — without this, a once-
    // recovered session would never auto-recover again.
    try { sessionStorage.removeItem(STALE_CHUNK_KEY); } catch {}
    return mod;
  } catch (err) {
    if (!isStaleChunkError(err)) throw err;
    let already: string | null = null;
    try { already = sessionStorage.getItem(STALE_CHUNK_KEY); } catch {}
    if (already) {
      // We already reloaded once for this issue; the failure is
      // persistent (real outage, broken deploy, offline). Clear the
      // flag so the next session starts clean, and surface the
      // error to the caller so the UI can show a banner.
      try { sessionStorage.removeItem(STALE_CHUNK_KEY); } catch {}
      throw err;
    }
    try { sessionStorage.setItem(STALE_CHUNK_KEY, '1'); } catch {}
    // Hard cache-bust to a NEW URL (see header) — a plain reload() can
    // return the stale app-shell HTML in an installed iOS PWA and never
    // recover. A fresh search param has no cache entry, forcing a network
    // fetch of the new index.html + hashed chunks. `replace` so we don't
    // grow the history stack on every recovery.
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('cb', String(Date.now()));
      window.location.replace(url.toString());
    } catch {
      window.location.reload();
    }
    // Hang the promise — the reload tears down the JS context
    // before this ever resolves, so callers don't continue with a
    // half-loaded module.
    return new Promise<T>(() => {});
  }
}
