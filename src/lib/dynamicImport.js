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
 * flag so a permanent outage doesn't loop reloads, then `location.
 * reload()`. The reload picks up the fresh index.html (with the new
 * hashed chunk URLs) and a second tap succeeds.
 *
 * Why not just retry the import inline? Because the browser caches
 * the failed module-record by URL — re-asking for the same hashed
 * filename gives the same 404. The only way to recover is to reload
 * the entry document so the browser sees the new chunk URLs.
 */
const STALE_CHUNK_KEY = 'roset-stale-chunk-reload';

function isStaleChunkError(err) {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  return (
    msg.includes('dynamically imported module') ||
    msg.includes('mime type') ||
    msg.includes('importing a module script failed') ||
    msg.includes('failed to fetch')
  );
}

export async function safeDynamicImport(loader) {
  try {
    const mod = await loader();
    // Clear the recovery flag on success so a future stale-chunk
    // event gets a fresh reload chance — without this, a once-
    // recovered session would never auto-recover again.
    try { sessionStorage.removeItem(STALE_CHUNK_KEY); } catch {}
    return mod;
  } catch (err) {
    if (!isStaleChunkError(err)) throw err;
    let already = null;
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
    window.location.reload();
    // Hang the promise — the reload tears down the JS context
    // before this ever resolves, so callers don't continue with a
    // half-loaded module.
    return new Promise(() => {});
  }
}
