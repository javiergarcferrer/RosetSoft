import { NavLink, useLocation } from 'react-router-dom';
import { sectionForPath } from '../lib/accountingSections.js';

/**
 * QuickBooks-style secondary navigation: the horizontal tab strip for the
 * accounting section the current route belongs to. Renders nothing on routes
 * outside a multi-tab section (so single-page sections show no strip).
 */
export default function AccountingSubnav() {
  const { pathname } = useLocation();
  const section = sectionForPath(pathname);
  if (!section || section.tabs.length < 2) return null;
  return (
    <div className="mb-5 border-b border-ink-100 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex gap-0.5 whitespace-nowrap">
        {section.tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={`px-3.5 py-2.5 coarse:py-3 text-sm border-b-2 -mb-px transition-all duration-150 rounded-t-md select-none ${
              t.to === pathname
                ? 'border-brand-500 text-brand-600 font-semibold'
                : 'border-transparent text-ink-500 hover:text-ink-800 hover:border-ink-200 hover:bg-ink-50/60'
            }`}
          >
            {t.label}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
