import { NavLink, useLocation } from 'react-router-dom';

/**
 * The Inventario section's secondary tab strip — same look as the accounting
 * AccountingSubnav, but Inventario is a STANDALONE section (no longer a
 * Contabilidad center), so its two surfaces own this strip themselves rather
 * than reading it from the accounting section map:
 *   • Ligne Roset     — our on-hand stock (import-fed `inventory_items`). The
 *     route slug stays /existencias (stable bookmarks); only the label moved.
 *   • LifestyleGarden — the stock synced from the LSG Shopify store.
 */
const TABS = [
  { to: '/inventario/existencias', label: 'Ligne Roset' },
  { to: '/inventario/lifestylegarden', label: 'LifestyleGarden' },
];

export default function InventorySubnav() {
  const { pathname } = useLocation();
  return (
    <div className="mb-5 border-b border-ink-100 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex gap-0.5 whitespace-nowrap">
        {TABS.map((t) => (
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
