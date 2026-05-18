import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQueryStatus } from '../db/hooks.js';
import { Plus, Search, Users, Mail, Phone, MapPin, ChevronRight, ArrowRight } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import CustomerModal from '../components/CustomerModal.jsx';
import ListLoading from '../components/ListLoading.jsx';
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

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return customers;
    return customers.filter((c) =>
      c.name?.toLowerCase().includes(needle) ||
      c.company?.toLowerCase().includes(needle) ||
      c.email?.toLowerCase().includes(needle)
    );
  }, [customers, q]);

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
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
            <div className="relative flex-1 max-w-md">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                type="search"
                inputMode="search"
                enterKeyHint="search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar clientes…"
                className="input pl-9"
              />
            </div>
          </div>

          {/* Mobile cards — whole card navigates to the detail page;
              no inline edit affordance (the detail page has its own
              "Editar" button). Avatar + meta strip layout matches the
              Professionals page so dealers learn one pattern. */}
          <div className="md:hidden space-y-2">
            {filtered.map((c) => (
              <Link
                key={c.id}
                to={`/customers/${c.id}`}
                className="card block hover:bg-ink-50"
              >
                <div className="flex items-center gap-3 p-3">
                  <div className="w-10 h-10 rounded-full bg-brand-50 text-brand-700 flex items-center justify-center text-xs font-semibold flex-shrink-0">
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
              <div className="card card-pad text-center text-sm text-ink-500">Sin coincidencias.</div>
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
                    className="cursor-pointer"
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
                        className="text-xs text-ink-500 hover:text-ink-900"
                      >
                        Editar
                      </button>
                      <span className="text-ink-300 ml-2"><ArrowRight size={12} className="inline" /></span>
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
