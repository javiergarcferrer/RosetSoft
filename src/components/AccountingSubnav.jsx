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
    <div className="mb-5 border-b border-ink-100 overflow-x-auto">
      <div className="flex gap-1 whitespace-nowrap">
        {section.tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
              t.to === pathname
                ? 'border-ink-900 text-ink-900 font-medium'
                : 'border-transparent text-ink-500 hover:text-ink-800'
            }`}
          >
            {t.label}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
