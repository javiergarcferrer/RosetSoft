import { User as UserIcon } from 'lucide-react';

/**
 * Compact chip that displays the assigned customer (or an "asignar cliente"
 * empty-state pill). Clicking opens the CustomerPicker.
 *
 * The chip is intentionally not a `<select>` — the customer is a first-class
 * subject of the quote, not a tiny field. A leading client icon + name +
 * company makes the client present in the header, where it belongs. No
 * trailing arrow: it's a picker, not a link, and the team knows the chip opens.
 */
export default function CustomerChip({ customer, onOpen }) {
  if (!customer) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-ink-300 px-2.5 min-h-6 coarse:min-h-9 text-xs text-ink-500 hover:border-brand-400 hover:text-brand-700 hover:bg-brand-50/50 transition-colors active:scale-[0.98]"
      >
        <UserIcon size={12} />
        Asignar cliente
      </button>
    );
  }

  // Padding + min-height intentionally match ProfessionalChip so the
  // two chips render as the same visual register in the meta row.
  // Name max-width follows the same breakpoint ladder too — they
  // truncate at the same point regardless of which row they're in.
  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-ink-200 bg-surface px-2 min-h-6 coarse:min-h-9 text-xs hover:border-ink-400 hover:bg-ink-50 transition-all active:scale-[0.98] max-w-full min-w-0 ring-1 ring-inset ring-black/5"
      title={[customer.name, customer.company, customer.email, customer.phone].filter(Boolean).join(' · ')}
    >
      <UserIcon size={12} className="text-brand-500 flex-shrink-0" />
      <span className="min-w-0 inline-flex items-baseline gap-1.5 max-w-[140px] sm:max-w-[180px] lg:max-w-[220px]">
        <span className="font-semibold text-ink-900 truncate">{customer.name}</span>
        {customer.company ? (
          <span className="text-ink-400 truncate hidden md:inline">{customer.company}</span>
        ) : null}
      </span>
    </button>
  );
}
