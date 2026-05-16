import { CheckCircle2 } from 'lucide-react';
import { FULFILLMENT_MILESTONES } from '../lib/containerStages.js';

/**
 * The per-quote fulfillment milestone pills. Click toggles the timestamp.
 *
 * Shared between `ContainerDetail` (roll-up of pinned quotes) and the new
 * quote workspace (so the dealer can mark "Depósito recibido" without
 * leaving the quote they're looking at).
 */
export default function FulfillmentPills({ quote, onChange, size = 'sm' }) {
  const isSm = size === 'sm';
  return (
    <div className="flex flex-wrap gap-1">
      {FULFILLMENT_MILESTONES.map((m) => {
        const ts = quote?.[m.key];
        const done = !!ts;
        return (
          <button
            key={m.key}
            type="button"
            onClick={() => onChange({ [m.key]: done ? null : Date.now() })}
            title={`${m.title}${done ? ` · ${new Date(ts).toLocaleDateString('es-DO')}` : ''}`}
            className={`${isSm ? 'text-[10px] px-2 py-0.5' : 'text-xs px-2.5 py-1'} font-medium rounded-full border transition-colors
              ${done
                ? 'bg-emerald-100 text-emerald-800 border-emerald-300 hover:bg-emerald-200'
                : 'bg-white text-ink-500 border-ink-200 hover:border-ink-400 hover:text-ink-700'}`}
          >
            {done && <CheckCircle2 size={isSm ? 9 : 10} className="inline mr-0.5 -mt-px" />}
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
