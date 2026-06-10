import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../db/supabaseClient.js';
import {
  summarizeTracking, buildTrackingRoute, summarizeVoyage,
  normalizeContainerNo, isValidContainerNo,
} from '../../lib/containerTracking.js';

/**
 * ViewModel hook for a single container's live Hapag-Lloyd tracking.
 *
 * MVVM: it owns the data-access (the `hl-track` Edge Function call) AND the
 * derivation (summary → route → voyage → the event→stop map), returning the
 * resolved state a panel renders. The View (components/ContainerTracking.jsx)
 * renders this and derives nothing itself — so every surface that shows
 * tracking (quote list, editor, client link, order) gets identical behaviour
 * from one place.
 *
 * `shareToken` authorizes the keyless call on the logged-OUT public link; on the
 * dealer's logged-in surfaces it's omitted and the session authorizes.
 */
export function useContainerTracking(containerNo, shareToken) {
  const [state, setState] = useState({ status: 'loading', summary: null, error: null, fetchedAt: null });

  async function load() {
    setState({ status: 'loading', summary: null, error: null, fetchedAt: null });
    try {
      const { data, error } = await supabase.functions.invoke('hl-track', {
        body: { containerNo, shareToken },
      });
      if (error) {
        let msg = error.message || 'No se pudo rastrear el contenedor';
        try {
          // The function returns { error, status, detail } on upstream
          // failures; surface the cause instead of a generic message.
          const body = await error.context?.json?.();
          if (body?.error) {
            msg = body.error;
            if (body.status) msg += ` (HTTP ${body.status})`;
          }
        } catch { /* body already consumed / not JSON */ }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      setState({
        status: 'done',
        summary: summarizeTracking(data?.events),
        error: null,
        fetchedAt: data?.fetchedAt || null,
      });
    } catch (e) {
      setState({ status: 'error', summary: null, error: e?.message || 'Error', fetchedAt: null });
    }
  }

  useEffect(() => { load(); }, [containerNo, shareToken]);

  const { status, summary, error, fetchedAt } = state;
  // Geocoded port hops for the map; empty when no event carries a known
  // UN/LOCODE, in which case the textual timeline stands on its own.
  const route = useMemo(() => buildTrackingRoute(summary), [summary]);
  // High-level voyage facts for the map's HUD (endpoints, ETA, progress).
  const voyage = useMemo(() => summarizeVoyage(route, summary, containerNo), [route, summary, containerNo]);
  // Which map stop each timeline event belongs to, so clicking a row focuses
  // the matching marker. Built from the same milestone object identities.
  const milestoneStop = useMemo(() => {
    const m = new Map();
    route.stops.forEach((s, i) => (s.events || []).forEach((e) => m.set(e, i)));
    return m;
  }, [route]);

  return { status, summary, error, fetchedAt, route, voyage, milestoneStop, reload: load };
}

/* ----------------------- fleet ETA (dashboard) ----------------------- */

// Tracking moves on the scale of days; 10 minutes keeps the home screen
// fresh without re-hitting Hapag-Lloyd on every navigation back to it.
const ETA_TTL_MS = 10 * 60 * 1000;
// containerNo → { fetchedAt, eta: { etaAt, etaLocation } | null }. Module
// level on purpose: the cache outlives the hook so revisiting the page
// within the TTL renders instantly. Failures cache as null so a broken
// number can't retry-loop.
const etaCache = new Map();

/**
 * ViewModel hook for MANY containers' arrival estimates at once — the
 * lightweight sibling of {@link useContainerTracking} for list surfaces
 * (the dashboard's Pedidos en curso strip). Fetches each container's
 * Hapag-Lloyd events in parallel, keeps only the derived ETA milestone,
 * and returns `Map<containerNo, { etaAt, etaLocation }>`.
 *
 * Quiet by design: a container that fails to track or has no estimated
 * arrival simply has no entry — an ETA is an enhancement, never an error
 * state on the home screen.
 */
export function useContainerEtas(containerNos) {
  // Normalized, validated, deduped, order-independent — the effect keys on
  // this string so re-renders with the same fleet don't refetch.
  const codesKey = useMemo(
    () => [...new Set((containerNos || []).map(normalizeContainerNo).filter(isValidContainerNo))].sort().join(','),
    [containerNos],
  );
  const [etaByCode, setEtaByCode] = useState(() => new Map());

  useEffect(() => {
    const codes = codesKey ? codesKey.split(',') : [];
    if (codes.length === 0) { setEtaByCode(new Map()); return undefined; }
    let cancelled = false;
    (async () => {
      const next = new Map();
      await Promise.all(codes.map(async (code) => {
        const hit = etaCache.get(code);
        if (hit && Date.now() - hit.fetchedAt < ETA_TTL_MS) {
          if (hit.eta) next.set(code, hit.eta);
          return;
        }
        try {
          const { data, error } = await supabase.functions.invoke('hl-track', { body: { containerNo: code } });
          const summary = (!error && !data?.error) ? summarizeTracking(data?.events) : null;
          const eta = summary?.eta?.at != null
            ? { etaAt: summary.eta.at, etaLocation: summary.eta.location || null }
            : null;
          etaCache.set(code, { fetchedAt: Date.now(), eta });
          if (eta) next.set(code, eta);
        } catch {
          etaCache.set(code, { fetchedAt: Date.now(), eta: null });
        }
      }));
      if (!cancelled) setEtaByCode(next);
    })();
    return () => { cancelled = true; };
  }, [codesKey]);

  return etaByCode;
}
