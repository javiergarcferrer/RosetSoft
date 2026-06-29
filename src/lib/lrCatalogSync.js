// Thin client wrapper over the `lr-catalog` Edge Function.
//
// The Materials admin invokes `lr-catalog` from three places (the weekly-cron
// self-heal on mount, the PDF import's best-effort site sweep, and the on-demand
// website sync). Each of those parsed the function's response inline and judged
// "did it work?" with its own copy of the same checks. Funnelling them through
// this module keeps that contract in ONE place: a successful sweep returns the
// patterns + whether the sweep was COMPLETE (no coverage gap), and a failed one
// throws a typed `LrCatalogError` callers can recognise without re-deriving
// "fnError || data?.error || empty patterns".
//
// Pure-ish: the only side effect is the supabase function call passed in. Keeping
// `supabase` as an injected dependency (default = the app client) lets the merge
// logic stay testable and matches the rest of the lib layer (no React, no DOM).
import { supabase as defaultClient } from '../db/supabaseClient.js';

/** A recognisable failure from the lr-catalog function (network or empty sweep). */
export class LrCatalogError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LrCatalogError';
  }
}

/**
 * Fetch the Ligne Roset catalog patterns from the site (a full sweep).
 * Resolves to `{ patterns, complete }` — `complete` is false when the function
 * reported a partial sweep (it saw more fabrics than it could read), which the
 * callers use to suppress "no en sitio" flagging. Throws `LrCatalogError` on a
 * network error, a function-reported error, or an empty/absent pattern list.
 */
export async function fetchLrPatterns(supabase = defaultClient) {
  let data; let fnError;
  try {
    ({ data, error: fnError } = await supabase.functions.invoke('lr-catalog', { body: { all: true } }));
  } catch (e) {
    throw new LrCatalogError(e?.message || 'No se pudo contactar el servicio de catálogo.');
  }
  if (fnError || data?.error || !Array.isArray(data?.patterns) || !data.patterns.length) {
    throw new LrCatalogError(
      data?.error || fnError?.message || 'No se pudo leer ligne-roset.com en este momento.',
    );
  }
  return { patterns: data.patterns, complete: !data.source?.partial };
}

/**
 * Best-effort variant for the PDF import, where a site failure is non-fatal (the
 * PDF still imports). Returns `{ patterns, complete }` on success or `null` if
 * the site couldn't be read — never throws.
 */
export async function fetchLrPatternsOptional(supabase = defaultClient) {
  try {
    return await fetchLrPatterns(supabase);
  } catch {
    return null;
  }
}

/**
 * Idempotently ensure the weekly catalog-refresh cron exists. Fire-and-forget,
 * admin-gated server-side; swallows errors (the schedule self-heals next mount).
 */
export function ensureLrCron(supabase = defaultClient) {
  return supabase.functions.invoke('lr-catalog', { body: { ensureCron: true } }).catch(() => {});
}
