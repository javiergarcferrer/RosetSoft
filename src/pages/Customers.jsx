import { userMessageFor } from '../lib/errorMessages.js';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus, Users, ArrowRight, ChevronDown, ExternalLink, FileText, Mail, MessageCircle,
  Phone, SearchX, Trash2,
} from 'lucide-react';
import { useLiveQuery, useLiveQueryStatus } from '../db/hooks.js';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import CustomerModal from '../components/CustomerModal.jsx';
import ListLoading from '../components/ListLoading.jsx';
import ListSearchHeader from '../components/search/ListSearchHeader.jsx';
import {
  Cell, PanelField, PanelTextArea, SortableTh, ContactGapDot, SheetErrorBanner,
} from '../components/sheet/cells.jsx';
import { db } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { waDigits } from '../lib/phone.js';
import { resolveCustomersList } from '../core/quote/views/lists.js';

const SORT_OPTIONS = [
  { key: 'name', label: 'Nombre A–Z' },
  { key: 'company', label: 'Empresa' },
  { key: 'activity', label: 'Actividad reciente' },
  { key: 'pipeline', label: 'Pipeline abierto' },
  { key: 'lifetime', label: 'Compras' },
  { key: 'created', label: 'Fecha de alta' },
];

// Section labels for the per-row quote dropdown — plural, mirroring
// CustomerDetail's sections so the two surfaces read the same way.
const STATUS_LABELS = {
  draft: 'Borradores',
  sent: 'Enviadas',
  accepted: 'Aceptadas',
  declined: 'Rechazadas',
  archived: 'Archivadas',
};

/**
 * Clientes — the seller's working directory, same inline-editable sheet as
 * Profesionales: the common columns ARE inputs (click and type, blur/Enter
 * commits, Esc reverts), and the chevron drops the full record — quick
 * contact actions, the quote pipeline, and EVERY remaining field (RNC,
 * contacto, dirección, provincia, CP, país, notas) editable in place. The
 * header gives the seller's saved views (pipeline / compras / sin actividad
 * / datos incompletos), instant-apply filter pills and sort. Creation stays
 * on the modal — it carries the DGII RNC lookup that pre-fills the fiscal
 * name, which a blank sheet row can't offer.
 */
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

  // The rows behind the per-client dropdown and the pipeline/compras
  // figures: every team quote (the VM buckets them by customerId) and
  // their lines (needed for each quote's grand total).
  const quotes = useLiveQuery(
    () => db.quotes.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );
  const allLines = useLiveQuery(() => db.quoteLines.toArray(), [], []);

  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [creating, setCreating] = useState(null);
  // Last failed write, surfaced in a banner — a cell reverting silently
  // reads as data loss; this says WHY it didn't stick.
  const [writeError, setWriteError] = useState('');
  // Which rows are dropped open. A Set so several clients can be compared
  // side by side; toggled by the chevron (cells own the click).
  const [expanded, setExpanded] = useState(() => new Set());

  function toggleExpanded(id) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const { rollupByCustomerId, rows, tabs, filterDefs } = useMemo(
    () => resolveCustomersList({ customers, quotes, lines: allLines, q, tab, filters, sort }),
    [customers, quotes, allLines, q, tab, filters, sort],
  );

  // One field per commit, straight to the row — same sheet semantics as
  // Profesionales. No updatedAt in the payload: the DB touch trigger owns
  // the stamp (customers_touch_updated_at), so saving never depends on the
  // bookkeeping column existing. Notes keeps its inner whitespace.
  async function commitField(c, field, raw) {
    try {
      if (field === 'name') {
        const name = String(raw).trim();
        if (!name) return false; // a client can't be nameless — revert
        await db.customers.update(c.id, { name });
      } else {
        const value = field === 'notes' ? String(raw) : String(raw).trim();
        await db.customers.update(c.id, { [field]: value });
      }
      setWriteError('');
      return true;
    } catch (e) {
      setWriteError(`No se pudo guardar el cambio: ${userMessageFor(e)}`);
      return false;
    }
  }

  async function removeCustomer(c) {
    if (!confirm(`¿Eliminar el cliente "${c.name}"? Sus cotizaciones se conservan pero pierden la referencia.`)) return;
    await db.customers.delete(c.id);
  }

  const noMatches = loaded && customers.length > 0 && rows.length === 0;

  return (
    <>
      <PageHeader
        title="Clientes"
        subtitle={loaded ? `${customers.length} ${customers.length === 1 ? 'cliente' : 'clientes'} · edita directamente en la tabla` : ' '}
        actions={
          <button onClick={() => setCreating({})} className="btn-brand">
            <Plus size={14} /> Agregar cliente
          </button>
        }
      />

      {!loaded ? (
        <div className="card overflow-hidden"><ListLoading rows={5} /></div>
      ) : customers.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Sin clientes"
          description="Agrega tu primer cliente para reutilizar sus datos al crear cotizaciones."
          action={<button onClick={() => setCreating({})} className="btn-brand">Agregar cliente</button>}
        />
      ) : (
        <>
          <ListSearchHeader
            searchValue={q}
            onSearchChange={setQ}
            searchPlaceholder="Buscar por nombre, empresa, RNC, teléfono, dirección…"
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
            resultNoun={['cliente', 'clientes']}
          />

          <SheetErrorBanner message={writeError} onDismiss={() => setWriteError('')} />

          {/* Mobile sheet-cards — the fields ARE inputs, the chevron drops
              the full record. Same commit semantics as the desktop grid. */}
          <div className="md:hidden space-y-2">
            {noMatches && <NoMatchesCard />}
            {rows.map((c) => (
              <MobileRow
                key={c.id}
                c={c}
                rollup={rollupByCustomerId.get(c.id)}
                isOpen={expanded.has(c.id)}
                onToggle={() => toggleExpanded(c.id)}
                onCommit={(field, v) => commitField(c, field, v)}
                onRemove={() => removeCustomer(c)}
              />
            ))}
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
                  <SortableTh label="Pipeline" sortKey="pipeline" sort={sort} onSort={setSort} numeric className="text-right" />
                  {/* xl-only: at lg the column total exceeds the container and
                      the squeeze clips the phone digits. */}
                  <SortableTh label="Compras" sortKey="lifetime" sort={sort} onSort={setSort} numeric className="text-right hidden xl:table-cell" />
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {noMatches && (
                  <tr>
                    <td colSpan={9}>
                      <div className="flex items-center gap-2 py-3 text-sm text-ink-400">
                        <SearchX size={15} className="flex-shrink-0" aria-hidden />
                        Sin resultados — ajusta la búsqueda o los filtros.
                      </div>
                    </td>
                  </tr>
                )}
                {rows.map((c, i) => (
                  <SheetRow
                    key={c.id}
                    c={c}
                    row={i}
                    rollup={rollupByCustomerId.get(c.id)}
                    isOpen={expanded.has(c.id)}
                    onToggle={() => toggleExpanded(c.id)}
                    onCommit={(field, v) => commitField(c, field, v)}
                    onRemove={() => removeCustomer(c)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <CustomerModal customer={creating} onClose={() => setCreating(null)} profileId={profileId} />
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

/** One client as a sheet row + (when open) the full-record dropdown row. */
function SheetRow({ c, row, rollup, isOpen, onToggle, onCommit, onRemove }) {
  return (
    <>
      <tr className="group/row hover:bg-ink-50/40 transition-colors">
        <td className="!pr-0">
          <button
            type="button"
            onClick={onToggle}
            className="p-1 rounded text-ink-300 hover:text-brand-600 hover:bg-brand-50 transition-colors"
            title={isOpen ? 'Ocultar ficha' : 'Ver ficha y cotizaciones'}
            aria-expanded={isOpen}
          >
            <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </button>
        </td>
        <td className="font-medium max-w-[200px]">
          <div className="flex items-center gap-1.5">
            <Cell value={c.name} onCommit={(v) => onCommit('name', v)} row={row} col="name" placeholder="Nombre" label={`Nombre de ${c.name}`} />
            <ContactGapDot rollup={rollup} />
          </div>
        </td>
        <td className="max-w-[180px]">
          <Cell value={c.company} onCommit={(v) => onCommit('company', v)} row={row} col="company" placeholder="—" label={`Empresa de ${c.name}`} />
        </td>
        <td className="hidden lg:table-cell min-w-[9rem] max-w-[200px]">
          <Cell value={c.email} onCommit={(v) => onCommit('email', v)} row={row} col="email" type="email" inputMode="email" placeholder="—" label={`Correo de ${c.name}`} />
        </td>
        {/* min-w: phone digits must never clip — name/empresa absorb the
            squeeze instead (they truncate gracefully, numbers don't). */}
        <td className="hidden lg:table-cell min-w-[8rem] max-w-[140px]">
          <Cell value={c.phone} onCommit={(v) => onCommit('phone', v)} row={row} col="phone" type="tel" inputMode="tel" placeholder="—" label={`Teléfono de ${c.name}`} />
        </td>
        <td className="hidden xl:table-cell max-w-[140px]">
          <Cell value={c.city} onCommit={(v) => onCommit('city', v)} row={row} col="city" placeholder="—" label={`Ciudad de ${c.name}`} />
        </td>
        <td className="text-right tabular-nums whitespace-nowrap">
          {rollup?.openCount > 0 ? (
            <span className="text-ink-800">
              {formatMoney(rollup.openTotal, 'USD', { USD: 1 })}
              <span className="text-[11px] text-ink-400 ml-1">({rollup.openCount})</span>
            </span>
          ) : (
            <span className="text-ink-300">—</span>
          )}
        </td>
        <td className="hidden xl:table-cell text-right tabular-nums whitespace-nowrap">
          {rollup?.acceptedTotal > 0 ? (
            <span className="text-emerald-700">{formatMoney(rollup.acceptedTotal, 'USD', { USD: 1 })}</span>
          ) : (
            <span className="text-ink-300">—</span>
          )}
        </td>
        <td className="!pl-0 text-right">
          <span className="inline-flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity">
            <Link
              to={`/customers/${c.id}`}
              className="p-1.5 rounded text-ink-300 hover:text-brand-600 hover:bg-brand-50 transition-colors"
              title="Ver ficha completa"
            >
              <ArrowRight size={13} />
            </Link>
            <button
              type="button"
              onClick={onRemove}
              className="p-1.5 rounded text-ink-300 hover:text-red-600 hover:bg-red-50 transition-colors"
              title="Eliminar cliente"
            >
              <Trash2 size={13} />
            </button>
          </span>
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={9} className="!p-0 bg-ink-50/50">
            <CustomerPanel c={c} rollup={rollup} onCommit={onCommit} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Mobile: a card whose fields are the same in-place cells, stacked. */
function MobileRow({ c, rollup, isOpen, onToggle, onCommit, onRemove }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 p-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-1.5">
            <Cell value={c.name} onCommit={(v) => onCommit('name', v)} col="name" placeholder="Nombre" label={`Nombre de ${c.name}`} />
            <ContactGapDot rollup={rollup} />
          </div>
          <div className="grid grid-cols-2 gap-x-2">
            <Cell value={c.company} onCommit={(v) => onCommit('company', v)} col="company" placeholder="Empresa" label={`Empresa de ${c.name}`} align="text-[12px] text-ink-500" />
            <Cell value={c.phone} onCommit={(v) => onCommit('phone', v)} col="phone" type="tel" inputMode="tel" placeholder="Teléfono" label={`Teléfono de ${c.name}`} align="text-[12px] text-ink-500" />
          </div>
          <Cell value={c.email} onCommit={(v) => onCommit('email', v)} col="email" type="email" inputMode="email" placeholder="Correo" label={`Correo de ${c.name}`} align="text-[12px] text-ink-500" />
        </div>
        <div className="text-right shrink-0">
          {rollup?.openCount > 0 ? (
            <div className="text-[11px] tabular-nums text-ink-700 font-medium">
              {formatMoney(rollup.openTotal, 'USD', { USD: 1 })}
            </div>
          ) : null}
          <div className="eyebrow-xs text-ink-400">{rollup?.count || 0} cotiz.</div>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="p-2 -mr-1 rounded text-ink-300 hover:text-brand-600 transition-colors shrink-0"
          aria-expanded={isOpen}
          aria-label="Ver ficha y cotizaciones"
        >
          <ChevronDown size={16} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {isOpen && (
        <div className="border-t border-ink-100">
          <CustomerPanel c={c} rollup={rollup} onCommit={onCommit} onRemove={onRemove} />
        </div>
      )}
    </div>
  );
}

/**
 * Contact quick action — contacting the client IS the job. `to` renders an
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
// + the ficha link, (2) the quote pipeline grouped by status, (3) the FULL
// record — every Customer field that isn't a sheet column (RNC, contacto,
// dirección, provincia, CP, país) plus notes, all editable in place. One
// compact figure per fact: the totals live in the section header, never
// repeated in a band. Shared by the mobile card and the desktop sheet row
// so both surfaces stay identical.
function CustomerPanel({ c, rollup, onCommit, onRemove }) {
  const groups = rollup?.groups || [];
  const wa = waDigits(c.phone);
  return (
    <div className="divide-y divide-ink-100">
      {/* Contact bar — the channels this client actually has, ficha right. */}
      <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5">
        {wa && <QuickAction to={`/chats?chat=${wa}`} icon={MessageCircle} label="WhatsApp" />}
        {c.phone && <QuickAction href={`tel:${c.phone}`} icon={Phone} label="Llamar" />}
        {c.email && <QuickAction href={`mailto:${c.email}`} icon={Mail} label="Correo" />}
        <span className="flex-1" />
        <Link
          to={`/customers/${c.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 transition-colors hover:text-brand-700"
        >
          Ver ficha completa <ArrowRight size={12} aria-hidden />
        </Link>
      </div>

      <section className="px-4 py-3 space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Cotizaciones</h4>
          {(rollup?.openTotal > 0 || rollup?.acceptedTotal > 0) && (
            <span className="flex flex-wrap justify-end gap-x-3 text-[11px] tabular-nums text-ink-500">
              {rollup.openTotal > 0 && (
                <span>Pipeline <span className="font-semibold text-ink-700">{formatMoney(rollup.openTotal, 'USD', { USD: 1 })}</span></span>
              )}
              {rollup.acceptedTotal > 0 && (
                <span className="text-emerald-700">Comprado <span className="font-semibold">{formatMoney(rollup.acceptedTotal, 'USD', { USD: 1 })}</span></span>
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

      {/* The rest of the record — every field the sheet columns don't carry,
          same in-place commit semantics. Dirección stays its own field;
          notes is for remarks only. */}
      <section className="px-4 py-3 space-y-2.5">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Datos del cliente</h4>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <PanelField label="RNC / Cédula" value={c.rnc} onCommit={(v) => onCommit('rnc', v)} inputMode="numeric" />
          <PanelField label="Contacto" value={c.contactName} onCommit={(v) => onCommit('contactName', v)} className="col-span-1 sm:col-span-2" />
          <PanelField label="Dirección" value={c.address} onCommit={(v) => onCommit('address', v)} className="col-span-2 sm:col-span-3" />
          <PanelField label="Ciudad" value={c.city} onCommit={(v) => onCommit('city', v)} />
          <PanelField label="Provincia" value={c.state} onCommit={(v) => onCommit('state', v)} />
          <div className="grid grid-cols-2 gap-2">
            <PanelField label="C.P." value={c.zip} onCommit={(v) => onCommit('zip', v)} inputMode="numeric" />
            <PanelField label="País" value={c.country} onCommit={(v) => onCommit('country', v)} />
          </div>
        </div>
        <PanelTextArea
          label="Notas"
          value={c.notes}
          onCommit={(v) => onCommit('notes', v)}
          placeholder="Notas internas — preferencias, acuerdos, contexto…"
          name={c.name}
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
