import { Link } from 'react-router-dom';
import { BookOpen, ChevronRight, Shield } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { catalogCategories } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import { BRAND_LIGNE_ROSET } from '../../lib/constants.js';

/**
 * Catálogos — the section where the BRAND catalogs for quoting live. One card
 * per brand; each brand's page owns its catalog AND its particular import
 * manner:
 *   • Ligne Roset — the supplier price-list CSV upload.
 * (LifestyleGarden is the team's OWN stock — it lives under Inventario, not
 * here.) Adding a brand = one entry here + its page.
 */
const BRANDS = [
  {
    brand: BRAND_LIGNE_ROSET,
    to: '/admin/catalog/roset',
    name: 'Ligne Roset',
    importHint: 'Se importa de la lista de precios del proveedor (CSV)',
    icon: BookOpen,
  },
];

export default function Catalogs() {
  const { isAdmin } = useApp();

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Catálogos" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido" description="Solo administradores pueden gestionar los catálogos de productos." />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Catálogos" subtitle="Catálogos de marca para cotizar" />
      <div className="space-y-3">
        {BRANDS.map((b) => (
          <BrandCard key={b.brand} {...b} />
        ))}
      </div>
    </>
  );
}

/** One brand card — name, how it imports, and its live SKU count. */
function BrandCard({ brand, to, name, importHint, icon: Icon }) {
  const { profileId } = useApp();
  // The per-category aggregate (cheap, one round-trip) summed = the brand's
  // SKU total — same source its page header uses, so the numbers agree.
  const { data: categories, loaded } = useLiveQueryStatus(
    () => (profileId ? catalogCategories(profileId, brand) : Promise.resolve([])),
    [profileId, brand],
    [],
  );
  const total = categories.reduce((n, c) => n + c.count, 0);
  return (
    <Link to={to} className="card flex items-center gap-3 px-4 sm:px-5 py-4 hover:bg-ink-50 active:bg-ink-100 transition-colors">
      <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 border border-brand-100">
        <Icon size={18} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-display font-semibold text-sm text-ink-900 truncate">{name}</span>
        <span className="block text-xs text-ink-500 truncate" title={importHint}>{importHint}</span>
      </span>
      <span className="eyebrow-xs flex-shrink-0">
        {loaded ? `${total} SKU` : '…'}
      </span>
      <ChevronRight size={16} className="text-ink-400 flex-shrink-0" aria-hidden />
    </Link>
  );
}
