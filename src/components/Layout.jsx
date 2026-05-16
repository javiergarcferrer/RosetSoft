import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  FileText,
  Container as ContainerIcon,
  Settings as SettingsIcon,
  Menu,
  X,
} from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import ProfileMenu from './ProfileMenu.jsx';

const navItems = [
  { to: '/', label: 'Inicio', icon: LayoutDashboard, end: true },
  { to: '/customers', label: 'Clientes', icon: Users },
  { to: '/quotes', label: 'Cotizaciones', icon: FileText },
  { to: '/containers', label: 'Contenedores', icon: ContainerIcon },
  { to: '/settings', label: 'Configuración', icon: SettingsIcon },
];

export default function Layout() {
  const { settings } = useApp();
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
      {/* Mobile topbar */}
      <header className="md:hidden flex items-center justify-between px-3 py-2.5 bg-ink-900 text-ink-100 border-b border-ink-800">
        <button
          onClick={() => setNavOpen(true)}
          className="p-2.5 -ml-1 rounded hover:bg-ink-800"
          aria-label="Abrir menú"
        >
          <Menu size={20} />
        </button>
        <div className="min-w-0 px-2 text-center">
          <div className="text-[9px] uppercase tracking-widest text-ink-400 leading-none">Roset Soft</div>
          <div className="text-sm font-semibold truncate leading-tight" title={company}>{company}</div>
        </div>
        <div className="w-8" />
      </header>

      {/* Mobile drawer overlay */}
      {navOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-ink-900/40"
          onClick={() => setNavOpen(false)}
        />
      )}

      {/* Sidebar — slides in on mobile, static on desktop */}
      <aside
        className={`bg-ink-900 text-ink-100 flex-shrink-0 flex flex-col fixed md:static inset-y-0 left-0 z-50 w-64 md:w-60 transform transition-transform duration-200 md:transform-none ${
          navOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        <div className="px-5 py-5 border-b border-ink-800 flex items-start justify-between">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-ink-400">Roset Soft</div>
            <div className="text-base font-semibold leading-tight mt-0.5 truncate" title={company}>
              {company}
            </div>
          </div>
          <button
            onClick={() => setNavOpen(false)}
            className="md:hidden text-ink-400 hover:text-ink-100 p-2 -mr-2 -my-1"
            aria-label="Cerrar menú"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
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
        </nav>

        <ProfileMenu />
      </aside>

      {/* overflow-x-hidden is a hard safety net: no descendant can ever
          cause the page to scroll horizontally regardless of width. */}
      <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
        <MainContent />
      </main>
    </div>
  );
}

function MainContent() {
  const location = useLocation();
  return (
    <div className="px-4 py-4 md:px-8 md:py-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] md:pb-6">
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
