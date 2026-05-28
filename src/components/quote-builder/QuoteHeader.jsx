import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Eye, Pencil, MoreHorizontal, Command, Undo2, Redo2 } from 'lucide-react';
import CustomerChip from './CustomerChip.jsx';
import CustomerPicker from './CustomerPicker.jsx';
import OrderChip from './OrderChip.jsx';
import ProfessionalChip from './ProfessionalChip.jsx';
import SaveIndicator from './SaveIndicator.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { shortcutLabel } from '../../lib/useKeyboardShortcut.js';
import { FLOOR_COMMISSION_PCT, SPECIAL_COMMISSION_PCT } from '../../lib/commissions.js';

/**
 * Top of the quote workspace. Title (editable inline), customer chip,
 * container chip, save indicator, view toggle (compose / client preview),
 * undo/redo and the command palette. Export PDF and Share moved to the
 * persistent bottom totals dock so they're always reachable.
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
  onOpenPalette,
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
      <Link to="/quotes" className="back-link">
        <ArrowLeft size={12} /> Volver a cotizaciones
      </Link>

      <div className="space-y-3">
        {/* Title (left) and actions (right) on one row that WRAPS rather
            than overlaps. The earlier flex-1 + nowrap split let a wide
            actions cluster shrink the title column to zero width, so the
            opaque buttons painted over the number. Here the title keeps its
            intrinsic min-width (the number is never clipped) and the actions
            drop onto their own line when they can't fit beside it. On phones
            the column layout stacks them; the SaveIndicator rides inline with
            the eyebrow as the number's status line and truncates if cramped. */}
        <div className="flex flex-col gap-x-4 gap-y-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
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
              cluster drops below the title when the row is too tight. */}
          <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
            <UndoRedo
              onUndo={onUndo}
              onRedo={onRedo}
              canUndo={canUndo}
              canRedo={canRedo}
            />

            <button
              type="button"
              onClick={onOpenPalette}
              className="btn-ghost text-xs hidden sm:inline-flex"
              title="Acciones rápidas"
            >
              <Command size={12} />
              <span className="hidden md:inline">Acciones</span>
              <kbd className="kbd ml-1">{shortcutLabel('mod+k')}</kbd>
            </button>

            <ViewToggle view={view} onChange={onViewChange} />

            {/* Mobile: condense Export + palette into a single icon-only menu.
                btn-icon is the 44pt-on-coarse, 36pt-on-fine square target.
                Pushed to the right edge of the stacked actions row. */}
            <button
              type="button"
              onClick={onOpenPalette}
              className="btn-icon sm:hidden ml-auto"
              aria-label="Acciones"
            >
              <MoreHorizontal size={18} />
            </button>
          </div>
        </div>

        {/* Meta row: vendor (admin-editable) + customer + professional
            + order, in one horizontal group. Wraps naturally when the
            chips don't all fit on a single line. We deliberately kept
            the chips compact (short labels, narrow name max-widths)
            so on most phone widths they sit on one row instead of
            wrapping — "Pedido" lands next to the customer name where
            it belongs visually, with the professional chip alongside. */}
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Datos de la cotización"
        >
          {isAdmin && (
            <SellerSelect
              quote={quote}
              assignableSellers={assignableSellers}
              onUpdateQuote={onUpdateQuote}
            />
          )}
          <CustomerChip customer={customer} onOpen={() => setPickerOpen(true)} />
          <ProfessionalChip
            quote={quote}
            professional={professional}
            professionals={professionals}
            profileId={profileId}
            onUpdateQuote={onUpdateQuote}
          />
          <OrderTypeChip quote={quote} onUpdateQuote={onUpdateQuote} />
          <OrderChip
            quote={quote}
            profileId={profileId}
            onAttach={(orderId) => onUpdateQuote({ orderId })}
          />
        </div>
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
 * Compact "Vendedor" select rendered as a chip in the meta row so it
 * sits adjacent to the customer, professional, and order chips
 * instead of getting its own row above. Visually matches the chip
 * vocabulary (rounded, ink-200 border, hover state) so the eye reads
 * the row as a single horizontal group.
 *
 * The blank option lets an admin explicitly null out attribution for
 * training / sandbox quotes. Inactive sellers stay listed only when
 * they're the current attribution so the row labels itself honestly
 * — picking someone else effectively "unassigns" the inactive one.
 */
function SellerSelect({ quote, assignableSellers, onUpdateQuote }) {
  return (
    <label className="inline-flex items-center gap-1.5 rounded-full border border-ink-200 bg-white hover:border-ink-400 transition-colors px-2.5 min-h-7 coarse:min-h-9 text-xs">
      <span className="text-ink-500 select-none">Vendedor</span>
      <select
        value={quote?.createdByUserId || ''}
        onChange={(e) => onUpdateQuote({ createdByUserId: e.target.value || null })}
        className="bg-transparent border-0 p-0 text-xs text-ink-900 font-medium focus:outline-none focus:ring-0 cursor-pointer max-w-[110px] sm:max-w-[180px] lg:max-w-[220px] truncate"
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
 * Floor vs special order toggle. Sets `quote.orderType`, which drives the
 * assigned professional's base commission rate (floor 15% / special 20%).
 * Always shown — it classifies the sale even before a professional is
 * assigned — and styled as a compact segmented pill matching the other
 * chips in the meta row.
 */
function OrderTypeChip({ quote, onUpdateQuote }) {
  const type = quote?.orderType === 'special' ? 'special' : 'floor';
  const options = [
    { value: 'floor', label: 'Piso', pct: FLOOR_COMMISSION_PCT },
    { value: 'special', label: 'Especial', pct: SPECIAL_COMMISSION_PCT },
  ];
  return (
    <span
      className="inline-flex items-stretch rounded-full border border-ink-200 bg-white overflow-hidden text-xs"
      role="group"
      aria-label="Tipo de orden"
      title="Tipo de orden — define la comisión base del profesional (Piso 15% / Especial 20%)"
    >
      {options.map((opt) => {
        const active = type === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onUpdateQuote({ orderType: opt.value })}
            aria-pressed={active}
            className={`inline-flex items-center gap-1 px-2.5 min-h-7 coarse:min-h-9 font-medium transition-colors ${
              active ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
            }`}
          >
            {opt.label}
            <span className={active ? 'text-white/70' : 'text-ink-400'}>{opt.pct}%</span>
          </button>
        );
      })}
    </span>
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

function ViewToggle({ view, onChange }) {
  return (
    <div className="inline-flex rounded-md border border-ink-200 overflow-hidden bg-white">
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
