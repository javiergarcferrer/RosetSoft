import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Menu, X, PanelLeftClose, PanelLeft } from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import ProfileMenu from './ProfileMenu.jsx';
import ViewAsToggle from './ViewAsToggle.jsx';
import ImageView from './ImageView.jsx';
import AccountingSubnav from './AccountingSubnav.jsx';
import QuickCreate from './QuickCreate.jsx';
import { navForRole } from '../lib/access.js';

// Persisted preference for the desktop "hide sidebar" toggle (see Layout).
const SIDEBAR_COLLAPSED_KEY = 'rs.sidebarCollapsed';

// The unified, role-gated sidebar — ONE system across both cores — is defined
// by the "limbic" access layer (lib/access.js: navForRole). The role reveals
// its slice; admins see both cores in one place.

export default function Layout() {
  const { settings, currentProfile, isAdmin, isAccounting } = useApp();
  const navGroups = navForRole(currentProfile?.role);
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  // Desktop-only: hide the static sidebar to reclaim horizontal space. Persisted
  // so the choice survives reloads. Every effect of it below is md:-gated, so the
  // phone layout (which uses the navOpen drawer instead) is never affected.
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  );
  const isMobile = !useMediaQuery('(min-width: 768px)');
  const company = settings?.companyName || 'Roset Soft';

  // Remember the collapse preference across sessions.
  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch {}
  }, [collapsed]);

  // Close drawer on navigation
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  // Lock body scroll when the drawer is open on mobile.
  useEffect(() => {
    if (!isMobile) return;
    const prev = document.body.style.overflow;
    if (navOpen) document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [navOpen, isMobile]);

  // The desktop sidebar's horizontal footprint, published as a CSS variable on
  // the shell root so position:fixed chrome rendered deep inside the page — the
  // quote TotalsDock and the client-preview Ver/Personalizar toggle — can offset
  // past the sidebar AND follow it when collapsed. They're DOM descendants of
  // this div, so the variable inherits even though they're fixed. Expanded = the
  // sidebar's w-60 (15rem); collapsed = the md:pl-12 gutter the floating
  // show-toggle sits in (3rem). Consumed only via md:-gated utilities, so the
  // mobile drawer layout ignores it.
  const sidebarOffset = collapsed ? '3rem' : '15rem';

  return (
    <div className="h-full flex flex-col md:flex-row" style={{ '--rs-sidebar-offset': sidebarOffset }}>
      {/* Mobile topbar — extends behind the status bar on standalone iOS
          via pt-safe-area, so our dark background covers the white status-bar
          text instead of leaving a milky strip above the topbar. */}
      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] bg-ink-900 text-ink-100 border-b border-ink-800">
        <button
          onClick={() => setNavOpen(true)}
          className="inline-flex items-center justify-center w-11 h-11 -ml-2 rounded text-ink-100 hover:bg-ink-800 active:bg-ink-700 transition-colors"
          aria-label="Abrir menú"
        >
          <Menu size={20} />
        </button>
        {/* Brand block — the dealer's typographic logo (an SVG, usually a
            wordmark) rendered in white over the dark bar, with a small
            "Roset Soft" eyebrow beneath. No background box, no rounded
            chrome — the logo IS the brand mark and shouldn't sit inside
            a styled container. `filter: brightness(0) invert(1)` tints any
            single-color SVG to pure white regardless of its source color
            (works for solid black/dark wordmarks, which is the usual case;
            multi-color logos would need a dedicated white-variant upload
            we don't model yet). */}
        <div className="min-w-0 px-2 flex flex-col items-center gap-0.5">
          {settings?.logoImageId ? (
            <ImageView
              id={settings.logoImageId}
              alt={company + ' logo'}
              className="h-6 max-w-[140px] object-contain"
              style={{ filter: 'brightness(0) invert(1)' }}
              placeholderClassName="h-6 w-24"
            />
          ) : (
            <div className="font-wordmark text-base truncate leading-tight" title={company}>{company}</div>
          )}
          <div className="text-[9px] uppercase tracking-widest text-ink-400 leading-none">Roset Soft</div>
        </div>
        <div className="w-11" />
      </header>

      {/* Mobile drawer overlay */}
      {navOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-ink-900/50"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar — slides in on mobile, static on desktop. Width capped at
          85vw so a sliver of the underlying page is still visible on phones
          (gives the user a clear tap target to dismiss). pt-safe-area /
          pb-safe-area / pl-safe-area keep the panel content clear of the
          notch, home indicator, and landscape ear. */}
      <aside
        className={`bg-gradient-to-b from-ink-800 via-ink-900 to-ink-900 text-ink-100 flex-shrink-0 flex flex-col fixed md:static inset-y-0 left-0 z-50 w-[min(16rem,85vw)] md:w-60 md:border-r md:border-ink-800/60 pt-safe-area pb-safe-area pl-safe-area transform transition-transform duration-200 md:transform-none md:pt-0 md:pb-0 md:pl-0 ${
          navOpen ? 'translate-x-0 shadow-pop' : '-translate-x-full md:translate-x-0'
        } ${collapsed ? 'md:hidden' : ''}`}
        aria-label="Navegación principal"
      >
        <div className="px-5 py-5 border-b border-ink-800 flex items-start justify-between gap-3">
          {/* Brand block — typographic logo over "Roset Soft" eyebrow.
              See the mobile topbar's matching block for the rationale on
              the white-tint filter and the lack of a background box. */}
          <div className="min-w-0 flex flex-col items-start gap-1.5">
            {settings?.logoImageId ? (
              <ImageView
                id={settings.logoImageId}
                alt={company + ' logo'}
                className="h-9 max-w-[180px] object-contain object-left"
                style={{ filter: 'brightness(0) invert(1)' }}
                placeholderClassName="h-9 w-32"
              />
            ) : (
              <div className="font-wordmark text-lg leading-tight truncate" title={company}>
                {company}
              </div>
            )}
            <div className="eyebrow-xs font-normal tracking-widest text-ink-400">Roset Soft</div>
          </div>
          <div className="flex items-center -mr-2 -my-2">
            {/* Desktop: collapse the sidebar out of the way (it reappears via the
                floating toggle by the page's top-left corner). */}
            <button
              onClick={() => setCollapsed(true)}
              className="hidden md:inline-flex items-center justify-center w-9 h-9 rounded text-ink-400 hover:text-ink-100 hover:bg-ink-800 active:bg-ink-700 transition-colors"
              aria-label="Ocultar menú"
              title="Ocultar menú"
            >
              <PanelLeftClose size={18} />
            </button>
            {/* Mobile: close the slide-in drawer. */}
            <button
              onClick={() => setNavOpen(false)}
              className="md:hidden inline-flex items-center justify-center w-11 h-11 rounded text-ink-400 hover:text-ink-100 hover:bg-ink-800 active:bg-ink-700 transition-colors"
              aria-label="Cerrar menú"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* QuickBooks-style "+ Nuevo" quick-create — only where accounting
            create flows are reachable (accounting users + admins). */}
        {(isAccounting || isAdmin) && <QuickCreate />}

        {/* Admin-only "Ver como" preview — sits right under the brand mark so
            it's discreet but always at hand. Renders nothing for non-admins
            and is hidden in the mobile drawer (the component owns both). */}
        <ViewAsToggle />

        <nav className="flex-1 px-2 py-3 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {navGroups.map((group, gi) => (
            <div
              key={gi}
              // Top/bottom spacing inside each group; mt-4 between groups
              // creates a visual gap without needing a divider line.
              className={`space-y-0.5 ${gi > 0 ? 'mt-4' : ''}`}
            >
              {group.label && (
                <div className="px-3 pb-1.5 eyebrow-xs tracking-widest select-none">
                  {group.label}
                </div>
              )}
              {group.items.map(({ to, label, icon: Icon, end, match }) => {
                // Section links highlight on ANY of their tab routes (`match`);
                // plain links fall back to NavLink's own active state.
                const sectionActive = match ? match.includes(location.pathname) : null;
                return (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    className={({ isActive }) => {
                      const on = sectionActive != null ? sectionActive : isActive;
                      return `flex items-center gap-2.5 px-3 min-h-11 md:min-h-9 rounded-md text-sm transition-all active:scale-[0.99] ${
                        on
                          ? 'bg-brand-grad text-white font-medium shadow-[0_4px_14px_-3px_rgba(168,86,32,0.55)]'
                          : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
                      }`;
                    }}
                  >
                    <Icon size={16} />
                    {label}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        <ProfileMenu />
      </aside>

      {/* Desktop "show sidebar" toggle — only rendered while collapsed. Lives in
          the gutter the collapsed <main> reserves (md:pl-12 below), so it never
          overlaps the page's back-link or title. Hidden on mobile, which has its
          own topbar Menu button. */}
      {collapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="hidden md:inline-flex fixed top-3 left-2.5 z-20 items-center justify-center w-9 h-9 rounded-md bg-white text-ink-600 border border-ink-200 shadow-soft hover:bg-ink-50 hover:text-ink-900 transition-colors"
          aria-label="Mostrar menú"
          title="Mostrar menú"
        >
          <PanelLeft size={18} />
        </button>
      )}

      {/* Single scroll container for the whole app shell. html/body are
          pinned in index.css so this is where momentum scrolling lives.
          overflow-x-hidden is a hard safety net so no descendant can ever
          cause horizontal scrolling regardless of width. overscroll-contain
          stops a fling from chaining up to the locked body (which on iOS
          would otherwise show a 1-pixel bounce flicker). When the sidebar is
          collapsed, a small left gutter (md:pl-12) keeps content clear of the
          floating show-toggle. */}
      <main className={`flex-1 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain ${collapsed ? 'md:pl-12' : ''}`}>
        <MainContent />
      </main>
    </div>
  );
}

function MainContent() {
  const location = useLocation();
  // Landscape-notch insets via pl/pr-safe so content doesn't slide under the
  // Dynamic Island ear. Bottom padding reserves room for the QuoteBuilder's
  // sticky mobile totals bar AND the home indicator.
  return (
    <div className="px-4 py-4 md:px-8 md:py-6 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] md:pl-8 md:pr-8 pb-[calc(1.5rem+env(safe-area-inset-bottom))] md:pb-6">
      <div className="max-w-[1400px] mx-auto">
        <AccountingSubnav />
        <Outlet key={location.pathname} />
      </div>
    </div>
  );
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
