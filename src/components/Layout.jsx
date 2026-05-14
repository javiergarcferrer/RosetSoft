import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Sofa,
  Palette,
  Users,
  FileText,
  Container as ContainerIcon,
  Upload,
  Settings as SettingsIcon,
  ChevronDown,
} from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { useCart } from '../context/CartContext.jsx';
import ProfileMenu from './ProfileMenu.jsx';
import QuoteCart from './QuoteCart.jsx';

const navItems = [
  { to: '/', label: 'Inicio', icon: LayoutDashboard, end: true },
  { to: '/catalog', label: 'Catálogo', icon: Sofa },
  { to: '/materials', label: 'Telas y cueros', icon: Palette },
  { to: '/customers', label: 'Clientes', icon: Users },
  { to: '/quotes', label: 'Cotizaciones', icon: FileText },
  { to: '/containers', label: 'Contenedores', icon: ContainerIcon },
  { to: '/import', label: 'Importar PDF', icon: Upload },
  { to: '/settings', label: 'Configuración', icon: SettingsIcon },
];

export default function Layout() {
  const { settings } = useApp();
  const location = useLocation();
  const company = settings?.companyName || 'Roset Soft';

  return (
    <div className="h-full flex">
      {/* Sidebar */}
      <aside className="w-60 bg-ink-900 text-ink-100 flex-shrink-0 flex flex-col">
        <div className="px-5 py-5 border-b border-ink-800">
          <div className="text-[10px] uppercase tracking-widest text-ink-400">Roset Soft</div>
          <div className="text-base font-semibold leading-tight mt-0.5 truncate" title={company}>
            {company}
          </div>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-0.5">
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

      <main className="flex-1 overflow-y-auto">
        <MainContent />
      </main>
      <QuoteCart />
    </div>
  );
}

function MainContent() {
  const { open } = useCart();
  const location = useLocation();
  return (
    <div
      className="px-8 py-6 transition-[padding] duration-150"
      style={{ paddingRight: open ? 408 : undefined }}
    >
      <div className="max-w-[1400px] mx-auto">
        <Outlet key={location.pathname} />
      </div>
    </div>
  );
}
