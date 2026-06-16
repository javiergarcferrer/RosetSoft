import { User as UserIcon, Pencil } from 'lucide-react';

/**
 * Compact chip that displays the assigned customer (or an "asignar cliente"
 * empty-state pill). Clicking the name opens the CustomerPicker.
 *
 * The chip is intentionally not a `<select>` — the customer is a first-class
 * subject of the quote, not a tiny field. A leading client icon + name +
 * company makes the client present in the header, where it belongs.
 *
 * When `onEdit` is given (and a customer is assigned) a pencil segment is
 * GLUED to the right of the same pill — one rounded shell, a hairline divider
 * between the two halves — so it reads unmistakably as "edit THIS client", not
 * a stray icon floating beside the chip. Name half = pick/change the customer;
 * pencil half = edit the assigned customer's data (address, RNC, contact…).
 */
export default function CustomerChip({ customer, onOpen, onEdit }) {
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

  // Split pill: the name button and the pencil share ONE rounded shell (border
  // + ring on the wrapper, `overflow-hidden` so each half's hover wash is
  // clipped to the pill). Press feedback is a background tint, not a scale —
  // scaling a single segment would reveal a sliver of the shell behind it.
  // Padding + min-height match ProfessionalChip so the chips read as one
  // visual register; name max-width follows the same breakpoint ladder.
  return (
    <span className="inline-flex shrink-0 items-stretch overflow-hidden rounded-full border border-ink-200 bg-surface ring-1 ring-inset ring-black/5 max-w-full min-w-0">
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex min-w-0 items-center gap-1.5 px-2 min-h-6 coarse:min-h-9 text-xs hover:bg-ink-50 active:bg-ink-100 transition-colors"
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
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          title="Editar datos del cliente (dirección, RNC, contacto…)"
          aria-label="Editar datos del cliente"
          className="inline-flex shrink-0 items-center justify-center px-1.5 min-h-6 coarse:min-h-9 border-l border-ink-200 text-ink-400 hover:text-brand-700 hover:bg-brand-50/50 active:bg-brand-100/60 transition-colors"
        >
          <Pencil size={11} aria-hidden />
        </button>
      )}
    </span>
  );
}
