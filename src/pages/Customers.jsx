import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQueryStatus } from '../db/hooks.js';
import { Plus, Users, Mail, Phone, MapPin, ChevronRight, ArrowRight } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import CustomerModal from '../components/CustomerModal.jsx';
import ListLoading from '../components/ListLoading.jsx';
import ListSearchHeader from '../components/search/ListSearchHeader.jsx';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';

// Two-letter initial pair for the avatar circle. Picks the first letter
// of the name, then the first letter of the company (if any) or of the
// second word in the name as a fallback. Uppercased; empty when nothing
// usable.
function initialsFor(c) {
  const name = (c?.name || '').trim();
  const company = (c?.company || '').trim();
  const first = name.charAt(0);
  const second = company.charAt(0) || name.split(/\s+/)[1]?.charAt(0) || '';
  return (first + second).toUpperCase();
}

export default function Customers() {
  const { profileId } = useApp();
  // useLiveQueryStatus lets us distinguish "fetch still in flight on
  // first mount" from "user really has zero customers" — without that
  // the page would flash the empty-state UI for one frame on every
  // navigation here, which read as a disingenuous "you have no data".
  const { data: customers, loaded } = useLiveQueryStatus(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    []
  );
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);
  // Search header query state. There's no status dimension here (no tabs);
  // secondary filters live in `activeFilters` as {key: value} — currently
  // just ciudad; sort defaults to name A–Z.
  const [filters, setFilters] = useState({}); // { city: <city> }
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });

  // Secondary filter: ciudad. Options are the distinct non-empty city
  // values actually present on this team's customers, so the dropdown
  // never lists a city nobody lives in.
  const cityFilter = useMemo(() => {
    const seen = new Set();
    for (const c of customers) {
      const city = (c.city || '').trim();
      if (city) seen.add(city);
    }
    const options = [...seen]
      .sort((a, b) => a.localeCompare(b))
      .map((city) => ({ value: city, label: city }));
    return {
      key: 'city',
      label: 'Ciudad',
      type: 'select',
      placeholder: 'Todas',
      options,
    };
  }, [customers]);

  const sortOptions = [
    { key: 'name', label: 'Nombre A–Z' },
    { key: 'company', label: 'Empresa' },
    { key: 'recent', label: 'Recientes' },
  ];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const city = filters.city;
    const rows = customers
      .filter((c) => (city ? (c.city || '').trim() === city : true))
      .filter((c) => {
        if (!needle) return true;
        return (
          c.name?.toLowerCase().includes(needle) ||
          c.company?.toLowerCase().includes(needle) ||
          c.email?.toLowerCase().includes(needle)
        );
      });

    // Sort. 'name' / 'company' are locale-aware string compares;
    // 'recent' rides updatedAt (falling back to createdAt). Direction
    // multiplier flips asc/desc.
    const mul = sort.dir === 'asc' ? 1 : -1;
    const sorted = [...rows].sort((a, b) => {
      if (sort.key === 'company') {
        return (a.company || '').toLowerCase().localeCompare((b.company || '').toLowerCase()) * mul;
      }
      if (sort.key === 'recent') {
        return ((a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0)) * mul;
      }
      // name
      return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()) * mul;
    });
    return sorted;
  }, [customers, q, filters, sort]);

  return (
    <>
      <PageHeader
        title="Clientes"
        subtitle={loaded ? `${customers.length} ${customers.length === 1 ? 'cliente' : 'clientes'}` : ' '}
        actions={<button onClick={() => setEditing({})} className="btn-primary"><Plus size={14} /> Agregar cliente</button>}
      />

      {!loaded ? (
        <div className="card overflow-hidden"><ListLoading rows={5} /></div>
      ) : customers.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Sin clientes"
          description="Agrega tu primer cliente para reutilizar sus datos al crear cotizaciones."
          action={<button onClick={() => setEditing({})} className="btn-primary">Agregar cliente</button>}
        />
      ) : (
        <>
          <ListSearchHeader
            searchValue={q}
            onSearchChange={setQ}
            searchPlaceholder="Buscar clientes…"
            filters={[cityFilter]}
            activeFilters={filters}
            onFiltersChange={setFilters}
            sortOptions={sortOptions}
            sort={sort}
            onSortChange={setSort}
            resultCount={filtered.length}
            resultNoun={['cliente', 'clientes']}
          />

          {/* Mobile cards — whole card navigates to the detail page;
              no inline edit affordance (the detail page has its own
              "Editar" button). Avatar + meta strip layout matches the
              Professionals page so dealers learn one pattern. */}
          <div className="md:hidden space-y-2">
            {filtered.map((c) => (
              <Link
                key={c.id}
                to={`/customers/${c.id}`}
                className="card card-interactive block transition-all hover:shadow-md hover:-translate-y-0.5 active:scale-[0.99]"
              >
                <div className="flex items-center gap-3 p-3">
                  <div className="w-10 h-10 rounded-full bg-brand-50 text-brand-700 flex items-center justify-center text-xs font-semibold flex-shrink-0 ring-1 ring-inset ring-brand-100">
                    {initialsFor(c) || <Users size={16} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm text-ink-900 truncate">{c.name}</div>
                    {c.company && (
                      <div className="text-[11px] text-ink-500 truncate">{c.company}</div>
                    )}
                    <MetaStrip c={c} />
                  </div>
                  <ChevronRight size={16} className="text-ink-300 flex-shrink-0" />
                </div>
              </Link>
            ))}
            {filtered.length === 0 && (
              <div className="card card-pad flex flex-col items-center gap-3 py-12 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-ink-100 ring-1 ring-inset ring-black/5">
                  <Users size={20} className="text-ink-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-ink-600">Sin coincidencias</p>
                  <p className="mt-0.5 text-xs text-ink-400">Intenta cambiar el filtro o el término de búsqueda.</p>
                </div>
              </div>
            )}
          </div>

          {/* Desktop table — no overflow wrapper; lower-priority columns
              hide at sub-lg widths so the table never exceeds its container. */}
          <div className="hidden md:block card overflow-hidden">
            <table className="table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Empresa</th>
                  <th className="hidden lg:table-cell">Correo</th>
                  <th className="hidden lg:table-cell">Teléfono</th>
                  <th className="hidden xl:table-cell">Ciudad</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  // Row click navigates to the detail page (related
                  // quotes + orders). The "Editar" button stops
                  // propagation so contact-info edits stay inline.
                  <tr
                    key={c.id}
                    className="cursor-pointer transition-all hover:bg-ink-50/80 active:bg-ink-100"
                    onClick={() => { window.location.hash = `#/customers/${c.id}`; }}
                  >
                    <td className="font-medium truncate max-w-[200px]" title={c.name}>{c.name}</td>
                    <td className="text-ink-700 truncate max-w-[200px]" title={c.company || ''}>{c.company || '—'}</td>
                    <td className="hidden lg:table-cell text-ink-700 truncate max-w-[200px]" title={c.email || ''}>{c.email || '—'}</td>
                    <td className="hidden lg:table-cell text-ink-700 whitespace-nowrap">{c.phone || '—'}</td>
                    <td className="hidden xl:table-cell text-ink-700 truncate max-w-[160px]" title={c.city || ''}>{c.city || '—'}</td>
                    <td className="text-right w-24">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setEditing(c); }}
                        className="text-xs font-medium text-ink-400 hover:text-brand-700 transition-colors"
                      >
                        Editar
                      </button>
                      <span className="text-ink-200 ml-2"><ArrowRight size={12} className="inline" /></span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <CustomerModal customer={editing} onClose={() => setEditing(null)} profileId={profileId} />
    </>
  );
}

// Meta strip — Mail · Phone · City. Each piece only renders if the
// underlying field has a value; the · separator is drawn between
// rendered pieces, never trailing. Skipping empty fields keeps cards
// dense and avoids the "wall of —" the old layout had.
function MetaStrip({ c }) {
  const parts = [];
  if (c.email) parts.push({ icon: Mail, value: c.email, key: 'email' });
  if (c.phone) parts.push({ icon: Phone, value: c.phone, key: 'phone' });
  if (c.city) parts.push({ icon: MapPin, value: c.city, key: 'city' });
  if (parts.length === 0) return null;
  return (
    <div className="text-[11px] text-ink-500 mt-0.5 flex items-center gap-1 min-w-0">
      {parts.map((p, i) => {
        const Icon = p.icon;
        return (
          <span key={p.key} className="inline-flex items-center gap-1 min-w-0">
            {i > 0 && <span aria-hidden="true" className="text-ink-300">·</span>}
            <Icon size={11} className="text-ink-400 flex-shrink-0" />
            <span className="truncate">{p.value}</span>
          </span>
        );
      })}
    </div>
  );
}
