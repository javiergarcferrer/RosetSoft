import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus, UserSquare2, ArrowRight, ChevronDown, ExternalLink, FileText, Trash2,
} from 'lucide-react';
import { useLiveQuery, useLiveQueryStatus } from '../db/hooks.js';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ListLoading from '../components/ListLoading.jsx';
import ListSearchHeader from '../components/search/ListSearchHeader.jsx';
import { db, newId, assignSequenceNumber } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { clampCommissionPct } from '../lib/commissions.js';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { resolveProfessionalsList } from '../core/quote/views/lists.js';

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
  { key: 'quotes', label: 'Cotizaciones' },
  { key: 'commission', label: 'Comisión %' },
  { key: 'company', label: 'Empresa' },
];

// Section labels for the per-row quote dropdown — plural, mirroring
// ProfessionalDetail's sections so the two surfaces read the same way.
const STATUS_LABELS = {
  draft: 'Borradores',
  sent: 'Enviadas',
  accepted: 'Aceptadas',
  declined: 'Rechazadas',
  archived: 'Archivadas',
};

// Borderless input that reads exactly like the cell text until focused —
// the "viewing IS editing" core of the sheet.
const CELL_CLS = 'w-full bg-transparent text-sm text-ink-900 placeholder:text-ink-300 '
  + 'px-1 py-0.5 -mx-1 rounded-md border-0 focus:outline-none focus:bg-white '
  + 'focus:ring-2 focus:ring-brand-400/70 focus:shadow-sm transition-shadow';

/** Move focus to the same column on another row (Enter / Shift+Enter). */
function focusCell(row, col) {
  const el = document.querySelector(`[data-cell="${row}:${col}"]`);
  if (el) { el.focus(); el.select?.(); }
}

/**
 * One spreadsheet cell. Holds its own draft while focused (so a live-query
 * repaint can't clobber typing), commits on blur when the value actually
 * changed, reverts on Escape, and hops rows on Enter. `onCommit` may return
 * false to reject the edit (e.g. blank name) — the draft snaps back.
 */
function Cell({ value, onCommit, row, col, type = 'text', inputMode, placeholder, align = '', label }) {
  const [draft, setDraft] = useState(value ?? '');
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(value ?? ''); }, [value, focused]);

  async function commit() {
    setFocused(false);
    if (String(draft) === String(value ?? '')) return;
    const ok = await onCommit(draft);
    if (ok === false) setDraft(value ?? '');
  }

  return (
    <input
      data-cell={row != null ? `${row}:${col}` : undefined}
      type={type}
      inputMode={inputMode}
      className={`${CELL_CLS} ${align}`}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      onFocus={(e) => { setFocused(true); e.target.select(); }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const next = row + (e.shiftKey ? -1 : 1);
          e.currentTarget.blur();
          if (row != null) focusCell(next, col);
        } else if (e.key === 'Escape') {
          const el = e.currentTarget;
          setDraft(value ?? '');
          requestAnimationFrame(() => el.blur());
        }
      }}
    />
  );
}

/**
 * Professionals — an Excel-like sheet. Every cell is editable in place
 * (no modal): click and type, blur or Enter commits, Esc reverts,
 * Enter/Shift+Enter walk the column. The chevron drops down that
 * professional's quotes grouped by status, and the bottom row is a
 * permanently-open blank: type a name and the professional exists.
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

  // The rows behind the per-professional dropdown: every team quote (the
  // VM buckets them by professionalId), their lines (needed for each
  // quote's grand total) and the customers that label each quote row.
  const quotes = useLiveQuery(
    () => db.quotes.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );
  const allLines = useLiveQuery(() => db.quoteLines.toArray(), [], []);
  const customers = useLiveQuery(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );

  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({}); // { commission: '1-5' | … }
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  // Which rows are dropped open. A Set so several professionals can be
  // compared side by side; toggled by the chevron (cells own the click).
  const [expanded, setExpanded] = useState(() => new Set());

  function toggleExpanded(id) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const { rollupByProfessionalId } = useMemo(
    () => resolveProfessionalsList({ professionals: pros, quotes, lines: allLines, customers }),
    [pros, quotes, allLines, customers],
  );

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

    const mul = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sort.key === 'commission') {
        return (commissionOf(a) - commissionOf(b)) * mul;
      }
      if (sort.key === 'quotes') {
        const ac = rollupByProfessionalId.get(a.id)?.count || 0;
        const bc = rollupByProfessionalId.get(b.id)?.count || 0;
        return (ac - bc) * mul;
      }
      if (sort.key === 'company') {
        return (a.company || '').toLowerCase().localeCompare((b.company || '').toLowerCase()) * mul;
      }
      return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()) * mul;
    });
  }, [pros, q, filters, sort, rollupByProfessionalId]);

  // ── Sheet writes ───────────────────────────────────────────────────────────
  // One field per commit, straight to the row. The live query repaints the
  // sheet; the focused cell keeps its own draft so typing never glitches.
  async function commitField(p, field, raw) {
    if (field === 'name') {
      const name = String(raw).trim();
      if (!name) return false; // a professional can't be nameless — revert
      await db.professionals.update(p.id, { name, updatedAt: Date.now() });
      return true;
    }
    if (field === 'defaultCommissionPct') {
      await db.professionals.update(p.id, {
        defaultCommissionPct: clampCommissionPct(raw),
        updatedAt: Date.now(),
      });
      return true;
    }
    await db.professionals.update(p.id, { [field]: String(raw).trim(), updatedAt: Date.now() });
    return true;
  }

  async function removePro(p) {
    if (!confirm(`¿Eliminar a "${p.name}"? Las cotizaciones asignadas conservan el % pero pierden la referencia al profesional.`)) return;
    await db.professionals.delete(p.id);
  }

  // The blank bottom row: drafts live here until the name lands, then the
  // professional is created with whatever else was already typed (same
  // race-safe numbering the modal used).
  async function createFromDraft(draft) {
    const name = String(draft.name || '').trim();
    if (!name) return false;
    const now = Date.now();
    const core = {
      id: newId(),
      profileId,
      name,
      company: String(draft.company || '').trim(),
      email: String(draft.email || '').trim(),
      phone: String(draft.phone || '').trim(),
      notes: '',
      defaultCommissionPct: clampCommissionPct(draft.pct === '' || draft.pct == null ? 10 : draft.pct),
      createdAt: now,
      updatedAt: now,
    };
    await assignSequenceNumber({
      table: 'professionals',
      profileId,
      start: 1,
      build: (number) => ({ ...core, number }),
    });
    return true;
  }

  function focusNewRow() {
    // Two new-row name inputs exist (desktop sheet / mobile card); focus the
    // one that's actually laid out.
    const els = document.querySelectorAll('[data-newrow-name]');
    for (const el of els) {
      if (el.offsetParent !== null) {
        el.scrollIntoView({ block: 'center' });
        el.focus();
        return;
      }
    }
  }

  return (
    <>
      <PageHeader
        title="Profesionales"
        subtitle={loaded ? `${pros.length} ${pros.length === 1 ? 'profesional' : 'profesionales'} · edita directamente en la tabla` : ' '}
        actions={
          <button onClick={focusNewRow} className="btn-brand">
            <Plus size={14} /> Agregar profesional
          </button>
        }
      />

      {!loaded ? (
        <div className="card overflow-hidden"><ListLoading rows={5} /></div>
      ) : (
        <>
          {pros.length > 0 && (
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
          )}
          {pros.length === 0 && (
            <div className="mb-3">
              <EmptyState
                icon={UserSquare2}
                title="Sin profesionales"
                description="Arquitectos, decoradores u otros profesionales que te traen ventas. Escribe el primer nombre en la fila vacía de abajo — sin formularios."
              />
            </div>
          )}

          {/* Mobile sheet-cards — the fields ARE inputs, the chevron drops the
              quotes panel. Same commit semantics as the desktop grid. */}
          <div className="md:hidden space-y-2">
            {filtered.map((p) => (
              <MobileRow
                key={p.id}
                p={p}
                rollup={rollupByProfessionalId.get(p.id)}
                isOpen={expanded.has(p.id)}
                onToggle={() => toggleExpanded(p.id)}
                onCommit={(field, v) => commitField(p, field, v)}
                onRemove={() => removePro(p)}
              />
            ))}
            <MobileNewCard onCreate={createFromDraft} />
          </div>

          {/* Desktop sheet */}
          <div className="hidden md:block card overflow-hidden">
            <table className="table">
              <thead>
                <tr>
                  <th className="w-8"></th>
                  <th>Nombre</th>
                  <th>Empresa</th>
                  <th className="hidden lg:table-cell">Correo</th>
                  <th className="hidden lg:table-cell">Teléfono</th>
                  <th className="text-right">Cotizaciones</th>
                  <th className="text-right">Comisión ref.</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p, i) => (
                  <SheetRow
                    key={p.id}
                    p={p}
                    row={i}
                    rollup={rollupByProfessionalId.get(p.id)}
                    isOpen={expanded.has(p.id)}
                    onToggle={() => toggleExpanded(p.id)}
                    onCommit={(field, v) => commitField(p, field, v)}
                    onRemove={() => removePro(p)}
                  />
                ))}
                <NewSheetRow row={filtered.length} onCreate={createFromDraft} />
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

/** One professional as a sheet row + (when open) its quotes dropdown row. */
function SheetRow({ p, row, rollup, isOpen, onToggle, onCommit, onRemove }) {
  return (
    <>
      <tr className="group/row hover:bg-ink-50/40 transition-colors">
        <td className="!pr-0">
          <button
            type="button"
            onClick={onToggle}
            className="p-1 rounded text-ink-300 hover:text-brand-600 hover:bg-brand-50 transition-colors"
            title={isOpen ? 'Ocultar cotizaciones' : 'Ver cotizaciones'}
            aria-expanded={isOpen}
          >
            <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </button>
        </td>
        <td className="font-medium max-w-[220px]">
          <Cell value={p.name} onCommit={(v) => onCommit('name', v)} row={row} col="name" placeholder="Nombre" label={`Nombre de ${p.name}`} />
        </td>
        <td className="max-w-[200px]">
          <Cell value={p.company} onCommit={(v) => onCommit('company', v)} row={row} col="company" placeholder="—" label={`Empresa de ${p.name}`} />
        </td>
        <td className="hidden lg:table-cell max-w-[220px]">
          <Cell value={p.email} onCommit={(v) => onCommit('email', v)} row={row} col="email" type="email" inputMode="email" placeholder="—" label={`Correo de ${p.name}`} />
        </td>
        <td className="hidden lg:table-cell max-w-[150px]">
          <Cell value={p.phone} onCommit={(v) => onCommit('phone', v)} row={row} col="phone" type="tel" inputMode="tel" placeholder="—" label={`Teléfono de ${p.name}`} />
        </td>
        <td className="text-right tabular-nums whitespace-nowrap text-ink-800">
          {rollup?.count || 0}
          {rollup?.acceptedTotal > 0 && (
            <span className="text-[11px] text-emerald-700 ml-1.5">
              {formatMoney(rollup.acceptedTotal, 'USD', { USD: 1 })}
            </span>
          )}
        </td>
        <td className="text-right">
          <span className="inline-flex items-center justify-end gap-0.5 font-semibold text-ink-800">
            <Cell
              value={commissionOf(p)}
              onCommit={(v) => onCommit('defaultCommissionPct', v)}
              row={row} col="pct"
              type="number" inputMode="decimal"
              align="text-right w-12 tabular-nums"
              label={`Comisión de ${p.name}`}
            />
            <span className="text-xs text-ink-400">%</span>
          </span>
        </td>
        <td className="!pl-0 text-right">
          <span className="inline-flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity">
            <Link
              to={`/professionals/${p.id}`}
              className="p-1.5 rounded text-ink-300 hover:text-brand-600 hover:bg-brand-50 transition-colors"
              title="Ver perfil y comisiones"
            >
              <ArrowRight size={13} />
            </Link>
            <button
              type="button"
              onClick={onRemove}
              className="p-1.5 rounded text-ink-300 hover:text-red-600 hover:bg-red-50 transition-colors"
              title="Eliminar profesional"
            >
              <Trash2 size={13} />
            </button>
          </span>
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={8} className="!p-0 bg-ink-50/50">
            <ProQuotesPanel pro={p} rollup={rollup} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The permanently-open blank row at the bottom of the sheet. Drafts are
 * local; committing a non-empty NAME creates the professional with whatever
 * else was typed, then the row resets for the next one.
 */
function NewSheetRow({ row, onCreate }) {
  const [draft, setDraft] = useState({ name: '', company: '', email: '', phone: '', pct: '' });
  const creating = useRef(false);

  async function maybeCreate(patch) {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (!String(next.name).trim() || creating.current) return true;
    creating.current = true;
    try {
      const ok = await onCreate(next);
      if (ok) setDraft({ name: '', company: '', email: '', phone: '', pct: '' });
      return ok;
    } finally {
      creating.current = false;
    }
  }

  const cell = (field, props = {}) => (
    <Cell
      value={draft[field]}
      onCommit={(v) => maybeCreate({ [field]: v })}
      row={row}
      col={field === 'defaultCommissionPct' ? 'pct' : field}
      {...props}
    />
  );

  return (
    <tr className="bg-brand-50/30">
      <td className="!pr-0 text-ink-300"><Plus size={14} className="ml-1" /></td>
      <td className="max-w-[220px]">
        <input
          data-newrow-name
          data-cell={`${row}:name`}
          className={CELL_CLS}
          value={draft.name}
          placeholder="Nuevo profesional…"
          aria-label="Nombre del nuevo profesional"
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          onBlur={() => maybeCreate({})}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
        />
      </td>
      <td className="max-w-[200px]">{cell('company', { placeholder: 'Empresa' })}</td>
      <td className="hidden lg:table-cell max-w-[220px]">{cell('email', { placeholder: 'Correo', type: 'email', inputMode: 'email' })}</td>
      <td className="hidden lg:table-cell max-w-[150px]">{cell('phone', { placeholder: 'Teléfono', type: 'tel', inputMode: 'tel' })}</td>
      <td className="text-right text-[11px] text-ink-300">—</td>
      <td className="text-right">
        <span className="inline-flex items-center justify-end gap-0.5">
          {cell('pct', { placeholder: '10', type: 'number', inputMode: 'decimal', align: 'text-right w-12 tabular-nums' })}
          <span className="text-xs text-ink-400">%</span>
        </span>
      </td>
      <td></td>
    </tr>
  );
}

/** Mobile: a card whose fields are the same in-place cells, stacked. */
function MobileRow({ p, rollup, isOpen, onToggle, onCommit, onRemove }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 p-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <Cell value={p.name} onCommit={(v) => onCommit('name', v)} col="name" placeholder="Nombre" label={`Nombre de ${p.name}`} />
          <div className="grid grid-cols-2 gap-x-2">
            <Cell value={p.company} onCommit={(v) => onCommit('company', v)} col="company" placeholder="Empresa" label={`Empresa de ${p.name}`} align="text-[12px] text-ink-500" />
            <Cell value={p.phone} onCommit={(v) => onCommit('phone', v)} col="phone" type="tel" inputMode="tel" placeholder="Teléfono" label={`Teléfono de ${p.name}`} align="text-[12px] text-ink-500" />
          </div>
          <Cell value={p.email} onCommit={(v) => onCommit('email', v)} col="email" type="email" inputMode="email" placeholder="Correo" label={`Correo de ${p.name}`} align="text-[12px] text-ink-500" />
        </div>
        <div className="text-right shrink-0">
          <span className="inline-flex items-center gap-0.5 text-sm font-semibold tabular-nums text-ink-800">
            <Cell
              value={commissionOf(p)}
              onCommit={(v) => onCommit('defaultCommissionPct', v)}
              col="pct" type="number" inputMode="decimal"
              align="text-right w-10 tabular-nums"
              label={`Comisión de ${p.name}`}
            />
            <span className="text-xs text-ink-400">%</span>
          </span>
          <div className="eyebrow-xs text-ink-400 mt-0.5">{rollup?.count || 0} cotiz.</div>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="p-2 -mr-1 rounded text-ink-300 hover:text-brand-600 transition-colors shrink-0"
          aria-expanded={isOpen}
          aria-label="Ver cotizaciones"
        >
          <ChevronDown size={16} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {isOpen && (
        <div className="border-t border-ink-100">
          <ProQuotesPanel pro={p} rollup={rollup} onRemove={onRemove} />
        </div>
      )}
    </div>
  );
}

/** Mobile: the blank "type a name" card — the new-row, stacked. */
function MobileNewCard({ onCreate }) {
  const [name, setName] = useState('');
  async function commit() {
    if (!name.trim()) return;
    const ok = await onCreate({ name });
    if (ok) setName('');
  }
  return (
    <div className="card bg-brand-50/30 p-3 flex items-center gap-2">
      <Plus size={15} className="text-ink-300 shrink-0" />
      <input
        data-newrow-name
        className={CELL_CLS}
        value={name}
        placeholder="Nuevo profesional…"
        aria-label="Nombre del nuevo profesional"
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
      />
    </div>
  );
}

// The dropdown body — the professional's quotes grouped by status, each
// group under its status pill with the quote rows reading #number ·
// customer · last-touched · total. Shared by the mobile card and the
// desktop sheet row so both surfaces stay identical.
function ProQuotesPanel({ pro, rollup, onRemove }) {
  const groups = rollup?.groups || [];
  return (
    <div className="px-4 py-3 space-y-3">
      {groups.length === 0 ? (
        <div className="flex items-center gap-2 py-2 text-xs text-ink-400">
          <FileText size={13} className="flex-shrink-0" />
          Sin cotizaciones asignadas.
        </div>
      ) : (
        groups.map(({ status, entries }) => (
          <div key={status}>
            <div className="flex items-center gap-2 mb-1">
              <span className={`status-pill status-pill-${status}`}>
                {STATUS_LABELS[status] || status}
              </span>
              <span className="eyebrow-xs text-ink-400 tabular-nums">
                {entries.length} {entries.length === 1 ? 'cotización' : 'cotizaciones'}
              </span>
            </div>
            <ul className="divide-y divide-ink-100 rounded-lg bg-white ring-1 ring-inset ring-ink-100 overflow-hidden">
              {entries.map((e) => (
                <li key={e.quote.id}>
                  <Link
                    to={`/quotes/${e.quote.id}`}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-brand-50/60 transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate text-ink-900 group-hover:text-brand-700 transition-colors">
                        #{e.quote.number || '—'}
                        {e.customer ? (
                          <span className="text-ink-500 font-normal"> · {e.customer.company || e.customer.name}</span>
                        ) : null}
                      </div>
                      <div className="text-[11px] text-ink-500 mt-0.5">
                        Act. {formatDateTime(e.quote.updatedAt)}
                      </div>
                    </div>
                    <div className="text-sm font-semibold tabular-nums whitespace-nowrap text-ink-900">
                      {formatMoney(e.total, e.quote.currencyCode || 'USD', e.quote.rates || { USD: 1 })}
                    </div>
                    <ExternalLink size={13} className="text-ink-300 group-hover:text-brand-600 flex-shrink-0 transition-colors" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      <div className="flex items-center justify-between gap-2">
        <Link
          to={`/professionals/${pro.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 transition-colors"
        >
          Ver perfil y comisiones <ArrowRight size={12} aria-hidden />
        </Link>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex items-center gap-1 text-xs font-medium text-red-500 hover:text-red-700 transition-colors"
          >
            <Trash2 size={12} aria-hidden /> Eliminar
          </button>
        )}
      </div>
    </div>
  );
}
