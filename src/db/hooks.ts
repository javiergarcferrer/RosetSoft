import { useEffect, useRef, useState, type DependencyList } from 'react';
import { subscribeInvalidate } from './database.js';

/**
 * Drop-in replacement for `dexie-react-hooks`' useLiveQuery, backed by the
 * Supabase shim. Refetches when any mutation calls `invalidate()` from
 * `database.js` or when `deps` change.
 *
 * The third arg is the default value returned while the first fetch is in
 * flight — matching the dexie-react-hooks signature.
 *
 * For surfaces that need to *distinguish* "fetch hasn't returned yet" from
 * "fetch returned an empty result" — list pages that would otherwise flash
 * a false "Sin X" empty state on every navigation — use
 * `useLiveQueryStatus()` below, which returns `{ data, loaded }`. The
 * default value here can't carry that signal because callers pass `[]` for
 * "an array, until we know better" and the page can't tell that apart from
 * "the user really has zero rows".
 */
export function useLiveQuery<T>(asyncFn: () => T | Promise<T>): T | undefined;
export function useLiveQuery<T>(asyncFn: () => T | Promise<T>, deps: DependencyList): T | undefined;
export function useLiveQuery<T, D = T>(
  asyncFn: () => T | Promise<T>,
  deps: DependencyList,
  defaultValue: D,
): T | D;
export function useLiveQuery<T, D>(
  asyncFn: () => T | Promise<T>,
  deps: DependencyList = [],
  defaultValue?: D,
): T | D | undefined {
  return useLiveQueryStatus<T, D>(asyncFn, deps, defaultValue as D).data;
}

/**
 * Same data flow as useLiveQuery, but exposes a `loaded` boolean that flips
 * to true after the first successful fetch completes. Pages that render an
 * empty-state UI for `data.length === 0` should gate that branch on
 * `loaded` — otherwise the EmptyState component renders for one frame on
 * every page mount, then immediately gets replaced by real rows, which
 * reads as a flicker.
 *
 * Mutations and dependency changes refetch in the background without
 * flipping `loaded` back to false — the existing data stays on screen until
 * the new data arrives. That matches the SWR / TanStack Query convention
 * and avoids a second flash of empty state mid-session.
 *
 * Return type: `{ data: T, loaded: boolean }`. Destructure at the call
 * site for readable code (`const { data: quotes, loaded } = ...`).
 */
export interface LiveQueryStatus<T> {
  data: T;
  loaded: boolean;
  /** Set when the most recent fetch threw (e.g. a missing table / RLS deny).
   *  `loaded` still flips to true so callers render an error/empty state
   *  instead of hanging on the loading skeleton forever. */
  error?: unknown;
}

export function useLiveQueryStatus<T>(
  asyncFn: () => T | Promise<T>,
): LiveQueryStatus<T | undefined>;
export function useLiveQueryStatus<T>(
  asyncFn: () => T | Promise<T>,
  deps: DependencyList,
): LiveQueryStatus<T | undefined>;
export function useLiveQueryStatus<T, D = T>(
  asyncFn: () => T | Promise<T>,
  deps: DependencyList,
  defaultValue: D,
): LiveQueryStatus<T | D>;
export function useLiveQueryStatus<T, D>(
  asyncFn: () => T | Promise<T>,
  deps: DependencyList = [],
  defaultValue?: D,
): LiveQueryStatus<T | D | undefined> {
  const [state, setState] = useState<LiveQueryStatus<T | D | undefined>>({
    data: defaultValue,
    loaded: false,
    error: null,
  });
  const fnRef = useRef(asyncFn);
  fnRef.current = asyncFn;

  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const r = await Promise.resolve(fnRef.current());
        if (active) setState({ data: r, loaded: true, error: null });
      } catch (e) {
        // Don't hang on the loading skeleton forever: flip `loaded` and
        // surface the error so the page can show an error/empty state. Keep
        // the prior data (SWR-style) so a transient error doesn't blank it.
        if (active) {
          console.error('useLiveQuery error:', e);
          setState((s) => ({ data: s.data, loaded: true, error: e }));
        }
      }
    };
    run();
    const unsub = subscribeInvalidate(run);
    return () => {
      active = false;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
