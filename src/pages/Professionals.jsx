import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, Trash2, UserSquare2, ArrowRight } from 'lucide-react';
import { useLiveQueryStatus } from '../db/hooks.js';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Modal from '../components/Modal.jsx';
import ListLoading from '../components/ListLoading.jsx';
import { db, newId, nextSequenceNumber } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { clampCommissionPct } from '../lib/commissions.js';

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

          {/* Mobile cards — the whole card links into the detail; the
              edit modal opens via the small inline button so the
              default tap target is the detail view (where the dealer
              actually wants to land most of the time). */}
          <div className="md:hidden space-y-2">
            {filtered.map((p) => (
              <Link
                key={p.id}
                to={`/professionals/${p.id}`}
                className="card block p-3 hover:bg-ink-50"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-sm">{p.name}</div>
                    {p.company && <div className="text-xs text-ink-500">{p.company}</div>}
                    <div className="text-xs text-ink-700 mt-1 space-y-0.5">
                      {p.email && <div className="truncate">{p.email}</div>}
                      {p.phone && <div>{p.phone}</div>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[11px] text-ink-500">Comisión</div>
                    <div className="text-sm font-medium tabular-nums">
                      {clampCommissionPct(p.defaultCommissionPct ?? 10)}%
                    </div>
                  </div>
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

function ProfessionalModal({ professional, onClose, profileId }) {
  const open = !!professional;
  const isNew = !professional?.id;
  const [data, setData] = useState(null);

  if (open && data?.__id !== (professional?.id || 'new')) {
    setData({
      __id: professional?.id || 'new',
      name: professional?.name || '',
      company: professional?.company || '',
      email: professional?.email || '',
      phone: professional?.phone || '',
      notes: professional?.notes || '',
      // 10% is the dealer's anecdotal "typical" cut; we surface it as
      // the suggested default rather than 0 so saving without thinking
      // does the right thing for most cases.
      defaultCommissionPct: professional?.defaultCommissionPct ?? 10,
    });
  }
  if (!open || !data) return <Modal open={false} onClose={onClose} title="" />;

  function set(k, v) { setData((d) => ({ ...d, [k]: v })); }

  async function save() {
    if (!data.name.trim()) return;
    const id = professional?.id || newId();
    const now = Date.now();

    // Sequential number — same numbering rule as customers/quotes:
    // max(number) + 1, or 1 if empty. Start from 1 here (no need for
    // the 1001 vanity prefix; professionals are an internal list).
    const number = isNew
      ? await nextSequenceNumber('professionals', profileId, 1)
      : professional.number;

    await db.professionals.put({
      id,
      profileId,
      number,
      name: data.name.trim(),
      company: data.company.trim(),
      email: data.email.trim(),
      phone: data.phone.trim(),
      notes: data.notes,
      defaultCommissionPct: clampCommissionPct(data.defaultCommissionPct),
      createdAt: professional?.createdAt || now,
      updatedAt: now,
    });
    onClose();
  }

  async function remove() {
    if (!confirm(`¿Eliminar a "${data.name}"? Las cotizaciones asignadas conservan el % pero pierden la referencia al profesional.`)) return;
    await db.professionals.delete(professional.id);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isNew ? 'Agregar profesional' : `Editar — ${data.name || 'Profesional'}`}
      footer={
        <>
          {!isNew && (
            <button onClick={remove} className="btn-ghost text-red-600 hover:bg-red-50">
              <Trash2 size={14} /> Eliminar
            </button>
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="btn-ghost">Cancelar</button>
          <button onClick={save} className="btn-primary">Guardar</button>
        </>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <div className="label">Nombre *</div>
          <input
            className="input"
            value={data.name}
            onChange={(e) => set('name', e.target.value)}
            autoComplete="name"
            autoCapitalize="words"
          />
        </div>
        <div>
          <div className="label">Empresa / estudio</div>
          <input
            className="input"
            value={data.company}
            onChange={(e) => set('company', e.target.value)}
            autoComplete="organization"
            autoCapitalize="words"
          />
        </div>
        <div>
          <div className="label">Comisión por defecto</div>
          <div className="relative">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              max="20"
              step="0.5"
              className="input pr-8 tabular-nums"
              value={data.defaultCommissionPct}
              onChange={(e) => set('defaultCommissionPct', e.target.value)}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-500">%</span>
          </div>
          <p className="text-[11px] text-ink-500 mt-1">
            Se aplica automáticamente al asignar este profesional a una cotización.
            Rango 0–20%. Cada venta puede sobreescribir este valor.
          </p>
        </div>
        <div>
          <div className="label">Correo</div>
          <input
            className="input"
            type="email"
            value={data.email}
            onChange={(e) => set('email', e.target.value)}
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
          />
        </div>
        <div>
          <div className="label">Teléfono</div>
          <input
            className="input"
            type="tel"
            value={data.phone}
            onChange={(e) => set('phone', e.target.value)}
            inputMode="tel"
            autoComplete="tel"
          />
        </div>
        <div className="sm:col-span-2">
          <div className="label">Notas</div>
          <textarea
            className="input min-h-[80px]"
            value={data.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}
