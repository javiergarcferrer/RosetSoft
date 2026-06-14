import {
  createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';

/**
 * Workflow memory — "always go back to where I was", and land there with the
 * view I left.
 *
 * React Router (and the browser) keep a real history stack, but they DON'T
 * tell you whether `navigate(-1)` would stay inside the app or walk off the
 * front of it (onto the page you opened the tab from, or nothing). Without
 * that, a "Back" affordance can't safely choose between "return to the page
 * I came from" and "fall back to this section's list".
 *
 * This provider counts the app's own history depth: every in-app PUSH adds
 * one, every POP (back/forward) subtracts one, REPLACE is neutral. `canGoBack`
 * is then simply "we've pushed at least one entry since this tab loaded", i.e.
 * there's somewhere in-app to go back to. A fresh load / deep link starts at
 * depth 0, so Back there uses the page's fallback instead of escaping the SPA.
 *
 * Returning to a page is only half of "where I was": React keys each route by
 * pathname (Layout's <Outlet key={pathname}>), so every page REMOUNTS fresh on
 * navigation and its local UI state (the active pill, the search box, which
 * rows are expanded, the scroll offset) is gone. So the provider also carries
 * two per-tab stores that survive that remount:
 *   - `stateStore`  — page UI state keyed by pathname (`useStickyState`), so a
 *                     list restores its filter/search/sort/expanded set when you
 *                     come back to it.
 *   - `scrollStore` — the <main> scroll offset keyed by the history entry
 *                     (`useScrollRestoration`), so Back/Forward lands you at the
 *                     row you were looking at, not the top.
 * Both are in-memory refs (per tab, cleared on a hard reload) — workflow memory,
 * not persisted preference.
 */
const NavMemoryContext = createContext({
  canGoBack: false,
  stateStore: new Map(),
  scrollStore: new Map(),
});

export function NavMemoryProvider({ children }) {
  const location = useLocation();
  const navType = useNavigationType(); // 'POP' (load/back/forward) | 'PUSH' | 'REPLACE'
  const depthRef = useRef(0);
  const lastKeyRef = useRef(null);
  const [canGoBack, setCanGoBack] = useState(false);
  // Workflow memory stores. Refs, not state — writing them must NEVER trigger a
  // re-render (they're read lazily on the next mount, not rendered from).
  const stateStore = useRef(new Map()).current;
  const scrollStore = useRef(new Map()).current;
  // Stable value identity — the stores are fixed refs, so this only changes
  // when `canGoBack` flips, not on every provider re-render (location changes).
  const value = useMemo(
    () => ({ canGoBack, stateStore, scrollStore }),
    [canGoBack, stateStore, scrollStore],
  );

  useEffect(() => {
    // Guard against StrictMode's double-invoke and re-renders that don't
    // correspond to a navigation: only react to a genuinely new history entry.
    if (lastKeyRef.current === location.key) return;
    lastKeyRef.current = location.key;

    if (navType === 'PUSH') depthRef.current += 1;
    else if (navType === 'POP') depthRef.current = Math.max(0, depthRef.current - 1);
    // REPLACE swaps the current entry in place — depth is unchanged.

    setCanGoBack(depthRef.current > 0);
  }, [location.key, navType]);

  return (
    <NavMemoryContext.Provider value={value}>
      {children}
    </NavMemoryContext.Provider>
  );
}

/**
 * `goBack(fallback)` — return to the previous in-app page when there is one,
 * otherwise navigate to `fallback` (the section's list, etc.). Pass the same
 * destination the old hard-coded "Volver a …" link used so direct loads still
 * land somewhere sensible.
 */
export function useGoBack() {
  const navigate = useNavigate();
  const { canGoBack } = useContext(NavMemoryContext);
  return (fallback) => {
    if (canGoBack) navigate(-1);
    else if (fallback) navigate(fallback, { replace: true });
  };
}

/**
 * `useStickyState(name, initial)` — `useState` that remembers its value across
 * the page's remounts within this tab session, keyed by the current pathname.
 *
 * Use it for the View-owned UI state that defines "the view I was looking at":
 * the active filter pill, the search query, the sort, the set of expanded rows.
 * Swap a `useState` for it and Back (or any later return to the page) restores
 * exactly that view instead of resetting to defaults. Don't use it for truly
 * transient state (a one-shot error banner, an open modal) — those should reset.
 *
 * `initial` follows the `useState` lazy-init convention (a function is called
 * once for the default), and it's only consulted the FIRST time a page is
 * visited; later visits restore the remembered value. The value lives in an
 * in-memory Map, so any type is fine (a `Set`, a `{}` filter bag) — no JSON.
 */
export function useStickyState(name, initial) {
  const { pathname } = useLocation();
  const { stateStore } = useContext(NavMemoryContext);
  const key = `${pathname}::${name}`;
  const [value, setValue] = useState(() => (
    stateStore.has(key)
      ? stateStore.get(key)
      : (typeof initial === 'function' ? initial() : initial)
  ));
  // Mirror every change into the store so the next mount (after Back, or any
  // later return to this pathname) reads it back as the initial value.
  useEffect(() => { stateStore.set(key, value); }, [stateStore, key, value]);
  return [value, setValue];
}

/**
 * `useScrollRestoration(scrollRef)` — drive the app's single scroll container
 * (Layout's <main>) so Back/Forward lands at the offset you left, while a fresh
 * PUSH starts at the top like a new page should.
 *
 * Because the SPA scrolls <main> (not the window), the browser's native scroll
 * restoration never fires; this is the in-app equivalent. Offsets are stored
 * per history entry (`location.key`), saved when you leave the entry and
 * re-applied on POP. The page's data arrives async (live queries), so the
 * target is nudged across a few frames until the content is tall enough to hold
 * it (or a short budget elapses) rather than snapping once to a too-short page.
 */
export function useScrollRestoration(scrollRef) {
  const location = useLocation();
  const navType = useNavigationType();
  const { scrollStore } = useContext(NavMemoryContext);

  // One layout effect per history entry owns the whole cycle. It runs as a
  // layout effect (not passive) so its CLEANUP — which records the offset we're
  // leaving — fires synchronously BEFORE the next entry's effect resets <main>
  // to the top; a passive save would read the already-zeroed offset and lose it.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const key = location.key;

    // Keep the store live as the user scrolls, so the offset is current even if
    // they navigate away mid-frame. rAF-throttled — one write per painted frame.
    let saveRaf = 0;
    const onScroll = () => {
      if (saveRaf) return;
      saveRaf = requestAnimationFrame(() => { saveRaf = 0; scrollStore.set(key, el.scrollTop); });
    };
    el.addEventListener('scroll', onScroll, { passive: true });

    // Apply on arrival: restore on Back/Forward, start at the top otherwise.
    let applyRaf = 0;
    const target = navType === 'POP' ? (scrollStore.get(key) || 0) : 0;
    if (target === 0) {
      el.scrollTop = 0;
    } else {
      // Content can still be loading (live queries), so the page may be too
      // short to hold `target` yet — re-apply each frame until it sticks or a
      // short budget elapses, instead of snapping once to a too-short page.
      let elapsed = 0;
      const step = () => {
        el.scrollTop = target;
        elapsed += 16;
        if (Math.abs(el.scrollTop - target) > 1 && elapsed < 800) {
          applyRaf = requestAnimationFrame(step);
        }
      };
      applyRaf = requestAnimationFrame(step);
    }

    return () => {
      el.removeEventListener('scroll', onScroll);
      if (saveRaf) cancelAnimationFrame(saveRaf);
      if (applyRaf) cancelAnimationFrame(applyRaf);
      // Final synchronous save of the offset we're leaving — runs before the
      // next entry's effect zeroes <main>.
      scrollStore.set(key, el.scrollTop);
    };
  }, [location.key, navType, scrollRef, scrollStore]);
}
