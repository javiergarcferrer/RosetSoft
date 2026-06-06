import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, UserSquare2, ArrowRight, Mail, Phone, ChevronRight } from 'lucide-react';
import { useLiveQueryStatus } from '../db/hooks.js';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ProfessionalModal from '../components/ProfessionalModal.jsx';
import ListLoading from '../components/ListLoading.jsx';
import ListSearchHeader from '../components/search/ListSearchHeader.jsx';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { clampCommissionPct } from '../lib/commissions.js';

// The reference commission % a row displays — a non-binding note (the real
// rate is the quote's order-type rate, Piso 15% / Especial 20%), clamped into
// the legal [0,20] range, falling back to the house 10% when unset. Kept as a
// single helper so the band filter, the sort, and the rendered cells all read
// the same number (otherwise a row could fall in one band but sort as if it
// were in another).
function commissionOf(p) {
  return clampCommissionPct(p.defaultCommissionPct ?? 10);
}

// Secondary filter: bucket the (clamped) commission % into bands. The
// cap is 20%, so four bands cover the whole range without overlap.
const COMMISSION_BANDS = [
  { value: '0', label: '0%', test: (pct) => pct === 0 },
  { value: '1-5', label: '1–5%', test: (pct) => pct >= 1 && pct <= 5 },
  { value: '6-10', label: '6–10%', test: (pct) => pct >= 6 && pct <= 10 },
  { value: '10+', label: '>10%', test: (pct) => pct > 10 },
];

const COMMISSION_FILTER = {
  key: 'commission',
  label: 'Comisión',
  type: 'select',
  placeholder: 'Todas',
  options: COMMISSION_BANDS.map(({ value, label }) => ({ value, label })),
};

const SORT_OPTIONS = [
  { key: 'name', label: 'Nombre A–Z' },
  { key: 'commission', label: 'Comisión %' },
  { key: 'company', label: 'Empresa' },
];

// Two-letter initial pair for the avatar circle. Picks the first letter
// of the name, then the first letter of the company (if any) or of the
// second word in the name as a fallback. Uppercased; empty when nothing
// usable. Mirrors the helper on the Customers page so the visual
// vocabulary is identical across the two address-book modules.
function initialsFor(p) {
  const name = (p?.name || '').trim();
  const company = (p?.company || '').trim();
  const first = name.charAt(0);
  const second = company.charAt(0) || name.split(/\s+/)[1]?.charAt(0) || '';
  return (first + second).toUpperCase();
}

/**
 * Professionals list — architects, decorators, etc. that bring deals to
 * the showroom and earn a commission. Structurally close to the
 * Customers list (search box + responsive table/cards + edit modal),
 * but each row links into a detail page that shows the professional's
 * pipeline and accrued commissions. The Customers list doesn't have
 * that kind of detail page because customers don't have a financial
 * roll-up — but professionals do, and that's the value of this module.
 */
export default function Professionals() {
  const { profileId } = useApp();
  // useLiveQueryStatus → gate the "Sin profesionales" empty state on
  // the first fetch having completed, so a user navigating into this
  // page doesn't see the false empty state flicker before their real
  // list paints.
  const { data: pros, loaded } = useLiveQueryStatus(
    () => db.professionals.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );

  // Search-header query state. The parent owns it all (the header is
  // presentational): `q` is the search needle, `filters` holds the
  // secondary commission-band selection as { commission: <value> }, and
  // `sort` defaults to name A–Z. No status dimension here, so no tabs.
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);
  const [filters, setFilters] = useState({}); // { commission: '1-5' | … }
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const band = COMMISSION_BANDS.find((b) => b.value === filters.commission);
    const rows = pros.filter((p) => {
      if (band && !band.test(commissionOf(p))) return false;
      if (!needle) return true;
      return (
        p.name?.toLowerCase().includes(needle) ||
        p.company?.toLowerCase().includes(needle) ||
        p.email?.toLowerCase().includes(needle)
      );
    });

    // Sort. 'name' / 'company' are locale string compares; 'commission'
    // rides the same clamped % the cells render. Direction multiplier
    // flips asc/desc.
    const mul = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sort.key === 'commission') {
        return (commissionOf(a) - commissionOf(b)) * mul;
      }
      if (sort.key === 'company') {
        return (a.company || '').toLowerCase().localeCompare((b.company || '').toLowerCase()) * mul;
      }
      // name
      return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()) * mul;
    });
  }, [pros, q, filters, sort]);

  return (
    <>
      <PageHeader
        title="Profesionales"
        subtitle={loaded ? `${pros.length} ${pros.length === 1 ? 'profesional' : 'profesionales'}` : ' '}
        actions={
          <button onClick={() => setEditing({})} className="btn-primary">
            <Plus size={14} /> Agregar profesional
          </button>
        }
      />

      {!loaded ? (
        <div className="card overflow-hidden"><ListLoading rows={5} /></div>
      ) : pros.length === 0 ? (
        <EmptyState
          icon={UserSquare2}
          title="Sin profesionales"
          description="Arquitectos, decoradores u otros profesionales que te traen ventas. Asigna uno a cada cotización y la app calcula la comisión por ti."
          action={<button onClick={() => setEditing({})} className="btn-primary">Agregar profesional</button>}
        />
      ) : (
        <>
          <ListSearchHeader
            searchValue={q}
            onSearchChange={setQ}
            searchPlaceholder="Buscar profesionales…"
            filters={[COMMISSION_FILTER]}
            activeFilters={filters}
            onFiltersChange={setFilters}
            sortOptions={SORT_OPTIONS}
            sort={sort}
            onSortChange={setSort}
            resultCount={filtered.length}
            resultNoun={['profesional', 'profesionales']}
          />

          {/* Mobile cards — whole card navigates to the detail page;
              no inline edit affordance (the detail page has its own
              "Editar" button). Avatar + meta strip layout matches the
              Customers page so dealers learn one pattern. The right-
              hand column keeps the commission % — that's the unique
              piece of information for professionals vs. customers. */}
          <div className="md:hidden space-y-2">
            {filtered.map((p) => (
              <Link
                key={p.id}
                to={`/professionals/${p.id}`}
                className="card card-interactive block transition-all hover:shadow-md hover:-translate-y-0.5 active:scale-[0.99]"
              >
                <div className="flex items-center gap-3 p-3">
                  <div className="w-10 h-10 rounded-full bg-brand-50 text-brand-700 flex items-center justify-center text-xs font-semibold flex-shrink-0 ring-1 ring-inset ring-brand-100">
                    {initialsFor(p) || <UserSquare2 size={16} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm text-ink-900 truncate">{p.name}</div>
                    {p.company && (
                      <div className="text-[11px] text-ink-500 truncate">{p.company}</div>
                    )}
                    <MetaStrip p={p} />
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] uppercase tracking-wide text-ink-400 font-medium">Com. ref.</div>
                    <div className="text-sm font-semibold tabular-nums text-ink-800">
                      {clampCommissionPct(p.defaultCommissionPct ?? 10)}%
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-ink-300 flex-shrink-0" />
                </div>
              </Link>
            ))}
            {filtered.length === 0 && (
              <div className="card card-pad flex flex-col items-center gap-3 py-12 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-ink-100 ring-1 ring-inset ring-black/5">
                  <UserSquare2 size={20} className="text-ink-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-ink-600">Sin coincidencias</p>
                  <p className="mt-0.5 text-xs text-ink-400">Intenta cambiar el filtro o el término de búsqueda.</p>
                </div>
              </div>
            )}
          </div>

          {/* Desktop table — the row click goes to the detail page; the
              edit button stops propagation so the dealer can update
              contact info without leaving the list. */}
          <div className="hidden md:block card overflow-hidden">
            <table className="table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Empresa</th>
                  <th className="hidden lg:table-cell">Correo</th>
                  <th className="hidden lg:table-cell">Teléfono</th>
                  <th className="text-right">Comisión ref.</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id} className="cursor-pointer transition-all hover:bg-ink-50/80 active:bg-ink-100" onClick={() => { window.location.hash = `#/professionals/${p.id}`; }}>
                    <td className="font-medium truncate max-w-[200px]" title={p.name}>{p.name}</td>
                    <td className="text-ink-700 truncate max-w-[200px]" title={p.company || ''}>{p.company || '—'}</td>
                    <td className="hidden lg:table-cell text-ink-700 truncate max-w-[200px]" title={p.email || ''}>{p.email || '—'}</td>
                    <td className="hidden lg:table-cell text-ink-700 whitespace-nowrap">{p.phone || '—'}</td>
                    <td className="text-right tabular-nums whitespace-nowrap font-semibold text-ink-800">
                      {clampCommissionPct(p.defaultCommissionPct ?? 10)}%
                    </td>
                    <td className="text-right w-24">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setEditing(p); }}
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

      <ProfessionalModal
        professional={editing}
        onClose={() => setEditing(null)}
        profileId={profileId}
      />
    </>
  );
}

// Meta strip — Mail · Phone. Each piece only renders if the underlying
// field has a value; the · separator is drawn between rendered pieces,
// never trailing. Mirrors the helper on the Customers page (sans the
// city row, which professionals don't carry as a column).
function MetaStrip({ p }) {
  const parts = [];
  if (p.email) parts.push({ icon: Mail, value: p.email, key: 'email' });
  if (p.phone) parts.push({ icon: Phone, value: p.phone, key: 'phone' });
  if (parts.length === 0) return null;
  return (
    <div className="text-[11px] text-ink-500 mt-0.5 flex items-center gap-1 min-w-0">
      {parts.map((part, i) => {
        const Icon = part.icon;
        return (
          <span key={part.key} className="inline-flex items-center gap-1 min-w-0">
            {i > 0 && <span aria-hidden="true" className="text-ink-300">·</span>}
            <Icon size={11} className="text-ink-400 flex-shrink-0" />
            <span className="truncate">{part.value}</span>
          </span>
        );
      })}
    </div>
  );
}
