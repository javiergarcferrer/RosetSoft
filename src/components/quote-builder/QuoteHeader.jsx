import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Eye, Pencil, Download, MoreHorizontal, Command, Loader2 } from 'lucide-react';
import CustomerChip from './CustomerChip.jsx';
import CustomerPicker from './CustomerPicker.jsx';
import OrderChip from './OrderChip.jsx';
import ProfessionalChip from './ProfessionalChip.jsx';
import SaveIndicator from './SaveIndicator.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { shortcutLabel } from '../../lib/useKeyboardShortcut.js';

/**
 * Top of the quote workspace. Title (editable inline), customer chip,
 * container chip, save indicator, view toggle (compose / client preview),
 * and the main actions (open command palette, export PDF, toggle price list).
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
  onExportPdf,
  onUpdateQuote,
  savedAt,
  saving,
  exporting,
}) {
  const customer = quote?.customerId ? customers.find((c) => c.id === quote.customerId) : null;
  // Look up the quote's creator from the AppContext profiles list. The
  // user who clicked "Nueva cotización" has their auth.uid() stamped
  // on the row at materialize time; we show their name as a small
  // "Creada por …" line under the H1 so the dealer reading the page
  // knows whose quote this is. Falls back silently when the field is
  // null (legacy quotes from before user attribution).
  const { profiles: allProfiles } = useApp();
  const creator = quote?.createdByUserId
    ? allProfiles.find((p) => p.id === quote.createdByUserId)
    : null;
  const creatorLabel = creator
    ? (creator.name?.trim() || creator.email?.split('@')[0] || '')
    : '';
  const professional = quote?.professionalId
    ? professionals.find((p) => p.id === quote.professionalId)
    : null;
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="mb-5">
      <Link
        to="/quotes"
        className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 mb-3"
      >
        <ArrowLeft size={12} /> Volver a cotizaciones
      </Link>

      <div className="space-y-3">
        {/* Title row — the quote is identified by its number alone now
            that the internal-name field is gone. The customer chip in
            the meta row below is the human label. */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-500">
              Cotización
            </div>
            <h1 className="mt-0.5 text-[26px] sm:text-[28px] font-semibold tracking-tight leading-tight text-ink-900">
              {quote.number != null ? `#${quote.number}` : 'Borrador'}
            </h1>
            {creatorLabel && (
              <div className="text-[11px] text-ink-500 mt-1">
                Creada por <span className="text-ink-700">{creatorLabel}</span>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap">
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

            <button
              type="button"
              onClick={onExportPdf}
              disabled={exporting}
              // Hidden on phones — the mobile sticky bottom bar carries
              // an equivalent export action so the desktop header
              // doesn't compete for tap space.
              className="btn-primary hidden md:inline-flex disabled:opacity-60 disabled:cursor-wait"
              title="Descargar PDF"
            >
              {exporting ? (
                <><Loader2 size={14} className="animate-spin" /> Generando…</>
              ) : (
                <><Download size={14} /> Exportar PDF</>
              )}
            </button>

            {/* Mobile: condense Export + palette into a single icon-only menu.
                btn-icon is the 44pt-on-coarse, 36pt-on-fine square target. */}
            <button
              type="button"
              onClick={onOpenPalette}
              className="btn-icon sm:hidden"
              aria-label="Acciones"
            >
              <MoreHorizontal size={18} />
            </button>
          </div>
        </div>

        {/* Meta row: customer + professional (+ commission %) + order + save */}
        <div className="flex flex-wrap items-center gap-2">
          <CustomerChip customer={customer} onOpen={() => setPickerOpen(true)} />
          <ProfessionalChip
            quote={quote}
            professional={professional}
            professionals={professionals}
            profileId={profileId}
            onUpdateQuote={onUpdateQuote}
          />
          <OrderChip
            quote={quote}
            profileId={profileId}
            onAttach={(orderId) => onUpdateQuote({ orderId })}
          />
          <div className="flex-1" />
          <SaveIndicator savedAt={savedAt} saving={saving} />
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
