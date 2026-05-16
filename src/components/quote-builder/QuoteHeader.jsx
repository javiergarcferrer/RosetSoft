import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BookOpen, X, Eye, Pencil, Download, MoreHorizontal, Command } from 'lucide-react';
import { DebouncedInput } from '../DebouncedInput.jsx';
import CustomerChip from './CustomerChip.jsx';
import CustomerPicker from './CustomerPicker.jsx';
import ContainerChip from './ContainerChip.jsx';
import SaveIndicator from './SaveIndicator.jsx';
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
  profileId,
  view,
  onViewChange,
  pdfOpen,
  onTogglePdf,
  hasPdf,
  onOpenPalette,
  onExportPdf,
  onUpdateQuote,
  savedAt,
  saving,
}) {
  const customer = quote?.customerId ? customers.find((c) => c.id === quote.customerId) : null;
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
        {/* Title row */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-500">
              {quote.number != null ? `Cotización #${quote.number}` : 'Cotización (borrador)'}
            </div>
            <div className="mt-0.5">
              <DebouncedInput
                value={quote.name || ''}
                onCommit={(v) => onUpdateQuote({ name: v })}
                placeholder='Nombre interno · p. ej. "Residencia Smith — sala"'
                className="block w-full bg-transparent border-0 px-0 py-0 text-[26px] sm:text-[28px] font-semibold tracking-tight leading-tight text-ink-900 placeholder:text-ink-300 focus:outline-none focus:ring-0"
              />
            </div>
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

            {hasPdf && (
              <button
                type="button"
                onClick={onTogglePdf}
                className={`btn-ghost hidden lg:inline-flex ${pdfOpen ? 'bg-ink-100' : ''}`}
                title={pdfOpen ? 'Ocultar lista de precios' : 'Mostrar lista de precios'}
              >
                {pdfOpen ? <><X size={14} /> Ocultar PDF</> : <><BookOpen size={14} /> Lista de precios</>}
              </button>
            )}

            <button
              type="button"
              onClick={onExportPdf}
              className="btn-primary hidden md:inline-flex"
              title="Descargar PDF"
            >
              <Download size={14} /> Exportar PDF
            </button>

            {/* Mobile: condense Export + palette into a single menu */}
            <button
              type="button"
              onClick={onOpenPalette}
              className="btn-ghost sm:hidden p-2"
              aria-label="Acciones"
            >
              <MoreHorizontal size={16} />
            </button>
          </div>
        </div>

        {/* Meta row: customer + container + save indicator */}
        <div className="flex flex-wrap items-center gap-2">
          <CustomerChip customer={customer} onOpen={() => setPickerOpen(true)} />
          <ContainerChip
            profileId={profileId}
            containerId={quote.containerId}
            onChange={(id) => onUpdateQuote({ containerId: id })}
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
