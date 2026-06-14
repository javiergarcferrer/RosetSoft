import { userMessageFor } from '../lib/errorMessages.js';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus, UserSquare2, ArrowRight, ChevronDown, ExternalLink, FileText, Mail,
  MessageCircle, Phone, SearchX, Trash2, Megaphone,
} from 'lucide-react';
import { useLiveQuery, useLiveQueryStatus } from '../db/hooks.js';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ListLoading from '../components/ListLoading.jsx';
import ListSearchHeader from '../components/search/ListSearchHeader.jsx';
import {
  Cell, CELL_CLS, PanelField, PanelTextArea, SortableTh, ContactGapDot, SheetErrorBanner,
  Monogram, ContactCell,
} from '../components/sheet/cells.jsx';
import { db, newId, assignSequenceNumber } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { useStickyState } from '../context/NavMemory.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { waDigits } from '../lib/phone.js';
import { phoneOwner, phoneInUseMessage } from '../lib/whatsapp.js';
import { resolveProfessionalsList } from '../core/quote/views/lists.js';

const SORT_OPTIONS = [
  { key: 'name', label: 'Nombre A–Z' },
  { key: 'company', label: 'Empresa' },
  { key: 'quotes', label: 'Cotizaciones' },
  { key: 'sales', label: 'Ventas aceptadas' },
  { key: 'activity', label: 'Actividad reciente' },
  { key: 'created', label: 'Fecha de alta' },
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

/**
 * Professionals — an Excel-like sheet over the full search/filter header.
 * Every cell is editable in place (no modal): click and type, blur or Enter
 * commits, Esc reverts, Enter/Shift+Enter walk the column. The header gives
 * saved views (activity + data completeness), secondary filters (empresa /
 * contacto / date ranges) and sort; the desktop column headers sort too.
 * The chevron drops down that professional's quotes + notes, and the bottom
 * row is a permanently-open blank: type a name and the professional exists.
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

  // Search/filter/sort + expanded rows are sticky (useStickyState): leave this
  // page (a contact's WhatsApp quick action, a quote, ⌘K) and Back restores the
  // exact view — same pill, same search, same open rows — instead of resetting.
  const [q, setQ] = useStickyState('q', '');
  const [tab, setTab] = useStickyState('tab', 'all');
  const [filters, setFilters] = useStickyState('filters', {});
  const [sort, setSort] = useStickyState('sort', { key: 'name', dir: 'asc' });
  // Last failed write, surfaced in a banner — a cell reverting silently
  // reads as data loss; this says WHY it didn't stick. Transient, NOT sticky.
  const [writeError, setWriteError] = useState('');
  // Which rows are dropped open. A Set so several professionals can be
  // compared side by side; toggled by the chevron (cells own the click).
  const [expanded, setExpanded] = useStickyState('expanded', () => new Set());

  function toggleExpanded(id) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const { rollupByProfessionalId, rows, tabs, filterDefs } = useMemo(
    () => resolveProfessionalsList({
      professionals: pros, quotes, lines: allLines, customers, q, tab, filters, sort,
    }),
    [pros, quotes, allLines, customers, q, tab, filters, sort],
  );

  // ── Sheet writes ───────────────────────────────────────────────────────────
  // One field per commit, straight to the row. The live query repaints the
  // sheet; the focused cell keeps its own draft so typing never glitches.
  async function commitField(p, field, raw) {
    try {
      if (field === 'name') {
        const name = String(raw).trim();
        if (!name) return false; // a professional can't be nameless — revert
        await db.professionals.update(p.id, { name, updatedAt: Date.now() });
      } else if (field === 'phone') {
        // Keep the WhatsApp-number relation watertight: refuse a number already
        // held by another contact (the inbox links a thread by phone).
        const phone = String(raw).trim();
        if (phone) {
          const owner = await phoneOwner({ phone, excludeId: p.id, profileId });
          if (owner) { setWriteError(phoneInUseMessage(owner)); return false; }
        }
        await db.professionals.update(p.id, { phone, updatedAt: Date.now() });
      } else {
        const value = field === 'notes' ? String(raw) : String(raw).trim();
        await db.professionals.update(p.id, { [field]: value, updatedAt: Date.now() });
      }
      setWriteError('');
      return true;
    } catch (e) {
      setWriteError(`No se pudo guardar el cambio: ${userMessageFor(e)}`);
      return false;
    }
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
      address: '',
      city: String(draft.city || '').trim(),
      notes: '',
      createdAt: now,
      updatedAt: now,
    };
    try {
      await assignSequenceNumber({
        table: 'professionals',
        profileId,
        start: 1,
        build: (number) => ({ ...core, number }),
      });
      setWriteError('');
      return true;
    } catch (e) {
      setWriteError(`No se pudo crear el profesional: ${userMessageFor(e)}`);
      return false;
    }
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

  const noMatches = loaded && pros.length > 0 && rows.length === 0;

  return (
    <>
      <PageHeader
        title="Profesionales"
        subtitle={loaded ? `${pros.length} ${pros.length === 1 ? 'profesional' : 'profesionales'} · edita directamente en la tabla` : ' '}
        actions={
          <div className="flex items-center gap-2">
            {/* Difusión, woven in where the audience lives: lands on the
                campaign wizard already targeting the professionals list. */}
            <Link
              to="/chats/difusion?campana=profesionales"
              className="btn-secondary"
              title="Enviar una plantilla de WhatsApp a profesionales (Difusión)"
            >
              <Megaphone size={14} /> Difusión
            </Link>
            <button onClick={focusNewRow} className="btn-brand">
              <Plus size={14} /> Agregar profesional
            </button>
          </div>
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
              searchPlaceholder="Buscar por nombre, empresa, correo, teléfono o notas…"
              tabs={tabs}
              activeTab={tab}
              onTabChange={setTab}
              filters={filterDefs}
              activeFilters={filters}
              onFiltersChange={setFilters}
              sortOptions={SORT_OPTIONS}
              sort={sort}
              onSortChange={setSort}
              resultCount={rows.length}
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

          <SheetErrorBanner message={writeError} onDismiss={() => setWriteError('')} />

          {/* Mobile sheet-cards — the fields ARE inputs, the chevron drops the
              quotes panel. Same commit semantics as the desktop grid. */}
          <div className="md:hidden space-y-2.5">
            {noMatches && <NoMatchesCard />}
            {rows.map((p) => (
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
                  <SortableTh label="Nombre" sortKey="name" sort={sort} onSort={setSort} />
                  <SortableTh label="Empresa" sortKey="company" sort={sort} onSort={setSort} />
                  <th className="hidden lg:table-cell">Correo</th>
                  <th className="hidden lg:table-cell">Teléfono</th>
                  <th className="hidden xl:table-cell">Ciudad</th>
                  <SortableTh label="Cotizaciones" sortKey="quotes" sort={sort} onSort={setSort} numeric className="text-right" />
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {noMatches && (
                  <tr>
                    <td colSpan={8}>
                      <div className="flex items-center gap-2 py-3 text-sm text-ink-400">
                        <SearchX size={15} className="flex-shrink-0" aria-hidden />
                        Sin resultados — ajusta la búsqueda o los filtros.
                      </div>
                    </td>
                  </tr>
                )}
                {rows.map((p, i) => (
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
                <NewSheetRow row={rows.length} onCreate={createFromDraft} />
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

/** The "nothing survived the filters" hint, card-shaped for the mobile stack. */
function NoMatchesCard() {
  return (
    <div className="card p-3 flex items-center gap-2 text-sm text-ink-400">
      <SearchX size={15} className="flex-shrink-0" aria-hidden />
      Sin resultados — ajusta la búsqueda o los filtros.
    </div>
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
            title={isOpen ? 'Ocultar detalle' : 'Ver cotizaciones y notas'}
            aria-label={isOpen ? 'Ocultar detalle' : 'Ver cotizaciones y notas'}
            aria-expanded={isOpen}
          >
            <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </button>
        </td>
        <td className="font-medium max-w-[220px]">
          <div className="flex items-center gap-1.5">
            <Cell value={p.name} onCommit={(v) => onCommit('name', v)} row={row} col="name" placeholder="Nombre" label={`Nombre de ${p.name}`} />
            <ContactGapDot rollup={rollup} />
          </div>
        </td>
        <td className="max-w-[200px]">
          <Cell value={p.company} onCommit={(v) => onCommit('company', v)} row={row} col="company" placeholder="—" label={`Empresa de ${p.name}`} />
        </td>
        <td className="hidden lg:table-cell min-w-[9rem] max-w-[220px]">
          <Cell value={p.email} onCommit={(v) => onCommit('email', v)} row={row} col="email" type="email" inputMode="email" placeholder="—" label={`Correo de ${p.name}`} />
        </td>
        {/* min-w: phone digits must never clip — name/empresa absorb the
            squeeze instead (they truncate gracefully, numbers don't). */}
        <td className="hidden lg:table-cell min-w-[8rem] max-w-[150px]">
          <Cell value={p.phone} onCommit={(v) => onCommit('phone', v)} row={row} col="phone" type="tel" inputMode="tel" placeholder="—" label={`Teléfono de ${p.name}`} />
        </td>
        <td className="hidden xl:table-cell max-w-[140px]">
          <Cell value={p.city} onCommit={(v) => onCommit('city', v)} row={row} col="city" placeholder="—" label={`Ciudad de ${p.name}`} />
        </td>
        <td className="text-right tabular-nums whitespace-nowrap text-ink-800">
          {rollup?.count || 0}
          {rollup?.acceptedTotal > 0 && (
            <span className="text-[11px] text-emerald-700 ml-1.5">
              {formatMoney(rollup.acceptedTotal, 'USD', { USD: 1 })}
            </span>
          )}
        </td>
        <td className="!pl-0 text-right">
          <span className="inline-flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity">
            <Link
              to={`/professionals/${p.id}`}
              className="p-1.5 rounded text-ink-300 hover:text-brand-600 hover:bg-brand-50 transition-colors"
              title="Ver perfil y comisiones"
              aria-label="Ver perfil y comisiones"
            >
              <ArrowRight size={13} />
            </Link>
            <button
              type="button"
              onClick={onRemove}
              className="p-1.5 rounded text-ink-300 hover:text-red-600 hover:bg-red-50 transition-colors"
              title="Eliminar profesional"
              aria-label="Eliminar profesional"
            >
              <Trash2 size={13} />
            </button>
          </span>
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={8} className="!p-0 bg-ink-50/50">
            <ProQuotesPanel pro={p} rollup={rollup} onCommit={onCommit} />
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
  const [draft, setDraft] = useState({ name: '', company: '', email: '', phone: '', city: '' });
  const creating = useRef(false);

  async function maybeCreate(patch) {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (!String(next.name).trim() || creating.current) return true;
    creating.current = true;
    try {
      const ok = await onCreate(next);
      if (ok) setDraft({ name: '', company: '', email: '', phone: '', city: '' });
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
      col={field}
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
      <td className="hidden lg:table-cell min-w-[9rem] max-w-[220px]">{cell('email', { placeholder: 'Correo', type: 'email', inputMode: 'email' })}</td>
      <td className="hidden lg:table-cell min-w-[8rem] max-w-[150px]">{cell('phone', { placeholder: 'Teléfono', type: 'tel', inputMode: 'tel' })}</td>
      <td className="hidden xl:table-cell max-w-[140px]">{cell('city', { placeholder: 'Ciudad' })}</td>
      <td className="text-right text-[11px] text-ink-300">—</td>
      <td></td>
    </tr>
  );
}

/**
 * Mobile professional card — an editorial, monogram-led record. The identity
 * block (monogram + name + empresa) and an at-a-glance metric (quote count, won
 * total) sit above a hairline; the contact channels read as a labelled list
 * below, with a full-height chevron rail dropping the quotes + datos panel.
 * Every text field is the SAME in-place Cell as the desktop sheet, so editing
 * semantics never diverge between the two surfaces.
 */
function MobileRow({ p, rollup, isOpen, onToggle, onCommit, onRemove }) {
  const count = rollup?.count || 0;
  const acceptedTotal = rollup?.acceptedTotal || 0;
  return (
    <div className="card overflow-hidden">
      <div className="flex items-start gap-3 p-3.5 pb-3">
        <Monogram name={p.name} rollup={rollup} />
        <div className="min-w-0 flex-1 pt-0.5">
          <Cell value={p.name} onCommit={(v) => onCommit('name', v)} col="name" placeholder="Nombre" label={`Nombre de ${p.name}`} align="font-medium" />
          <Cell value={p.company} onCommit={(v) => onCommit('company', v)} col="company" placeholder="Empresa" label={`Empresa de ${p.name}`} align="!text-ink-500" />
        </div>
        {/* At-a-glance metric — pipeline volume, and won money when there is any. */}
        <div className="flex shrink-0 flex-col items-end text-right">
          <span className={`font-display text-lg font-semibold leading-none tabular-nums ${count ? 'text-ink-900' : 'text-ink-300'}`}>
            {count}
          </span>
          <span className={`eyebrow-xs mt-1 ${count ? 'text-ink-400' : 'text-ink-300'}`}>cotiz.</span>
          {acceptedTotal > 0 && (
            <span className="mt-1.5 text-[11px] font-semibold tabular-nums text-emerald-700">
              {formatMoney(acceptedTotal, 'USD', { USD: 1 })}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-stretch border-t border-ink-100">
        <div className="min-w-0 flex-1 divide-y divide-ink-100/70 px-3.5">
          <ContactCell icon={Phone} value={p.phone} onCommit={(v) => onCommit('phone', v)} col="phone" type="tel" inputMode="tel" placeholder="Teléfono" label={`Teléfono de ${p.name}`} />
          <ContactCell icon={Mail} value={p.email} onCommit={(v) => onCommit('email', v)} col="email" type="email" inputMode="email" placeholder="Correo" label={`Correo de ${p.name}`} />
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="flex shrink-0 items-center border-l border-ink-100 px-4 text-ink-300 transition-colors hover:bg-brand-50/60 hover:text-brand-600"
          aria-expanded={isOpen}
          aria-label="Ver cotizaciones y notas"
        >
          <ChevronDown size={18} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {isOpen && (
        <div className="border-t border-ink-100">
          <ProQuotesPanel pro={p} rollup={rollup} onCommit={onCommit} onRemove={onRemove} />
        </div>
      )}
    </div>
  );
}

/** Mobile: the blank "type a name" card — the new-row, in the card family
 *  (a dashed monogram-shaped plate so it reads as the next record to fill). */
function MobileNewCard({ onCreate }) {
  const [name, setName] = useState('');
  async function commit() {
    if (!name.trim()) return;
    const ok = await onCreate({ name });
    if (ok) setName('');
  }
  return (
    <div className="card flex items-center gap-3 bg-brand-50/30 p-3.5">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-dashed border-brand-300 text-brand-400">
        <Plus size={18} />
      </span>
      <input
        data-newrow-name
        className={`${CELL_CLS} font-medium`}
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

/**
 * Contact quick action — contacting the referrer IS the job. `to` renders an
 * in-app Link (WhatsApp goes to OUR inbox, /chats?chat=<phone>, never out to
 * wa.me — the business chats from the Cloud API number, logged in the CRM);
 * `href` covers the native tel:/mailto: handoffs that have no in-app pane.
 */
function QuickAction({ href, to, icon: Icon, label }) {
  const cls = 'inline-flex items-center gap-1.5 rounded-full border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-600 transition-colors hover:border-brand-300 hover:text-brand-700 hover:bg-brand-50 active:scale-[0.98]';
  if (to) {
    return (
      <Link to={to} className={cls}>
        <Icon size={13} aria-hidden /> {label}
      </Link>
    );
  }
  return (
    <a href={href} className={cls}>
      <Icon size={13} aria-hidden /> {label}
    </a>
  );
}

// The dropdown body in three clearly divided sections: (1) contact actions
// + the perfil link, (2) the professional's quotes grouped by status (each
// group under its status pill with the quote rows reading #number ·
// customer · last-touched · total), (3) the record's in-place dirección +
// notes fields. One compact figure per fact: the totals live in the section
// header, never repeated in a band. Shared by the mobile card and the
// desktop sheet row so both surfaces stay identical.
function ProQuotesPanel({ pro, rollup, onCommit, onRemove }) {
  const groups = rollup?.groups || [];
  const wa = waDigits(pro.phone);
  return (
    <div className="divide-y divide-ink-100">
      {/* Contact bar — the channels this professional has, perfil right. */}
      <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5">
        {wa && <QuickAction to={`/chats?chat=${wa}`} icon={MessageCircle} label="WhatsApp" />}
        {pro.phone && <QuickAction href={`tel:${pro.phone}`} icon={Phone} label="Llamar" />}
        {pro.email && <QuickAction href={`mailto:${pro.email}`} icon={Mail} label="Correo" />}
        <span className="flex-1" />
        <Link
          to={`/professionals/${pro.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 transition-colors hover:text-brand-700"
        >
          Ver perfil y comisiones <ArrowRight size={12} aria-hidden />
        </Link>
      </div>

      <section className="px-4 py-3 space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="font-display text-[11px] font-semibold uppercase tracking-wide text-ink-500">Cotizaciones</h4>
          {rollup?.count > 0 && (
            <span className="flex flex-wrap justify-end gap-x-3 text-[11px] tabular-nums text-ink-500">
              <span>Total <span className="font-semibold text-ink-700">{formatMoney(rollup.allTimeTotal, 'USD', { USD: 1 })}</span></span>
              {rollup.acceptedTotal > 0 && (
                <span className="text-emerald-700">Aceptado <span className="font-semibold">{formatMoney(rollup.acceptedTotal, 'USD', { USD: 1 })}</span></span>
              )}
            </span>
          )}
        </div>
        {groups.length === 0 ? (
          <div className="flex items-center gap-2 py-1 text-xs text-ink-400">
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
              <ul className="divide-y divide-ink-100 rounded-lg bg-surface ring-1 ring-inset ring-ink-100 overflow-hidden">
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
      </section>

      {/* Dirección is a real field (the seed's DIRECCIÓN column now lives
          here, not in notes); notes is for remarks only. */}
      <section className="px-4 py-3 space-y-2.5">
        <h4 className="font-display text-[11px] font-semibold uppercase tracking-wide text-ink-500">Datos del profesional</h4>
        <div className="grid grid-cols-2 gap-2">
          <PanelField label="Dirección" value={pro.address} onCommit={(v) => onCommit('address', v)} className="col-span-2" />
          <PanelField label="Ciudad" value={pro.city} onCommit={(v) => onCommit('city', v)} className="col-span-2 sm:col-span-1" />
        </div>
        <PanelTextArea
          label="Notas"
          value={pro.notes}
          onCommit={(v) => onCommit('notes', v)}
          placeholder="Notas internas — preferencias, acuerdos, contexto…"
          name={pro.name}
        />
        {onRemove && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onRemove}
              className="inline-flex items-center gap-1 text-xs font-medium text-red-500 hover:text-red-700 transition-colors"
            >
              <Trash2 size={12} aria-hidden /> Eliminar
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
