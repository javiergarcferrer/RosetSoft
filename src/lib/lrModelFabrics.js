/**
 * Per-model fabric availability — capture which fabrics a Ligne Roset model
 * actually offers (not every fabric in a pricing grade is a technical option for
 * a given frame) and persist it keyed by the family root.
 *
 * The scraping already lives server-side in the `lr-catalog` Edge Function's
 * single-product mode (`{ url }`) — the same function the Materials importer
 * uses — so this module only invokes it, normalizes the returned pattern names
 * (so they match `materials.name`), and stores the result in `model_fabrics`.
 * Nothing crosses the Deno↔Vite wall except JSON.
 */
import { supabase } from '../db/supabaseClient.js';
import { db } from '../db/database.js';
import { fabricKey } from './lrCatalog.js';

/**
 * Fetch the fabrics a Ligne Roset product page offers. Returns
 * `{ url, title, patternNames }` where `patternNames` are normalized keys
 * (`fabricKey`) ready to match against catalog material names. Throws a
 * user-facing (Spanish) message on any failure — the page is the source of
 * truth, so a bad/non-product URL simply fails the fetch.
 */
export async function fetchModelFabrics(url) {
  const clean = String(url || '').trim();
  if (!clean) throw new Error('Pega un enlace de producto de Ligne Roset.');

  const { data, error } = await supabase.functions.invoke('lr-catalog', { body: { url: clean } });
  if (error) {
    let msg = error.message || 'No se pudo leer la página de Ligne Roset.';
    // The function returns its reason in the response body (e.g. "url must be a
    // ligne-roset.com product page"); surface it when available.
    try {
      const body = await error.context?.json?.();
      if (body?.error) msg = body.error;
    } catch { /* keep the generic message */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);

  const patterns = Array.isArray(data?.patterns) ? data.patterns : [];
  if (patterns.length === 0) {
    throw new Error('No se encontraron telas para este modelo en esa página.');
  }
  const patternNames = [...new Set(patterns.map((p) => fabricKey(p?.name)).filter(Boolean))];
  return { url: clean, title: data?.source?.title || null, patternNames };
}

/** Persist a model's offered fabrics, keyed by family root (upsert). */
export async function saveModelFabrics(root, profileId, { url, title, patternNames }) {
  if (!root) return;
  await db.modelFabrics.put({
    id: root,
    profileId: profileId || 'team',
    sourceUrl: url || null,
    title: title || null,
    patternNames: patternNames || [],
    fetchedAt: Date.now(),
  });
}

/** Remove a model's link/restriction (back to grade-only behavior). */
export async function clearModelFabrics(root) {
  if (!root) return;
  await db.modelFabrics.delete(root);
}

/**
 * Carry a model's fabric link from one storage key to another when a line
 * changes shape. A SIMPLE line keys its link by the SKU family root (so it
 * persists per model across quotes); a COMPOUND keys it by the line id (so one
 * link governs every component). Toggling between the two (Convertir a / Disolver
 * compuesto) would otherwise orphan the link under the now-unused key and
 * silently drop the material picker's offered-fabric restriction.
 *
 * Copies the source link onto `toKey`, but only when `toKey` has no link yet, so
 * an existing per-model (cross-quote) link is never clobbered by a stale carry.
 * The source is left intact — on convert that's the per-model link other quotes
 * still rely on; callers that want it gone (dissolve) clear it explicitly.
 * Best-effort and non-throwing: a transient failure must never break the
 * shape toggle itself, which has already been applied to the line.
 */
export async function carryModelLink(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  try {
    const src = await db.modelFabrics.get(fromKey);
    if (!src || (!src.patternNames?.length && !src.sourceUrl)) return;
    const dst = await db.modelFabrics.get(toKey);
    if (dst && (dst.patternNames?.length || dst.sourceUrl)) return; // keep the target's own link
    await db.modelFabrics.put({
      ...src,
      id: toKey,
      profileId: src.profileId || 'team',
      fetchedAt: src.fetchedAt ?? Date.now(),
    });
  } catch (e) {
    console.error('[lrModelFabrics] carryModelLink failed', e);
  }
}
