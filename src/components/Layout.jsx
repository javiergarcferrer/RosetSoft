import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  UserSquare2,
  FileText,
  Package,
  Settings as SettingsIcon,
  Shield,
  Wallet,
  FileCheck,
  Download,
  Menu,
  X,
} from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import ProfileMenu from './ProfileMenu.jsx';
import ImageView from './ImageView.jsx';

// Sidebar groups. The two single-item groups at the ends (Inicio and
// Configuración) sit on their own so the visual rhythm of the nav
// reads as: home → contacts → sales → (admin tools if applicable) →
// settings. Configuración is admin-only (the dealer doesn't want
// employees seeing currency rates, company info, etc.), so we slice
// it off for non-admins below.
const baseNavGroups = [
  { items: [{ to: '/', label: 'Inicio', icon: LayoutDashboard, end: true }] },
  {
    label: 'Contactos',
    items: [
      { to: '/customers', label: 'Clientes', icon: Users },
      { to: '/professionals', label: 'Profesionales', icon: UserSquare2 },
    ],
  },
  {
    label: 'Ventas',
    items: [
      { to: '/quotes', label: 'Cotizaciones', icon: FileText },
      { to: '/orders', label: 'Pedidos', icon: Package },
    ],
  },
  { items: [{ to: '/settings', label: 'Configuración', icon: SettingsIcon }] },
];

// Admin-only cluster — Users management + monthly commissions report.
// Spliced into the nav just before "Configuración" so admins read the
// list as: work surfaces first, admin tools, then their own settings.
const adminNavGroup = {
  label: 'Administración',
  items: [
    { to: '/admin/users',       label: 'Usuarios',   icon: Shield },
    { to: '/admin/commissions', label: 'Comisiones', icon: Wallet },
  ],
};

// Accounting-only nav. Contabilidad users don't see the sales surfaces
// at all — they get their own home (read-only KPI dashboard) and a
// "Contabilidad" cluster with accepted-quote downloads, the payable
// commissions report, and the Odoo CSV exporter. No /quotes, /orders,
// /customers, or admin links — they aren't a sales role.
const accountingNavGroups = [
  { items: [{ to: '/accounting', label: 'Inicio', icon: LayoutDashboard, end: true }] },
  {
    label: 'Contabilidad',
    items: [
      { to: '/accounting/quotes',      label: 'Aceptadas',  icon: FileCheck },
      { to: '/accounting/commissions', label: 'Comisiones', icon: Wallet },
      { to: '/accounting/odoo',        label: 'Odoo',       icon: Download },
    ],
  },
];

export default function Layout() {
  const { settings, isAdmin, isAccounting } = useApp();
  // Three nav shapes:
  //   • Accounting users → their own home + Contabilidad cluster. No
  //     sales pages, no admin tools — this is a parallel surface.
  //   • Admins → base groups up to "Ventas", then the admin cluster,
  //     then "Configuración" (also admin-only).
  //   • Employees → base groups minus "Configuración" — they don't
  //     even see the route exist.
  const navGroups = isAccounting
    ? accountingNavGroups
    : isAdmin
      ? [...baseNavGroups.slice(0, -1), adminNavGroup, baseNavGroups[baseNavGroups.length - 1]]
      : baseNavGroups.slice(0, -1);
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const isMobile = !useMediaQuery('(min-width: 768px)');
  const company = settings?.companyName || 'Roset Soft';

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

  return (
    <div className="h-full flex flex-col md:flex-row">
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
        <div className="min-w-0 px-2 flex items-center gap-2">
          {settings?.logoImageId && (
            <ImageView
              id={settings.logoImageId}
              alt={company + ' logo'}
              className="w-7 h-7 flex-shrink-0 object-contain bg-white rounded-md"
              placeholderClassName="w-7 h-7 flex-shrink-0 rounded-md"
            />
          )}
          <div className="min-w-0 text-center">
            <div className="text-[9px] uppercase tracking-widest text-ink-400 leading-none">Roset Soft</div>
            <div className="text-sm font-semibold truncate leading-tight" title={company}>{company}</div>
          </div>
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
        className={`bg-ink-900 text-ink-100 flex-shrink-0 flex flex-col fixed md:static inset-y-0 left-0 z-50 w-[min(16rem,85vw)] md:w-60 pt-safe-area pb-safe-area pl-safe-area transform transition-transform duration-200 md:transform-none md:pt-0 md:pb-0 md:pl-0 ${
          navOpen ? 'translate-x-0 shadow-pop' : '-translate-x-full md:translate-x-0'
        }`}
        aria-label="Navegación principal"
      >
        <div className="px-5 py-5 border-b border-ink-800 flex items-start justify-between">
          <div className="min-w-0 flex items-center gap-2.5">
            {settings?.logoImageId && (
              <ImageView
                id={settings.logoImageId}
                alt={company + ' logo'}
                className="w-9 h-9 flex-shrink-0 object-contain bg-white rounded-md"
                placeholderClassName="w-9 h-9 flex-shrink-0 rounded-md"
              />
            )}
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-widest text-ink-400">Roset Soft</div>
              <div className="text-base font-semibold leading-tight mt-0.5 truncate" title={company}>
                {company}
              </div>
            </div>
          </div>
          <button
            onClick={() => setNavOpen(false)}
            className="md:hidden inline-flex items-center justify-center w-11 h-11 -mr-2 -my-2 rounded text-ink-400 hover:text-ink-100 hover:bg-ink-800 active:bg-ink-700 transition-colors"
            aria-label="Cerrar menú"
          >
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 px-2 py-3 overflow-y-auto overscroll-contain">
          {navGroups.map((group, gi) => (
            <div
              key={gi}
              // Top/bottom spacing inside each group; mt-4 between groups
              // creates a visual gap without needing a divider line.
              className={`space-y-0.5 ${gi > 0 ? 'mt-4' : ''}`}
            >
              {group.label && (
                <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-ink-500 select-none">
                  {group.label}
                </div>
              )}
              {group.items.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 px-3 min-h-11 md:min-h-9 rounded-md text-sm transition-colors active:bg-ink-700 ${
                      isActive
                        ? 'bg-ink-700 text-white'
                        : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
                    }`
                  }
                >
                  <Icon size={16} />
                  {label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <ProfileMenu />
      </aside>

      {/* Single scroll container for the whole app shell. html/body are
          pinned in index.css so this is where momentum scrolling lives.
          overflow-x-hidden is a hard safety net so no descendant can ever
          cause horizontal scrolling regardless of width. overscroll-contain
          stops a fling from chaining up to the locked body (which on iOS
          would otherwise show a 1-pixel bounce flicker). */}
      <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain">
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
