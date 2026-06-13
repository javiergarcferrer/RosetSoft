import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';

/**
 * Workflow memory — "always go back to where I was".
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
 * `useGoBack()` returns `goBack(fallback)`: step back through real history when
 * we can (returning you to the EXACT page you came from — a quote, a search,
 * the professionals list), otherwise navigate to the page's sensible fallback.
 */
const NavMemoryContext = createContext({ canGoBack: false });

export function NavMemoryProvider({ children }) {
  const location = useLocation();
  const navType = useNavigationType(); // 'POP' (load/back/forward) | 'PUSH' | 'REPLACE'
  const depthRef = useRef(0);
  const lastKeyRef = useRef(null);
  const [canGoBack, setCanGoBack] = useState(false);

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
    <NavMemoryContext.Provider value={{ canGoBack }}>
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
