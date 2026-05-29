import { useMemo, useState } from 'react';
import { Ship, ChevronDown } from 'lucide-react';
import { useLiveQuery } from '../db/hooks.js';
import { db } from '../db/database.js';
import { isValidContainerNo, normalizeContainerNo } from '../lib/containerTracking.js';
import ContainerTracking from './ContainerTracking.jsx';

/**
 * Shipment tracking for a quote's attached order: the order's trackable
 * containers, each shown as a <ContainerTracking> panel. Renders NOTHING when
 * there's no order or no valid container number — so callers can drop it in
 * unconditionally ("…for quotes that have a suitable order attached").
 *
 * Data — pass `containers` to render from an already-loaded list (the quotes
 * list loads them once for every row); otherwise pass `orderId` and we query.
 *
 * Presentation:
 *   • default     — a titled card section (quote editor), panels open.
 *   • collapsible — closed behind a toggle that only MOUNTS the panels (and so
 *     fires hl-track) on expand; for list rows, so N rows don't each load a map
 *     and a tracking call at once.
 */
export default function ShipmentTracking({
  orderId,
  containers: provided,
  collapsible = false,
  title = 'Seguimiento de envío',
  className = '',
}) {
  // Query only when we weren't handed a list and we actually have an order.
  const queried = useLiveQuery(
    () => (!provided && orderId
      ? db.containers.where('orderId').equals(orderId).toArray()
      : Promise.resolve(null)),
    [orderId, !!provided],
    null,
  );
  const trackable = useMemo(
    () => (provided ?? queried ?? []).filter((c) => isValidContainerNo(c.code)),
    [provided, queried],
  );
  const [open, setOpen] = useState(false);

  if (trackable.length === 0) return null;

  const panels = (
    <div className="space-y-3">
      {trackable.map((c) => (
        <div key={c.id} className="space-y-1.5">
          <div className="text-[11px] font-medium text-ink-600">
            Contenedor #{c.number ?? '—'}
            <span className="font-mono text-ink-400"> · {normalizeContainerNo(c.code)}</span>
          </div>
          <ContainerTracking containerNo={normalizeContainerNo(c.code)} />
        </div>
      ))}
    </div>
  );

  // List rows: a compact toggle; the panels (and their hl-track calls) only
  // mount once the dealer opens it.
  if (collapsible) {
    return (
      <div className={className}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 bg-white px-2.5 py-1 text-[11px] font-medium text-ink-600 hover:border-ink-400 hover:text-ink-900 transition-colors"
        >
          <Ship size={12} />
          Rastrear envío{trackable.length > 1 ? ` · ${trackable.length}` : ''}
          <ChevronDown size={13} className={`text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && <div className="mt-2">{panels}</div>}
      </div>
    );
  }

  return (
    <section className={`card card-pad space-y-3 ${className}`}>
      <h2 className="font-semibold text-sm flex items-center gap-2">
        <Ship size={16} className="text-ink-500" /> {title}
      </h2>
      {panels}
    </section>
  );
}
