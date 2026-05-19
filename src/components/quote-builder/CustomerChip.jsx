import { ChevronDown, User as UserIcon } from 'lucide-react';

/**
 * Compact chip that displays the assigned customer (or an "asignar cliente"
 * empty-state pill). Clicking opens the CustomerPicker.
 *
 * The chip is intentionally not a `<select>` — the customer is a first-class
 * subject of the quote, not a tiny field. Avatar + name + company makes the
 * client present in the header, where it belongs.
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
      className="inline-flex items-center gap-2 rounded-full border border-ink-200 bg-white pl-2 pr-2.5 min-h-7 coarse:min-h-9 text-xs hover:border-ink-400 hover:bg-ink-50 transition-colors max-w-full min-w-0"
      title={[customer.name, customer.company, customer.email, customer.phone].filter(Boolean).join(' · ')}
    >
      <Avatar name={customer.name} />
      <span className="min-w-0 inline-flex items-baseline gap-1.5 max-w-[110px] sm:max-w-[180px] lg:max-w-[220px]">
        <span className="font-medium text-ink-900 truncate">{customer.name}</span>
        {customer.company ? (
          <span className="text-ink-500 truncate hidden md:inline">{customer.company}</span>
        ) : null}
      </span>
      <ChevronDown size={12} className="text-ink-400 flex-shrink-0" />
    </button>
  );
}

function Avatar({ name }) {
  const initials = (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((n) => n.charAt(0).toUpperCase())
    .join('');
  return (
    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-brand-100 text-brand-700 text-[9px] font-semibold flex-shrink-0">
      {initials || '?'}
    </span>
  );
}
