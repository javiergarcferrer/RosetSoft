import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { startVersionWatcher } from './lib/liveReload.js';
import { installVirtualKeyboardWatcher } from './lib/useVirtualKeyboard.js';
import { initTheme } from './lib/theme.js';

// Re-affirm the theme the inline boot script already painted, and start
// following the OS while the dealer is on "system" (see lib/theme).
initTheme();

// Auto-reload the tab when a new build is deployed (see lib/liveReload).
startVersionWatcher();

// Watch the soft keyboard (visualViewport) so bottom-pinned chrome gets out of
// the way while typing instead of covering the focused field. See the hook.
installVirtualKeyboardWatcher();

// Mark the installed-PWA context on <html> so bottom-pinned chrome (the quote
// TotalsDock) fills the home-indicator safe-area inset with its own background
// instead of leaving a bare strip. We DON'T rely on `@media (display-mode:
// standalone)` for this: iOS home-screen apps don't reliably match it (notably
// with a `display_override` manifest), which left the dock short of the bottom
// edge. `navigator.standalone === true` is Apple's canonical, reliable flag for
// an iOS app launched from the home screen; matchMedia covers Android/desktop
// installs. In a normal browser tab neither is true, so the class stays off and
// the bar sits flush above the browser toolbar with no dead strip.
try {
  // On iOS, `navigator.standalone` is a DEFINITIVE boolean — true only for a
  // home-screen launch, false in a Safari tab. We trust it outright there and
  // must NOT fall through to `matchMedia('(display-mode: standalone)')`, which
  // iOS Safari can mis-match (reporting standalone in a normal tab) — that's
  // what stamped the dock's home-indicator pad onto the bar in Safari, leaving
  // the dead white band under it. Only when `navigator.standalone` is undefined
  // (Android / desktop) do we consult the display-mode query.
  const iosFlag = window.navigator.standalone;
  const standalone =
    typeof iosFlag === 'boolean'
      ? iosFlag
      : window.matchMedia('(display-mode: standalone)').matches;
  document.documentElement.classList.toggle('is-standalone', standalone);
} catch {
  /* unsupported — no-op */
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <App />
      </HashRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
