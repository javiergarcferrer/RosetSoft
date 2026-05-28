import { AlertTriangle } from 'lucide-react';
import { useLiveQuery } from '../../db/hooks.js';
import { db } from '../../db/database.js';

/**
 * Advisory warning surfaced on an ACCEPTED SPECIAL order that isn't tied to a
 * container yet. A special order ships in a container and collects its balance
 * on arrival — and the assigned professional's commission only becomes payable
 * on that balance (see commissionOwedAt). So until the quote's order has a
 * container, the dealer is reminded to link one.
 *
 * Floor sales collect on the deposit and need no container, so this never
 * fires for them. It is ADVISORY ONLY — nothing here blocks editing or
 * accepting the quote (a hard guard was deliberately not wanted); it just
 * nudges the dealer to attach the order/container before billing.
 *
 * "Tied to a container" = the quote's order (quote.orderId) has at least one
 * container row. No order at all ⇒ definitely none ⇒ warn. Loads its own data
 * (the quote workspace doesn't fetch containers), mirroring OrderChip.
 */
export default function SpecialOrderWarning({ quote }) {
  const containers = useLiveQuery(
    () => (quote.orderId
      ? db.containers.where('orderId').equals(quote.orderId).toArray()
      : Promise.resolve([])),
    [quote.orderId],
    null,
  );

  if (quote.status !== 'accepted') return null;
  if (quote.orderType !== 'special') return null;
  if (containers === null) return null;       // still loading — don't flash the warning
  if (containers.length > 0) return null;     // already tied to a container — all good

  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800"
      role="status"
    >
      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden />
      <span>
        <span className="font-semibold">Pedido especial sin contenedor.</span>{' '}
        Vincúlalo a un pedido con contenedor — el balance (y la comisión del
        profesional) se cobra cuando llega el contenedor.
      </span>
    </div>
  );
}
