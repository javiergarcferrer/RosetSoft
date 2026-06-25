import { Fragment, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Menu, X, Search, Bot } from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import ProfileMenu from './ProfileMenu.jsx';
import ViewAsToggle from './ViewAsToggle.jsx';
import ImageView from './ImageView.jsx';
import ListLoading from './ListLoading.jsx';
import AccountingSubnav from './AccountingSubnav.jsx';
import QuickCreate from './QuickCreate.jsx';
import GlobalSearch from './GlobalSearch.jsx';
import { useScrollRestoration } from '../context/NavMemory.jsx';
import { navForRole } from '../lib/access.js';
import { useKeyboardShortcut, shortcutLabel } from '../lib/useKeyboardShortcut.js';
import { useLiveQuery } from '../db/hooks.js';
import { db } from '../db/database.js';

// Persisted preference for the desktop "hide sidebar" toggle (see Layout).
const SIDEBAR_COLLAPSED_KEY = 'rs.sidebarCollapsed';

// One sidebar row — parent OR an indented child. The single render path for
// every nav link, so the `children` reveal reuses it instead of duplicating the
// active/hover/badge styling.
function SidebarLink({ item, sub = false, pathname, waUnread, compact = false }) {
  const { to, label, icon: Icon, end, match } = item;
  // Section links highlight on ANY of their tab routes (`match`); plain links
  // fall back to NavLink's own active state.
  const sectionActive = match ? match.includes(pathname) : null;
  const showBadge = to === '/chats' && waUnread > 0;
  // Custom hover tooltip — only in the collapsed icon rail, where the label is
  // hidden. Portaled to <body> so the nav's own overflow can't clip it; it
  // tracks the row's rect so it floats just to the right of the icon.
  const linkRef = useRef(null);
  const [tip, setTip] = useState(null);
  const openTip = () => {
    if (!compact) return;
    const r = linkRef.current?.getBoundingClientRect();
    if (r) setTip({ top: r.top + r.height / 2, left: r.right + 12 });
  };
  const closeTip = () => setTip(null);
  return (
    <>
    <NavLink
      ref={linkRef}
      to={to}
      end={end}
      onMouseEnter={openTip}
      onMouseLeave={closeTip}
      onFocus={openTip}
      onBlur={closeTip}
      // `aria-label` names the icon-only row when its label is hidden; the rail's
      // hover label is the portaled tooltip below (no native `title` — it would
      // double up with it and can't be styled).
      aria-label={compact ? label : undefined}
      className={({ isActive }) => {
        const on = sectionActive != null ? sectionActive : isActive;
        // A `sub` row is indented + hung off a hairline, reading as a child.
        // `compact` is the icon-rail variant: center the glyph, drop the label.
        return `relative flex items-center gap-2.5 min-h-11 md:min-h-9 rounded-md text-sm transition-all active:scale-[0.99] ${compact ? 'px-3 md:justify-center md:gap-0 md:px-0' : 'px-3'} ${sub ? 'ml-4 border-l border-ink-700/60 rounded-l-none' : ''} ${
          on
            ? 'bg-brand-grad text-white font-medium shadow-[0_4px_14px_-3px_rgba(168,86,32,0.55)]'
            : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
        }`;
      }}
    >
      <Icon size={16} className="shrink-0" />
      {!compact && label}
      {showBadge && (compact ? (
        // Collapsed rail: the count won't fit, so it shrinks to a corner dot.
        <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-ink-900" />
      ) : (
        <span className="ml-auto min-w-5 h-5 px-1.5 rounded-full bg-emerald-600 text-white text-[10px] font-bold inline-flex items-center justify-center tabular-nums">
          {waUnread > 99 ? '99+' : waUnread}
        </span>
      ))}
    </NavLink>
    {tip && createPortal(
      <div
        className="theme-chrome fixed z-[90] -translate-y-1/2 pointer-events-none animate-in fade-in slide-in-from-left-1 duration-100"
        style={{ top: tip.top, left: tip.left }}
      >
        <div className="relative rounded-lg bg-ink-800 text-ink-50 text-xs font-medium px-2.5 py-1.5 shadow-pop border border-ink-700 whitespace-nowrap">
          {label}
          <span aria-hidden className="absolute right-full top-1/2 -translate-y-1/2 border-[5px] border-transparent border-r-ink-800" />
        </div>
      </div>,
      document.body,
    )}
    </>
  );
}

// A parent's section is "open" (its children shown) when the route sits on the
// parent or any child — the one rule behind every contextual reveal.
function isSectionOpen(item, pathname) {
  if (!item.children?.length) return false;
  const onPath = (to) => pathname === to || pathname.startsWith(`${to}/`);
  return onPath(item.to)
    || (item.match && item.match.includes(pathname))
    || item.children.some((c) => onPath(c.to));
}

// The unified, role-gated sidebar — ONE system across both cores — is defined
// by the "limbic" access layer (lib/access.js: navForRole). The role reveals
// its slice; admins see both cores in one place.

export default function Layout() {
  const { settings, currentProfile, isAdmin, isAccounting, profileId } = useApp();
  const location = useLocation();
  // The admin's Contabilidad section list is contextual: it joins the sidebar
  // only while they're inside /accounting/* (the Administración group carries
  // the single entry link).
  const navGroups = navForRole(currentProfile?.role, {
    accountingOpen: location.pathname.startsWith('/accounting'),
  });
  // Unread WhatsApp badge on the nav entry — inbound messages not yet opened
  // in the inbox. Rides the same live-query invalidation as the rest of the
  // app, so opening a thread (which stamps readAt) clears it everywhere. The
  // WhatsApp inbox is admin-only while in testing, so only admins carry the
  // nav entry (and need this query) — skip it for everyone else.
  const waMessages = useLiveQuery(
    () => (isAdmin ? db.waMessages.where('profileId').equals(profileId || '').toArray() : Promise.resolve([])),
    [profileId, isAdmin],
    [],
  );
  const waUnread = waMessages.reduce((n, m) => n + (m.direction === 'in' && !m.readAt ? 1 : 0), 0);
  const [navOpen, setNavOpen] = useState(false);
  // Desktop-only: hide the static sidebar to reclaim horizontal space. Persisted
  // so the choice survives reloads. Every effect of it below is md:-gated, so the
  // phone layout (which uses the navOpen drawer instead) is never affected.
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  );
  const isMobile = !useMediaQuery('(min-width: 768px)');
  // Desktop collapse is a thin, STATIC icon rail (not a full hide): the rail
  // stays at w-14 showing only icons and does NOT expand on hover. Discovery is
  // via per-icon tooltips; the toggle (⌘\ or the edge handle) restores the full
  // labeled panel. md:-only (mobile uses the drawer instead).
  const showRailIcons = collapsed && !isMobile;
  const company = settings?.companyName || 'ALCOVER';
  // Global ⌘K search palette — opened from the topbar/sidebar triggers or the
  // keyboard shortcut; the overlay itself owns Escape-to-close.
  const [searchOpen, setSearchOpen] = useState(false);
  useKeyboardShortcut('mod+k', () => setSearchOpen((o) => !o));
  // ⌘\ / Ctrl+\ toggles the sidebar between pinned-open and the icon rail.
  useKeyboardShortcut('mod+\\', () => setCollapsed((c) => !c));

  // Smart-back scroll memory: <main> is the app's single scroll container, so
  // Back/Forward restores the offset here (the window never scrolls, so the
  // browser's native restoration can't). Pages restore their filter/search
  // state via useStickyState; this restores where you were on the page.
  const mainRef = useRef(null);
  useScrollRestoration(mainRef);

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

  // Two CSS vars published on the DOCUMENT ROOT (<html>) let the portaled
  // TotalsDock MIRROR <main>'s left geometry. They must live on the root, not the
  // shell div below: the dock portals to document.body — OUTSIDE this React
  // subtree (a sibling of #root) — and CSS custom properties inherit through the
  // DOM tree, not the React tree, so a var scoped to the shell div would never
  // reach it (it would silently fall back and wedge the dock at one position).
  //   --rs-dock-left : the dock box's left edge = the sidebar's OCCUPIED width
  //                    (15rem pinned-open; 3.5rem = the w-14 icon rail when
  //                    collapsed — the rail sits in-flow, so the dock starts just
  //                    past it and never covers it).
  //   --rs-dock-pad  : extra left padding that re-insets the dock's CONTENT under
  //                    the page columns — 0 in both states, since the in-flow rail
  //                    already reserves its own width.
  // Consumed only via md:-gated utilities, so the mobile drawer layout ignores them.
  const dockLeft = collapsed ? '3.5rem' : '15rem';
  const dockPad = '0px';
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--rs-dock-left', dockLeft);
    root.setProperty('--rs-dock-pad', dockPad);
  }, [dockLeft, dockPad]);

  return (
    <div className="h-full flex flex-col md:flex-row">
      {/* Mobile topbar — extends behind the status bar on standalone iOS
          via pt-safe-area, so our dark background covers the white status-bar
          text instead of leaving a milky strip above the topbar. */}
      <header className="theme-chrome md:hidden sticky top-0 z-30 flex items-center justify-between px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] bg-ink-900 text-ink-100 border-b border-ink-800">
        <div className="flex items-center">
          <button
            onClick={() => setNavOpen(true)}
            className="inline-flex items-center justify-center w-11 h-11 -ml-2 rounded text-ink-100 hover:bg-ink-800 active:bg-ink-700 transition-colors"
            aria-label="Abrir menú"
          >
            <Menu size={20} />
          </button>
          <button
            onClick={() => setSearchOpen(true)}
            className="inline-flex items-center justify-center w-11 h-11 rounded text-ink-100 hover:bg-ink-800 active:bg-ink-700 transition-colors"
            aria-label="Buscar"
          >
            <Search size={19} />
          </button>
        </div>
        {/* Brand block — the dealer's typographic logo (an SVG, usually a
            wordmark) rendered in white over the dark bar. No background box,
            no rounded chrome — the logo IS the brand mark and shouldn't sit inside
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
              className="h-6 max-w-[clamp(7rem,30vw,10rem)] object-contain"
              style={{ filter: 'brightness(0) invert(1)' }}
              placeholderClassName="h-6 w-24"
            />
          ) : (
            <div className="font-wordmark text-base truncate leading-tight" title={company}>{company}</div>
          )}
        </div>
        {/* Spacer mirrors the left button group (menu + search) so the brand
            block stays visually centered between them. */}
        <div className="w-20" />
      </header>

      {/* Mobile drawer overlay */}
      {navOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/50"
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
        className={`theme-chrome bg-gradient-to-b from-ink-800 via-ink-900 to-ink-900 text-ink-100 flex-shrink-0 flex flex-col fixed inset-y-0 left-0 z-50 w-[min(16rem,85vw)] md:relative md:border-r md:border-ink-800/60 pt-safe-area pb-safe-area pl-safe-area transform transition-[transform,width] duration-200 md:duration-300 md:ease-[cubic-bezier(0.22,1,0.36,1)] md:transform-none md:pt-0 md:pb-0 md:pl-0 ${
          navOpen ? 'translate-x-0 shadow-pop' : '-translate-x-full md:translate-x-0'
        } ${collapsed ? 'md:w-14' : 'md:w-60'}`}
        aria-label="Navegación principal"
      >
        {/* Collapse handle — an elongated pill pinned to the sidebar's right
            edge; the hover gently widens + warms it. Toggles BOTH ways now: it
            collapses the panel to the icon rail or pins the rail open (⌘\). */}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="hidden md:block absolute right-0 top-1/2 z-10 h-16 w-1.5 -translate-y-1/2 rounded-l-full bg-ink-700/70 transition-all duration-200 hover:w-2.5 hover:bg-brand-500/80"
          aria-label={collapsed ? 'Fijar menú abierto' : 'Ocultar menú'}
          title={`${collapsed ? 'Fijar menú abierto' : 'Ocultar menú'} (${shortcutLabel('mod+\\')})`}
        />
        <div className={`border-b border-ink-800 ${showRailIcons ? 'px-2 py-4' : 'px-5 py-5'}`}>
          {/* JARVIS — the global command center, sitting above the brand and
              highlighted in its own signature color (admin-only, like the
              /jarvis route's own gate). Collapses to a single centered glyph. */}
          {isAdmin && (
            <NavLink
              to="/jarvis"
              onClick={() => setNavOpen(false)}
              title="JARVIS"
              className={({ isActive }) => `mb-3 flex w-full items-center justify-center gap-2 rounded-lg border text-sm font-semibold tracking-wide transition-all ${showRailIcons ? 'h-9 px-0' : 'px-3 py-2'} ${
                isActive
                  ? 'border-[#3600ff] bg-[#3600ff]/30 text-white shadow-[0_0_22px_-4px_#3600ff]'
                  : 'border-[#3600ff]/50 bg-[#3600ff]/12 text-ink-100 hover:border-[#3600ff] hover:bg-[#3600ff]/25 hover:text-white hover:shadow-[0_0_18px_-6px_#3600ff]'
              }`}
            >
              <Bot size={15} /> {!showRailIcons && 'JARVIS'}
            </NavLink>
          )}
          {showRailIcons ? (
            /* Icon-rail brand — a compact centered mark (logo or monogram). */
            <div className="flex justify-center">
              {settings?.logoImageId ? (
                <ImageView
                  id={settings.logoImageId}
                  alt={company + ' logo'}
                  className="h-7 w-7 object-contain"
                  style={{ filter: 'brightness(0) invert(1)' }}
                  placeholderClassName="h-7 w-7"
                />
              ) : (
                <div className="font-wordmark text-lg leading-none select-none" title={company}>
                  {(company[0] || 'A').toUpperCase()}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-start justify-between gap-3">
              {/* Brand block — typographic logo. See the mobile topbar's matching
                  block for the rationale on the white-tint filter and the lack of
                  a background box. */}
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
              </div>
              {/* Mobile: close the slide-in drawer. */}
              <button
                onClick={() => setNavOpen(false)}
                className="md:hidden -mr-2 -my-2 inline-flex items-center justify-center w-11 h-11 rounded text-ink-400 hover:text-ink-100 hover:bg-ink-800 active:bg-ink-700 transition-colors"
                aria-label="Cerrar menú"
              >
                <X size={20} />
              </button>
            </div>
          )}
        </div>

        {/* Global search trigger — a quiet "Buscar… ⌘K" pill under the brand;
            shrinks to a single search glyph in the icon rail. Desktop-only: the
            mobile topbar already carries the search icon. */}
        <div className="hidden md:block px-3 pt-3">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            title={showRailIcons ? `Buscar (${shortcutLabel('mod+k')})` : undefined}
            className={`flex w-full items-center h-9 rounded-lg bg-ink-800/60 border border-ink-700/60 text-ink-400 hover:bg-ink-800 hover:text-ink-200 text-sm transition-colors ${showRailIcons ? 'justify-center px-0' : 'gap-2 px-3'}`}
          >
            <Search size={showRailIcons ? 16 : 14} aria-hidden />
            {!showRailIcons && (
              <>
                <span className="flex-1 text-left">Buscar…</span>
                <kbd className="rounded border border-ink-700 px-1.5 py-0.5 text-[10px] font-medium text-ink-400">
                  {shortcutLabel('mod+k')}
                </kbd>
              </>
            )}
          </button>
        </div>

        {/* QuickBooks-style "+ Nuevo" quick-create — only where accounting
            create flows are reachable (accounting users + admins). Hidden in the
            icon rail; shown only in the full (expanded) sidebar. */}
        {!showRailIcons && (isAccounting || isAdmin) && <QuickCreate />}

        {/* Admin-only "Ver como" preview — sits right under the brand mark so
            it's discreet but always at hand. Renders nothing for non-admins
            and is hidden in the mobile drawer (the component owns both). */}
        {!showRailIcons && <ViewAsToggle />}

        <nav className="flex-1 px-2 py-3 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {navGroups.map((group, gi) => (
            // mt-4 between groups creates the visual gap; the gray rounded
            // bracket on the left visually binds each group's icons together.
            <div key={gi} className={gi > 0 ? 'mt-4' : ''}>
              {group.label && !showRailIcons && (
                // pl-5 aligns the eyebrow with the icons (group pl-2 + row px-3).
                <div className="pl-5 pr-3 pb-1.5 eyebrow-xs tracking-widest select-none">
                  {group.label}
                </div>
              )}
              <div className="relative pl-2 space-y-0.5">
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-[3px] top-1 bottom-1 w-[3px] rounded-full bg-ink-700/50"
                />
                {group.items.map((item) => (
                  <Fragment key={item.to}>
                    {/* `sub` is forced only on a revealed child below (Togo is no
                        longer a nested sub-item). */}
                    <SidebarLink item={item} sub={item.sub} pathname={location.pathname} waUnread={waUnread} compact={showRailIcons} />
                    {/* Children reveal (indented) only while their section is open —
                        and never in the icon rail, where indented icons read poorly. */}
                    {!showRailIcons && isSectionOpen(item, location.pathname) && item.children.map((c) => (
                      <SidebarLink key={c.to} item={c} sub pathname={location.pathname} waUnread={waUnread} />
                    ))}
                  </Fragment>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <ProfileMenu compact={showRailIcons} />
      </aside>

      {/* (The old fixed "show sidebar" toggle is gone: the icon rail is always
          visible, and the right-edge handle / ⌘\ toggles the pinned state.) */}

      {/* Single scroll container for the whole app shell. html/body are
          pinned in index.css so this is where momentum scrolling lives.
          overflow-x-hidden is a hard safety net so no descendant can ever
          cause horizontal scrolling regardless of width. overscroll-contain
          stops a fling from chaining up to the locked body (which on iOS
          would otherwise show a 1-pixel bounce flicker). When the sidebar is
          collapsed, a small left gutter (md:pl-12) keeps content clear of the
          floating show-toggle. */}
      <main ref={mainRef} className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain kb-scroll-pad">
        <MainContent />
      </main>

      {/* Global ⌘K search palette — renders (and fetches) only while open. */}
      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

function MainContent() {
  const location = useLocation();
  // Landscape-notch insets via pl/pr-safe so content doesn't slide under the
  // Dynamic Island ear. Bottom padding reserves room for the QuoteBuilder's
  // sticky mobile totals bar AND the home indicator.
  // The Suspense boundary catches the code-split accounting/admin pages while
  // their chunk loads — the shell (sidebar + subnav) stays put.
  return (
    <div className="px-4 py-4 md:px-8 md:py-6 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] md:pl-8 md:pr-8 pb-[calc(1.5rem+env(safe-area-inset-bottom))] md:pb-6">
      <div className={`max-w-[1400px] mx-auto${location.pathname.startsWith('/accounting') ? ' acct-dense' : ''}`}>
        <AccountingSubnav />
        <Suspense fallback={<ListLoading />}>
          <Outlet key={location.pathname} />
        </Suspense>
      </div>
    </div>
  );
}

export function useMediaQuery(query) {
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
