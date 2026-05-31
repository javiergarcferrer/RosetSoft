import { useState } from 'react';
import { DraftingCompass } from 'lucide-react';
import ProfessionalPicker from './ProfessionalPicker.jsx';
import { DebouncedInput } from '../DebouncedInput.jsx';
import { clampCommissionPct, baseCommissionPct } from '../../lib/commissions.js';

/**
 * The professional (architect / decorator earning a commission on this sale)
 * and the controls that define that commission, fused into ONE segmented pill.
 *
 * Visual model:
 *
 *   assigned:    [ 📐 Pilar Ferrer │ Piso · Especial │ 15.0 % ]
 *   unassigned:  [ 📐 Asignar profesional │ Piso · Especial ]
 *
 * Why everything in one pill: the order type (Piso 15% / Especial 20%) is the
 * professional's base commission rate, and the % segment is the per-quote
 * override of that same rate. They're three views of one decision — who earns,
 * at what tier, with what override — so they live in one inseparable control
 * that wraps as a unit instead of three chips that drift onto different rows.
 *
 * Reductive on purpose: the tier segments no longer repeat "15% / 20%" inline,
 * because the % segment right beside them already shows the live rate (the
 * tier's base as a placeholder, or the typed override). One number, one place.
 */
export default function ProfessionalChip({ quote, professional, professionals, profileId, onUpdateQuote }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const assigned = !!quote?.professionalId && !!professional;
  const openPicker = () => setPickerOpen(true);

  const picker = (
    <ProfessionalPicker
      open={pickerOpen}
      onClose={() => setPickerOpen(false)}
      onSelect={(id) => onUpdateQuote({ professionalId: id, commissionPct: null })}
      professionals={professionals}
      profileId={profileId}
      currentId={quote?.professionalId}
    />
  );

  if (!assigned) {
    return (
      <>
        <span className={PILL}>
          <button type="button" onClick={openPicker} className={`${SEG} text-ink-500 hover:text-ink-900 pl-3 pr-2.5`}>
            <DraftingCompass size={12} />
            Asignar profesional
          </button>
          <Seam />
          <TierSegments quote={quote} onUpdateQuote={onUpdateQuote} />
        </span>
        {picker}
      </>
    );
  }

  // Override semantics:
  //   • `commissionPct` numeric (including 0) → explicit per-sale override
  //   • `commissionPct` null/'' → inherit the order-type base rate
  // The input shows the override when present, otherwise an empty field with
  // the inherited base as a placeholder ("what happens if I do nothing").
  const overrideRaw = quote.commissionPct;
  const hasOverride = overrideRaw != null && overrideRaw !== '';
  const inheritedDefault = baseCommissionPct(quote);

  return (
    <>
      <span
        className={PILL}
        title={[professional.name, professional.company, professional.email].filter(Boolean).join(' · ')}
      >
        {/* Professional — icon + name, opens the picker. No chevron: it's a
            picker, not a link, and the team knows the chip opens. */}
        <button type="button" onClick={openPicker} className={`${SEG} pl-2.5 pr-2 min-w-0`}>
          <DraftingCompass size={12} className="text-amber-600 flex-shrink-0" />
          <span className="font-medium text-ink-900 truncate max-w-[150px] sm:max-w-[170px] lg:max-w-[210px]">
            {professional.name}
          </span>
        </button>

        <Seam />
        <TierSegments quote={quote} onUpdateQuote={onUpdateQuote} />
        <Seam />

        {/* Commission % — editable override of the tier's base rate. */}
        <label className={`${SEG} pl-1.5 pr-2 cursor-text`}>
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

      {picker}
    </>
  );
}

/* The outer pill: one rounded-full segmented container shared by both states. */
const PILL =
  'inline-flex items-stretch rounded-full border border-ink-200 bg-white hover:border-ink-400 ' +
  'transition-colors max-w-full min-w-0 text-xs overflow-hidden';

/* A segment: full-height flex cell with consistent touch height + feedback. */
const SEG =
  'inline-flex items-center gap-1.5 min-h-7 coarse:min-h-9 transition-colors ' +
  'hover:bg-ink-50 active:bg-ink-100 focus-visible:outline-none focus-visible:bg-ink-100';

/* A hairline seam between segments — same colour as the border so it reads as
   a fold in one pill, not a separate stroke. */
function Seam() {
  return <span className="w-px bg-ink-200 self-stretch flex-shrink-0" aria-hidden />;
}

/**
 * Piso / Especial — the order type, which sets the professional's base
 * commission tier. Rendered as two seam-separated segments INSIDE the pill, so
 * the tier reads as part of the same control as the name and the %. Labels are
 * intentionally bare (no inline %) — the live rate lives in the % segment.
 */
function TierSegments({ quote, onUpdateQuote }) {
  const type = quote?.orderType === 'special' ? 'special' : 'floor';
  const options = [
    { value: 'floor', label: 'Piso' },
    { value: 'special', label: 'Especial' },
  ];
  return (
    <span className="inline-flex items-stretch" role="group" aria-label="Tipo de orden">
      {options.map((opt, i) => {
        const active = type === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onUpdateQuote({ orderType: opt.value })}
            aria-pressed={active}
            title={
              opt.value === 'floor'
                ? 'Piso — comisión base del profesional al 15%'
                : 'Especial — comisión base del profesional al 20%'
            }
            className={`px-2.5 min-h-7 coarse:min-h-9 inline-flex items-center font-medium transition-colors focus-visible:outline-none ${
              i > 0 ? 'border-l border-ink-200' : ''
            } ${
              active
                ? 'bg-ink-900 text-white'
                : 'text-ink-600 hover:bg-ink-50 active:bg-ink-100 focus-visible:bg-ink-100'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </span>
  );
}

