import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Briefcase, Eye, Pencil, Undo2, Redo2 } from 'lucide-react';
import CustomerChip from './CustomerChip.jsx';
import WhatsAppChip from './WhatsAppChip.jsx';
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
      {/* ROW 1 — back · identity (#number + save status) · undo/redo + view
          toggle. Compact so it holds a single line on a normal phone; the action
          cluster wraps beneath the number only on the very narrowest widths.
          Folds the old separate breadcrumb row into this one. */}
      <div className="flex items-center justify-between gap-x-3 gap-y-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Link to="/quotes" className="back-link mb-0 px-2" title="Volver a cotizaciones">
            <ArrowLeft size={14} />
            <span className="hidden sm:inline">Volver</span>
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="eyebrow shrink-0 text-brand-600 font-bold tracking-widest">Cotización</span>
              <SaveIndicator savedAt={savedAt} saving={saving} />
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight leading-none text-ink-900">
              {quote.number != null ? `#${quote.number}` : 'Borrador'}
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <UndoRedo onUndo={onUndo} onRedo={onRedo} canUndo={canUndo} canRedo={canRedo} />
          <ViewToggle view={view} onChange={onViewChange} />
        </div>
      </div>

      {/* ROW 2 — the "who": customer + professional, plus the order pill, the
          admin seller picker and the creator credit. One wrapping flex group so
          pills reflow without ever splitting. Folds the old breadcrumb + meta
          rows together to keep the whole header to two rows. */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Datos de la cotización">
        <CustomerChip customer={customer} onOpen={() => setPickerOpen(true)} />
        <WhatsAppChip customer={customer} />
        <ProfessionalChip
          quote={quote}
          professional={professional}
          professionals={professionals}
          profileId={profileId}
          onUpdateQuote={onUpdateQuote}
        />
        <OrderChip quote={quote} profileId={profileId} onAttach={(orderId) => onUpdateQuote({ orderId })} />
        {isAdmin && (
          <SellerSelect quote={quote} assignableSellers={assignableSellers} onUpdateQuote={onUpdateQuote} />
        )}
        {!isAdmin && creatorLabel && (
          <span className="text-[11px] text-ink-400 ml-0.5">
            Creada por <span className="text-ink-600 font-medium">{creatorLabel}</span>
          </span>
        )}
      </div>

      <SpecialOrderWarning quote={quote} />

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
      className="inline-flex items-center gap-1.5 rounded-full border border-ink-200 bg-white hover:border-ink-400 hover:bg-ink-50 transition-colors px-2.5 min-h-7 coarse:min-h-9 text-xs ring-1 ring-inset ring-black/5 cursor-pointer"
      title="Vendedor"
    >
      <Briefcase size={12} className="text-ink-400 flex-shrink-0" aria-hidden />
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
    <div className="inline-flex rounded-lg border border-ink-200 overflow-hidden bg-white shadow-xs">
      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        className="px-2.5 min-h-7 coarse:min-h-9 inline-flex items-center text-ink-500 hover:bg-ink-50 hover:text-ink-900 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-150 active:bg-ink-100 active:scale-[0.96]"
        title={`Deshacer (${shortcutLabel('mod+z')})`}
        aria-label="Deshacer"
      >
        <Undo2 size={14} />
      </button>
      <button
        type="button"
        onClick={onRedo}
        disabled={!canRedo}
        className="px-2.5 min-h-7 coarse:min-h-9 inline-flex items-center text-ink-500 hover:bg-ink-50 hover:text-ink-900 border-l border-ink-200 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-150 active:bg-ink-100 active:scale-[0.96]"
        title={`Rehacer (${shortcutLabel('mod+shift+z')})`}
        aria-label="Rehacer"
      >
        <Redo2 size={14} />
      </button>
    </div>
  );
}

function ViewToggle({ view, onChange }) {
  return (
    <div className="inline-flex rounded-lg border border-ink-200 overflow-hidden bg-white shadow-xs">
      <button
        type="button"
        onClick={() => onChange('compose')}
        aria-pressed={view === 'compose'}
        className={`px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 transition-all duration-150 active:scale-[0.97] ${
          view === 'compose'
            ? 'bg-ink-900 text-white shadow-sm'
            : 'text-ink-500 hover:bg-ink-50 hover:text-ink-900'
        }`}
        title="Vista de edición"
      >
        <Pencil size={12} /> Edición
      </button>
      <button
        type="button"
        onClick={() => onChange('client')}
        aria-pressed={view === 'client'}
        className={`px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 transition-all duration-150 border-l border-ink-200 active:scale-[0.97] ${
          view === 'client'
            ? 'bg-brand-grad text-white shadow-glow'
            : 'text-ink-500 hover:bg-ink-50 hover:text-ink-900'
        }`}
        title="Vista del cliente"
      >
        <Eye size={12} /> Cliente
      </button>
    </div>
  );
}
