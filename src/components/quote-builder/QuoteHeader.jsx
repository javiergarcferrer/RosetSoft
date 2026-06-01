import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Briefcase, Eye, Pencil, Undo2, Redo2 } from 'lucide-react';
import CustomerChip from './CustomerChip.jsx';
import CustomerPicker from './CustomerPicker.jsx';
import OrderChip from './OrderChip.jsx';
import SpecialOrderWarning from './SpecialOrderWarning.jsx';
import ProfessionalChip from './ProfessionalChip.jsx';
import SaveIndicator from './SaveIndicator.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { shortcutLabel } from '../../lib/useKeyboardShortcut.js';

/**
 * Top of the quote workspace. Title (editable inline), customer chip,
 * container chip, save indicator, view toggle (compose / client preview),
 * and undo/redo. Export PDF and Share moved to the persistent bottom totals
 * dock so they're always reachable.
 *
 * The title is inline-editable: clicking the H1 swaps in an input. The "back
 * to quotes" link is a tiny breadcrumb above. This consolidates four
 * different controls that today live in three different rows.
 */
export default function QuoteHeader({
  quote,
  customers,
  professionals,
  profileId,
  view,
  onViewChange,
  onUpdateQuote,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  savedAt,
  saving,
}) {
  const customer = quote?.customerId ? customers.find((c) => c.id === quote.customerId) : null;
  // Look up the quote's creator from the AppContext profiles list. The
  // user who clicked "Nueva cotización" has their auth.uid() stamped
  // on the row at materialize time. Admins can re-assign the seller
  // via the inline picker below — useful when a quote was built on a
  // shared workstation, an employee left and an admin needs to credit
  // a different seller, or to fix legacy quotes that predate user
  // attribution. Falls back silently to "—" when unset; the rest of
  // the app (commissions report) skips quotes with no creator.
  const { profiles: allProfiles, currentProfile } = useApp();
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

  return (
    <div className="mb-5">
      {/* Breadcrumb row — back link anchors the left; the order pill and the
          seller picker sit on the right, out of the customer/professional meta
          strip below. The seller is an attribution control (admin-only) and the
          order pill is a navigation shortcut — neither is core quote data, so
          both belong up here rather than crowding the meta row. The right group
          wraps (seller drops under the order pill) when an admin opens an
          accepted quote on a narrow phone and the two can't share a line. */}
      <div className="flex items-center justify-between gap-2 mb-3">
        <Link to="/quotes" className="back-link mb-0">
          <ArrowLeft size={12} />
          <span>Volver<span className="hidden sm:inline"> a cotizaciones</span></span>
        </Link>
        <div className="flex flex-wrap items-center justify-end gap-2 min-w-0">
          <OrderChip
            quote={quote}
            profileId={profileId}
            onAttach={(orderId) => onUpdateQuote({ orderId })}
          />
          {isAdmin && (
            <SellerSelect
              quote={quote}
              assignableSellers={assignableSellers}
              onUpdateQuote={onUpdateQuote}
            />
          )}
        </div>
      </div>

      <div className="space-y-3">
        {/* Title (left) and actions (right) on one row that WRAPS rather
            than overlaps. The earlier flex-1 + nowrap split let a wide
            actions cluster shrink the title column to zero width, so the
            opaque buttons painted over the number. Here the title keeps its
            intrinsic min-width (the number is never clipped) and the actions
            drop onto their own line when they can't fit beside it. On phones
            the column layout stacks them; the SaveIndicator rides inline with
            the eyebrow as the number's status line and truncates if cramped. */}
        <div className="flex flex-row flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div>
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="eyebrow shrink-0">Cotización</div>
              <SaveIndicator savedAt={savedAt} saving={saving} />
            </div>
            <h1 className="mt-0.5 text-[26px] sm:text-[28px] font-semibold tracking-tight leading-tight text-ink-900">
              {quote.number != null ? `#${quote.number}` : 'Borrador'}
            </h1>
            {!isAdmin && creatorLabel && (
              <div className="text-[11px] text-ink-500 mt-1">
                Creada por <span className="text-ink-700">{creatorLabel}</span>
              </div>
            )}
          </div>

          {/* Buttons wrap among themselves on the narrowest phones; the whole
              cluster drops below the title when the row is too tight. The
              Edición/Cliente ViewToggle was lifted out to a floating pinned
              pill (QuoteBuilder) so it stays on screen while scrolling a long
              quote — especially the client preview. */}
          <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
            <UndoRedo
              onUndo={onUndo}
              onRedo={onRedo}
              canUndo={canUndo}
              canRedo={canRedo}
            />
          </div>
        </div>

        {/* Meta row: customer + professional (with its order-type/commission
            tier jointed in), in one horizontal group. Wraps naturally when the
            chips don't all fit on a single line; each chip is a single flex
            child, so a pill never splits across the wrap. The order pill moved
            up to the breadcrumb row, out of this strip. */}
        {/* Customer + professional only — the internal Facturación toggle moved
            to the totals dock's commission card, so these two fit one row. */}
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Datos de la cotización"
        >
          <CustomerChip customer={customer} onOpen={() => setPickerOpen(true)} />
          <ProfessionalChip
            quote={quote}
            professional={professional}
            professionals={professionals}
            profileId={profileId}
            onUpdateQuote={onUpdateQuote}
          />
        </div>

        <SpecialOrderWarning quote={quote} />
      </div>

      <CustomerPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(id) => onUpdateQuote({ customerId: id })}
        customers={customers}
        profileId={profileId}
        currentId={quote.customerId}
      />
    </div>
  );
}

/**
 * Compact seller (Vendedor) select rendered as a chip in the breadcrumb row
 * beside the order pill, away from the customer/professional meta strip. A
 * leading briefcase icon denotes it — no text label, no native dropdown arrow
 * (we drop the arrow with appearance-none; the team knows the name is a
 * picker). Visually matches the chip vocabulary (rounded, ink-200 border,
 * hover state) so the eye reads the row as a single horizontal group.
 *
 * The blank option lets an admin explicitly null out attribution for
 * training / sandbox quotes. Inactive sellers stay listed only when
 * they're the current attribution so the row labels itself honestly
 * — picking someone else effectively "unassigns" the inactive one.
 */
function SellerSelect({ quote, assignableSellers, onUpdateQuote }) {
  return (
    <label
      className="inline-flex items-center gap-1.5 rounded-full border border-ink-200 bg-white hover:border-ink-400 transition-colors px-2.5 min-h-7 coarse:min-h-9 text-xs"
      title="Vendedor"
    >
      <Briefcase size={12} className="text-ink-500 flex-shrink-0" aria-hidden />
      <select
        value={quote?.createdByUserId || ''}
        onChange={(e) => onUpdateQuote({ createdByUserId: e.target.value || null })}
        className="appearance-none bg-transparent border-0 p-0 text-xs text-ink-900 font-medium focus:outline-none focus:ring-0 cursor-pointer max-w-[110px] sm:max-w-[180px] lg:max-w-[220px] truncate"
        aria-label="Vendedor asignado"
      >
        <option value="">— sin vendedor —</option>
        {assignableSellers.map((p) => (
          <option key={p.id} value={p.id}>
            {(p.name?.trim() || p.email?.split('@')[0] || p.id)}
            {p.id === quote?.createdByUserId && !p.active ? ' (inactivo)' : ''}
          </option>
        ))}
      </select>
    </label>
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
    <div className="inline-flex rounded-md border border-ink-200 overflow-hidden bg-white">
      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        className="px-2 min-h-7 coarse:min-h-9 inline-flex items-center text-ink-700 hover:bg-ink-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        title={`Deshacer (${shortcutLabel('mod+z')})`}
        aria-label="Deshacer"
      >
        <Undo2 size={14} />
      </button>
      <button
        type="button"
        onClick={onRedo}
        disabled={!canRedo}
        className="px-2 min-h-7 coarse:min-h-9 inline-flex items-center text-ink-700 hover:bg-ink-50 border-l border-ink-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        title={`Rehacer (${shortcutLabel('mod+shift+z')})`}
        aria-label="Rehacer"
      >
        <Redo2 size={14} />
      </button>
    </div>
  );
}

export function ViewToggle({ view, onChange, className = '' }) {
  return (
    <div className={`inline-flex rounded-md border border-ink-200 overflow-hidden bg-white ${className}`}>
      <button
        type="button"
        onClick={() => onChange('compose')}
        className={`px-2.5 py-1.5 text-xs font-medium inline-flex items-center gap-1.5 transition-colors ${
          view === 'compose' ? 'bg-ink-900 text-white' : 'text-ink-700 hover:bg-ink-50'
        }`}
        title="Vista de edición"
      >
        <Pencil size={12} /> Edición
      </button>
      <button
        type="button"
        onClick={() => onChange('client')}
        className={`px-2.5 py-1.5 text-xs font-medium inline-flex items-center gap-1.5 transition-colors border-l border-ink-200 ${
          view === 'client' ? 'bg-ink-900 text-white' : 'text-ink-700 hover:bg-ink-50'
        }`}
        title="Vista del cliente"
      >
        <Eye size={12} /> Cliente
      </button>
    </div>
  );
}
