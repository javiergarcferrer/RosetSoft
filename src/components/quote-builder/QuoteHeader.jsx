import { useState } from 'react';
import { ArrowLeft, Briefcase, Check, Undo2, Redo2, UserX } from 'lucide-react';
import { useGoBack } from '../../context/NavMemory.jsx';
import Dropdown, { DropdownItem } from '../primitives/Dropdown.jsx';
import CustomerChip from './CustomerChip.jsx';
import WhatsAppChip from './WhatsAppChip.jsx';
import CustomerPicker from './CustomerPicker.jsx';
import CustomerModal from '../CustomerModal.jsx';
import SpecialOrderWarning from './SpecialOrderWarning.jsx';
import ProfessionalChip from './ProfessionalChip.jsx';
import SaveIndicator from './SaveIndicator.jsx';
import InvoiceChip from '../InvoiceChip.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { termsPatchForOrderType } from '../../core/quote/index.js';
import { shortcutLabel } from '../../lib/useKeyboardShortcut.js';

/**
 * Top of the quote workspace. Title (editable inline), customer chip,
 * container chip, save indicator, and undo/redo. Switching between the
 * editor / client preview / WhatsApp surfaces lives in the ModeBar (the
 * bottom bar on phones, the floating siderail on desktop), not here. Export
 * PDF and Share moved to the persistent bottom totals dock so they're always
 * reachable.
 *
 * The title is inline-editable: clicking the H1 swaps in an input. The "back
 * to quotes" link is a tiny breadcrumb above. This consolidates four
 * different controls that today live in three different rows.
 */
export default function QuoteHeader({
  quote,
  invoice,
  customers,
  professionals,
  profileId,
  onUpdateQuote,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  savedAt,
  saving,
}) {
  const goBack = useGoBack();
  const customer = quote?.customerId ? customers.find((c) => c.id === quote.customerId) : null;
  // Look up the quote's creator from the AppContext profiles list. The
  // user who clicked "Nueva cotización" has their auth.uid() stamped
  // on the row at materialize time. Admins can re-assign the seller
  // via the inline picker below — useful when a quote was built on a
  // shared workstation, an employee left and an admin needs to credit
  // a different seller, or to fix legacy quotes that predate user
  // attribution. Falls back silently to "—" when unset; the rest of
  // the app (commissions report) skips quotes with no creator.
  const { profiles: allProfiles, currentProfile, settings } = useApp();
  const isAdmin = currentProfile?.role === 'admin';
  const creator = quote?.createdByUserId
    ? allProfiles.find((p) => p.id === quote.createdByUserId)
    : null;
  const creatorLabel = creator
    ? (creator.name?.trim() || creator.email?.split('@')[0] || '')
    : '';
  // Only real, active team members are eligible to be a seller.
  // Tombstoned / pending profiles would attribute commissions to
  // ineligible accounts; surface them only when they're the CURRENT
  // creator so the admin can see who's there and change them.
  const assignableSellers = (allProfiles || []).filter(
    (p) =>
      p.id !== 'team' &&
      (p.role === 'admin' || p.role === 'employee') &&
      (p.active || p.id === quote?.createdByUserId),
  );
  const professional = quote?.professionalId
    ? professionals.find((p) => p.id === quote.professionalId)
    : null;
  const [pickerOpen, setPickerOpen] = useState(false);
  // Inline edit of the assigned customer — the same modal the Customers list /
  // detail page use, opened from a small pencil beside the chip. Saves a trip
  // to the Clientes panel just to add a missing address or RNC while quoting.
  const [editingCustomer, setEditingCustomer] = useState(false);

  // Flipping the order type (Piso ⇄ Especial) re-points the terms to the
  // matching preset — but only when the dealer hadn't hand-edited them
  // (termsPatchForOrderType decides). Merged into the same patch so the swap
  // is a single change/undo. Non-orderType updates (seller, professional,
  // customer) pass straight through untouched.
  const onUpdateQuoteWithTerms = (patch) => {
    if (patch && typeof patch.orderType === 'string') {
      const termsPatch = termsPatchForOrderType(settings, quote, patch.orderType);
      if (termsPatch) return onUpdateQuote({ ...patch, ...termsPatch });
    }
    return onUpdateQuote(patch);
  };

  return (
    <div className="mb-5">
      {/* ROW 1 — back · quote # + save STATE · seller · undo/redo, on ONE line.
          (The order affordance lives in the status card below, beside the
          status label — not here.) */}
      <div className="flex items-center gap-2 min-w-0">
        <button type="button" onClick={() => goBack('/quotes')} className="back-link mb-0 px-2 shrink-0" title="Volver a cotizaciones">
          <ArrowLeft size={14} />
          <span className="hidden sm:inline">Volver</span>
        </button>
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="eyebrow shrink-0 text-brand-600 font-bold tracking-widest hidden sm:inline">Cotización</span>
          <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight leading-none text-ink-900 whitespace-nowrap">
            {quote.number != null ? `#${quote.number}` : 'Borrador'}
          </h1>
          <SaveIndicator savedAt={savedAt} saving={saving} />
        </div>
        {/* Seller (Vendedor) — reads inline with the quote number ("#1010 by …"),
            always visible (never behind the ROW 2 scroll fade). */}
        {isAdmin ? (
          <SellerSelect quote={quote} assignableSellers={assignableSellers} onUpdateQuote={onUpdateQuote} />
        ) : creatorLabel ? (
          <span className="text-[11px] text-ink-400 whitespace-nowrap truncate min-w-0">
            Creada por <span className="text-ink-600 font-medium">{creatorLabel}</span>
          </span>
        ) : null}
        <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
          <UndoRedo onUndo={onUndo} onRedo={onRedo} canUndo={canUndo} canRedo={canRedo} />
        </div>
      </div>

      {/* ROW 2 — the "who": customer · WhatsApp · professional. A single
          horizontally-scrollable strip on a phone (so it never stacks into
          extra rows), with a soft right-edge fade so the overflow reads as
          "scroll for more", not a clipped chip. Wraps normally on sm+. */}
      <div
        className="mt-2 -mx-1 px-1 flex items-center gap-1.5 overflow-x-auto sm:overflow-visible sm:flex-wrap [&>*]:shrink-0 sm:[&>*]:shrink [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [-webkit-mask-image:linear-gradient(to_right,#000_90%,transparent)] [mask-image:linear-gradient(to_right,#000_90%,transparent)] sm:[-webkit-mask-image:none] sm:[mask-image:none]"
        role="group"
        aria-label="Datos de la cotización"
      >
        {/* Name half picks/changes the customer; the glued pencil half edits the
            assigned one in place (the modal below). Pencil only when assigned. */}
        <CustomerChip
          customer={customer}
          onOpen={() => setPickerOpen(true)}
          onEdit={customer ? () => setEditingCustomer(true) : undefined}
        />
        <WhatsAppChip customer={customer} />
        <ProfessionalChip
          quote={quote}
          professional={professional}
          professionals={professionals}
          profileId={profileId}
          onUpdateQuote={onUpdateQuoteWithTerms}
        />
      </div>

      {/* Invoicing stamp — the books' one-way echo (bridge): NCF + e-CF state. */}
      {invoice && (
        <div className="mt-1.5">
          <InvoiceChip invoice={invoice} detail />
        </div>
      )}

      <SpecialOrderWarning quote={quote} />

      <CustomerPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(id) => onUpdateQuote({ customerId: id })}
        customers={customers}
        profileId={profileId}
        currentId={quote.customerId}
      />

      {/* Edit-the-customer modal (the shared CustomerModal). The builder's live
          `customers` query repaints the chip with the new values on save. If the
          row is deleted from here, clear the now-dangling assignment so the chip
          falls back to "Asignar cliente" instead of pointing at a ghost. */}
      <CustomerModal
        customer={editingCustomer && customer ? customer : null}
        onClose={() => setEditingCustomer(false)}
        onAfterDelete={() => { onUpdateQuote({ customerId: null }); setEditingCustomer(false); }}
        profileId={profileId}
      />
    </div>
  );
}

/** Display name for a seller profile, with a graceful e-mail/id fallback. */
function sellerName(p) {
  return p?.name?.trim() || p?.email?.split('@')[0] || p?.id || '';
}

/**
 * Compact seller (Vendedor) picker rendered as a chip in the breadcrumb row
 * beside the order pill, away from the customer/professional meta strip. A
 * leading briefcase icon denotes it; visually matches the chip vocabulary
 * (rounded-full, ink-200 border, ring + hover state) so the eye reads the row
 * as a single horizontal group — twinned with the ProfessionalChip pill.
 *
 * Built on the shared <Dropdown> primitive so the menu is OUR menu — a
 * portaled, flip-aware panel with the `dropdown-pop` animation, keyboard
 * roving and click-outside — instead of the browser's native `<select>` popup
 * (the grey, OS-styled list that ignored our theme). The chip itself owns the
 * trigger look via `triggerClassName`.
 *
 * The "— sin vendedor —" row lets an admin explicitly null out attribution for
 * training / sandbox quotes. Inactive sellers stay listed only when they're the
 * current attribution so the row labels itself honestly — picking someone else
 * effectively "unassigns" the inactive one.
 */
function SellerSelect({ quote, assignableSellers, onUpdateQuote }) {
  const currentId = quote?.createdByUserId || null;
  const current = currentId ? assignableSellers.find((p) => p.id === currentId) : null;
  return (
    <Dropdown
      ariaLabel="Vendedor asignado"
      chevron={false}
      triggerClassName="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-ink-200 bg-surface hover:border-ink-400 hover:bg-ink-50 active:scale-[0.98] transition-all px-2 min-h-6 coarse:min-h-9 text-xs ring-1 ring-inset ring-black/5 cursor-pointer"
      label={(
        <>
          <Briefcase size={12} className="text-ink-400 flex-shrink-0" aria-hidden />
          <span
            className={`truncate min-w-0 max-w-[88px] sm:max-w-[180px] lg:max-w-[220px] ${
              current ? 'text-ink-900 font-medium' : 'text-ink-400 italic'
            }`}
          >
            {current ? sellerName(current) : 'sin vendedor'}
          </span>
        </>
      )}
    >
      {({ close }) => (
        <>
          <DropdownItem
            active={!currentId}
            onSelect={() => { onUpdateQuote({ createdByUserId: null }); close(); }}
          >
            <span className="flex w-3.5 flex-shrink-0 justify-center pt-0.5">
              {!currentId && <Check size={14} className="text-brand-600" aria-hidden />}
            </span>
            <span className="inline-flex items-center gap-1.5 text-ink-500">
              <UserX size={14} className="text-ink-400" aria-hidden /> Sin vendedor
            </span>
          </DropdownItem>

          {assignableSellers.map((p) => {
            const isCurrent = p.id === currentId;
            const inactive = isCurrent && !p.active;
            return (
              <DropdownItem
                key={p.id}
                active={isCurrent}
                onSelect={() => { onUpdateQuote({ createdByUserId: p.id }); close(); }}
              >
                <span className="flex w-3.5 flex-shrink-0 justify-center pt-0.5">
                  {isCurrent && <Check size={14} className="text-brand-600" aria-hidden />}
                </span>
                <span className="min-w-0 truncate">
                  {sellerName(p)}
                  {inactive && <span className="ml-1.5 text-[11px] text-ink-400">(inactivo)</span>}
                </span>
              </DropdownItem>
            );
          })}
        </>
      )}
    </Dropdown>
  );
}

/**
 * Undo / redo for the whole quote workspace — line edits, prices,
 * margins, customer/professional, notes. Rendered as a compact segmented
 * pair in the actions cluster; each button disables when its stack is
 * empty. Keyboard equivalents (⌘Z / ⌘⇧Z) are wired in QuoteBuilder.
 */
function UndoRedo({ onUndo, onRedo, canUndo, canRedo }) {
  return (
    <div className="inline-flex rounded-md border border-ink-200 overflow-hidden bg-surface shadow-xs">
      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        className="px-2.5 min-h-6 coarse:min-h-9 inline-flex items-center text-ink-500 hover:bg-ink-50 hover:text-ink-900 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-150 active:bg-ink-100 active:scale-[0.96]"
        title={`Deshacer (${shortcutLabel('mod+z')})`}
        aria-label="Deshacer"
      >
        <Undo2 size={14} />
      </button>
      <button
        type="button"
        onClick={onRedo}
        disabled={!canRedo}
        className="px-2.5 min-h-6 coarse:min-h-9 inline-flex items-center text-ink-500 hover:bg-ink-50 hover:text-ink-900 border-l border-ink-200 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-150 active:bg-ink-100 active:scale-[0.96]"
        title={`Rehacer (${shortcutLabel('mod+shift+z')})`}
        aria-label="Rehacer"
      >
        <Redo2 size={14} />
      </button>
    </div>
  );
}
