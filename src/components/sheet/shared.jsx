import { Link } from 'react-router-dom';
import { ArrowUp, ArrowDown, ArrowUpDown, SearchX } from 'lucide-react';

/**
 * Shared chrome for the inline-editable directory sheets (Clientes,
 * Profesionales). These pieces were byte-identical in both pages; hoisting
 * them here is the single home so the two sheets can't drift (same rationale
 * as `cells.jsx`).
 */

// Section labels for the per-row quote dropdown — plural, mirroring the
// detail pages' sections so the surfaces read the same way.
export const STATUS_LABELS = {
  draft: 'Borradores',
  sent: 'Enviadas',
  accepted: 'Aceptadas',
  declined: 'Rechazadas',
  archived: 'Archivadas',
};

/** The "nothing survived the filters" hint, card-shaped for the mobile stack. */
export function NoMatchesCard() {
  return (
    <div className="card p-3 flex items-center gap-2 text-sm text-ink-400">
      <SearchX size={15} className="flex-shrink-0" aria-hidden />
      Sin resultados — ajusta la búsqueda o los filtros.
    </div>
  );
}

/**
 * Renders one sortable header from a column definition. It mirrors SortableTh's
 * sort affordance but owns its own <th> so the resize hook can spread thProps
 * (data-col-key + persisted width) onto it and render the drag handle as its
 * last child — SortableTh's <th> isn't ours to augment. Non-sortable columns
 * (no `col.sortKey`) fall back to a plain resizable header.
 */
export function ColumnTh({ col, sort, onSort, thProps, ResizeHandle }) {
  if (!col.sortKey) {
    return (
      <th className={col.thClass || ''} {...thProps(col.key)}>
        {col.label}
        {ResizeHandle(col.key)}
      </th>
    );
  }
  const active = sort.key === col.sortKey;
  const Icon = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th
      className={col.thClass || ''}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      {...thProps(col.key)}
    >
      <button
        type="button"
        onClick={() => onSort(active
          ? { key: col.sortKey, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
          : { key: col.sortKey, dir: col.numeric ? 'desc' : 'asc' })}
        className={`group/th inline-flex items-center gap-1 transition-colors hover:text-ink-900 ${
          col.numeric ? 'w-full justify-end' : ''
        } ${active ? 'text-ink-900' : ''}`}
        title={`Ordenar por ${col.label}`}
      >
        {col.label}
        <Icon
          size={11}
          className={active ? 'text-brand-600' : 'text-ink-200 group-hover/th:text-ink-400 transition-colors'}
          aria-hidden
        />
      </button>
      {ResizeHandle(col.key)}
    </th>
  );
}

/**
 * Contact quick action — contacting the contact IS the job. `to` renders an
 * in-app Link (WhatsApp goes to OUR inbox, /chats?chat=<phone>, never out to
 * wa.me — the business chats from the Cloud API number, logged in the CRM);
 * `href` covers the native tel:/mailto: handoffs that have no in-app pane.
 */
export function QuickAction({ href, to, icon: Icon, label }) {
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
