import { Fragment } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { breadcrumbTrail } from '../../lib/accountingSections.js';
import { useBreadcrumbLeaf } from '../../context/Breadcrumbs.jsx';

/**
 * The accounting breadcrumb bar — a thin, always-on "you are here" trail above
 * the secondary tab strip. Derived from the route (breadcrumbTrail) and the
 * live leaf a detail page injects (useSetBreadcrumb), so it's intelligent
 * without per-page wiring for the common case. Self-gates: renders nothing
 * outside /accounting or when the trail is just the root.
 */
export default function AccountingBreadcrumbs() {
  const { pathname } = useLocation();
  const leaf = useBreadcrumbLeaf();
  if (!pathname.startsWith('/accounting')) return null;
  const crumbs = breadcrumbTrail(pathname, leaf);
  if (crumbs.length < 2) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      className="mb-3 flex items-center gap-1.5 text-[12px] text-ink-400 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <Fragment key={`${c.label}-${i}`}>
            {i > 0 && <ChevronRight size={12} className="text-ink-300 shrink-0" />}
            {c.to && !last ? (
              <Link to={c.to} className="shrink-0 hover:text-brand-600 transition-colors">
                {c.label}
              </Link>
            ) : (
              <span className={`shrink-0 ${last ? 'text-ink-700 font-medium' : ''}`} aria-current={last ? 'page' : undefined}>
                {c.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
