import { useState } from 'react';
import { ChevronDown, UserSquare2 } from 'lucide-react';
import ProfessionalPicker from './ProfessionalPicker.jsx';
import { DebouncedInput } from '../DebouncedInput.jsx';
import { clampCommissionPct, decoratorBilling } from '../../lib/commissions.js';

/**
 * Chip that displays the assigned professional (architect / decorator
 * earning a commission on this sale) and an inline % editor.
 *
 * Visual model:
 *
 *   [ 🟦 Marta López ⌄ │ 12.0 % ]     ← when assigned (segmented)
 *   [ + Asignar profesional ]         ← when unassigned
 *
 * The assigned form is *one unified pill* — a single rounded-full
 * container that holds two segments separated by a thin divider:
 *
 *   • LEFT segment   button → opens ProfessionalPicker
 *     avatar + name + chevron
 *   • RIGHT segment  inline-editable percentage
 *     number input + % suffix
 *
 * Why segmented (this rewrite) vs. two adjacent elements (the prior
 * version): the previous layout rendered the chip and a separate
 * "Comisión [15] %" group as two flex children of the header's
 * meta row. On widths where the row had to flex-wrap, the % input
 * frequently landed on the line below the chip — visually divorced
 * from the professional it controlled, and adjacent to whatever else
 * happened to be on that second row (the OrderChip, the save badge).
 * Merging into one inline-flex group keeps them inseparable: they
 * either both fit on one row or both wrap together.
 *
 * The chip also no longer carries a secondary "15%*" readout next to
 * the name — that was redundant with the editable input one segment
 * over. The asterisk indicator went with it. Whether a value is
 * inherited vs. overridden is communicated by whether the input shows
 * a placeholder (inherited) vs. a typed value (override).
 */
export default function ProfessionalChip({ quote, professional, professionals, profileId, onUpdateQuote }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const assigned = !!quote?.professionalId && !!professional;

  if (!assigned) {
    return (
      <>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-ink-300 px-3 min-h-7 coarse:min-h-9 text-xs text-ink-500 hover:border-ink-500 hover:text-ink-900 transition-colors"
        >
          <UserSquare2 size={12} />
          Asignar profesional
        </button>
        <ProfessionalPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={(id) => onUpdateQuote({ professionalId: id, commissionPct: null })}
          professionals={professionals}
          profileId={profileId}
          currentId={quote?.professionalId}
        />
      </>
    );
  }

  // Override semantics:
  //   • `commissionPct` numeric (including 0) → explicit per-sale override
  //   • `commissionPct` null/'' → inherit professional.defaultCommissionPct
  // We show the override value in the input when present, otherwise an
  // empty field with the inherited default as a placeholder so the
  // dealer can see "what would happen if I do nothing".
  const overrideRaw = quote.commissionPct;
  const hasOverride = overrideRaw != null && overrideRaw !== '';
  const inheritedDefault = professional.defaultCommissionPct ?? 10;

  return (
    <>
      <span
        className="inline-flex items-stretch rounded-full border border-ink-200 bg-white hover:border-ink-400 transition-colors max-w-full min-w-0 text-xs overflow-hidden"
        title={[professional.name, professional.company, professional.email].filter(Boolean).join(' · ')}
      >
        {/* Left segment: avatar + name + chevron, opens the picker.
            Name max-width tracks CustomerChip's exact ladder so the
            two chips truncate at the same point and read as
            same-size pills in the meta row. */}
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="inline-flex items-center gap-2 pl-2 pr-1.5 min-h-7 coarse:min-h-9 hover:bg-ink-50 transition-colors min-w-0"
        >
          <Avatar name={professional.name} />
          <span className="font-medium text-ink-900 truncate max-w-[110px] sm:max-w-[180px] lg:max-w-[220px]">
            {professional.name}
          </span>
          <ChevronDown size={12} className="text-ink-400 flex-shrink-0" />
        </button>

        {/* Divider — same color as the outer border so it reads as a
            seam, not a separate stroke. */}
        <span className="w-px bg-ink-200" aria-hidden />

        {/* Right segment: editable percentage. The label is implicit —
            adjacency to the professional name + the trailing % glyph
            tell the user what they're editing. No "Comisión" prefix.
            Input width tightened (w-7) so the % segment adds the
            smallest possible delta vs. CustomerChip — both pills
            land at near-identical widths for similar-length names. */}
        <label className="inline-flex items-center gap-0.5 pl-1.5 pr-2 min-h-7 coarse:min-h-9 hover:bg-ink-50 transition-colors cursor-text">
          <DebouncedInput
            type="number"
            inputMode="decimal"
            min="0"
            max="20"
            step="0.5"
            value={hasOverride ? overrideRaw : ''}
            onCommit={(v) => {
              if (v == null || v === '') {
                onUpdateQuote({ commissionPct: null });
              } else {
                onUpdateQuote({ commissionPct: clampCommissionPct(v) });
              }
            }}
            placeholder={String(inheritedDefault)}
            aria-label="Comisión (%)"
            className="w-7 text-right tabular-nums bg-transparent border-0 p-0 focus:outline-none focus:ring-0 placeholder:text-ink-400"
          />
          <span className="text-ink-500 select-none" aria-hidden>%</span>
        </label>
      </span>

      <DecoratorBillingChip quote={quote} onUpdateQuote={onUpdateQuote} />

      <ProfessionalPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(id) => {
          // Changing the professional resets the override — the new
          // person's default is the most sensible starting point. If the
          // dealer wants to keep the old %, they'll re-type it.
          onUpdateQuote({ professionalId: id, commissionPct: null });
        }}
        professionals={professionals}
        profileId={profileId}
        currentId={quote.professionalId}
      />
    </>
  );
}

/**
 * How this deal settles the professional's cut — chosen per quote, shown
 * only when a professional is assigned. The SAME % (the segment next door)
 * is realized either as a commission we pay the decorator, or as a trade
 * discount we bill the decorator. INTERNAL ONLY: it never touches the
 * client PDF (the client always sees the full price); it just tells
 * accounting how & whom to invoice. Trade-discount mode tints amber so it
 * reads as the exceptional path at a glance.
 */
function DecoratorBillingChip({ quote, onUpdateQuote }) {
  const mode = decoratorBilling(quote);
  const trade = mode === 'trade_discount';
  return (
    <label
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 min-h-7 coarse:min-h-9 text-xs transition-colors ${
        trade
          ? 'border-amber-300 bg-amber-50 text-amber-800'
          : 'border-ink-200 bg-white text-ink-600 hover:border-ink-400'
      }`}
      title={
        trade
          ? 'Trade discount: se factura al decorador (menos su %), no se paga comisión. No aparece en el PDF del cliente.'
          : 'Comisión: se factura al cliente (precio completo) y se paga la comisión al decorador.'
      }
    >
      <span className="select-none">Facturación</span>
      <select
        value={mode}
        onChange={(e) => onUpdateQuote({ decoratorBilling: e.target.value })}
        className="bg-transparent border-0 p-0 text-xs font-medium focus:outline-none focus:ring-0 cursor-pointer"
        aria-label="Modalidad de facturación con el decorador"
      >
        <option value="commission">Comisión al decorador</option>
        <option value="trade_discount">Trade discount · facturar al decorador</option>
      </select>
    </label>
  );
}

function Avatar({ name }) {
  const initials = (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((n) => n.charAt(0).toUpperCase())
    .join('');
  return (
    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-100 text-amber-700 text-[9px] font-semibold flex-shrink-0">
      {initials || '?'}
    </span>
  );
}
