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
        className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-ink-300 px-3 py-1 text-xs text-ink-500 hover:border-ink-500 hover:text-ink-900 transition-colors"
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
      className="inline-flex items-center gap-1.5 rounded-full border border-ink-200 bg-white px-2.5 min-h-7 coarse:min-h-9 text-xs hover:border-ink-400 hover:bg-ink-50 transition-colors max-w-full min-w-0"
      title={[customer.name, customer.company, customer.email, customer.phone].filter(Boolean).join(' · ')}
    >
      <UserIcon size={12} className="text-brand-600 flex-shrink-0" />
      <span className="min-w-0 inline-flex items-baseline gap-1.5 max-w-[110px] sm:max-w-[180px] lg:max-w-[220px]">
        <span className="font-medium text-ink-900 truncate">{customer.name}</span>
        {customer.company ? (
          <span className="text-ink-500 truncate hidden md:inline">{customer.company}</span>
        ) : null}
      </span>
    </button>
  );
}
