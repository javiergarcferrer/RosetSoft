import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, UserSquare2, ArrowRight, Mail, Phone, ChevronRight } from 'lucide-react';
import { useLiveQueryStatus } from '../db/hooks.js';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ProfessionalModal from '../components/ProfessionalModal.jsx';
import ListLoading from '../components/ListLoading.jsx';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { clampCommissionPct } from '../lib/commissions.js';

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

  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return pros;
    return pros.filter((p) =>
      p.name?.toLowerCase().includes(needle) ||
      p.company?.toLowerCase().includes(needle) ||
      p.email?.toLowerCase().includes(needle)
    );
  }, [pros, q]);

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
                placeholder="Buscar profesionales…"
                className="input pl-9"
              />
            </div>
          </div>

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
                className="card block hover:bg-ink-50"
              >
                <div className="flex items-center gap-3 p-3">
                  <div className="w-10 h-10 rounded-full bg-amber-50 text-amber-700 flex items-center justify-center text-xs font-semibold flex-shrink-0">
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
                    <div className="text-[11px] text-ink-500">Comisión</div>
                    <div className="text-sm font-medium tabular-nums">
                      {clampCommissionPct(p.defaultCommissionPct ?? 10)}%
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-ink-300 flex-shrink-0" />
                </div>
              </Link>
            ))}
            {filtered.length === 0 && (
              <div className="card card-pad text-center text-sm text-ink-500">Sin coincidencias.</div>
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
                  <th className="text-right">Comisión</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id} className="cursor-pointer" onClick={() => { window.location.hash = `#/professionals/${p.id}`; }}>
                    <td className="font-medium truncate max-w-[200px]" title={p.name}>{p.name}</td>
                    <td className="text-ink-700 truncate max-w-[200px]" title={p.company || ''}>{p.company || '—'}</td>
                    <td className="hidden lg:table-cell text-ink-700 truncate max-w-[200px]" title={p.email || ''}>{p.email || '—'}</td>
                    <td className="hidden lg:table-cell text-ink-700 whitespace-nowrap">{p.phone || '—'}</td>
                    <td className="text-right tabular-nums whitespace-nowrap">
                      {clampCommissionPct(p.defaultCommissionPct ?? 10)}%
                    </td>
                    <td className="text-right w-24">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setEditing(p); }}
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
