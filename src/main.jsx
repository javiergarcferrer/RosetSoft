import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './index.css';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { startVersionWatcher } from './lib/liveReload.js';

// Auto-reload the tab when a new build is deployed (see lib/liveReload).
startVersionWatcher();

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
  const standalone =
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
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
