import { useState } from 'react';
import { DraftingCompass } from 'lucide-react';
import ProfessionalPicker from './ProfessionalPicker.jsx';

/**
 * The professional (architect / decorator earning a commission on this sale)
 * and the order type that sets their commission tier, fused into ONE segmented
 * pill.
 *
 * Visual model:
 *
 *   assigned:    [ 📐 Pilar Ferrer │ Piso · Especial ]
 *   unassigned:  [ 📐 Asignar profesional │ Piso · Especial ]
 *
 * Why one pill: the order type (Piso 15% / Especial 20%) IS the professional's
 * commission rate, so "who earns" and "at what tier" read as one decision in
 * one control that wraps as a unit, not chips that drift onto separate rows.
 *
 * The resulting rate isn't shown in the pill (the tier tooltip names it, and
 * the totals dock's commission card spells out the amount) — the pill stays a
 * clean identity + tier selector.
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
        <span className={`${PILL} border-dashed hover:border-amber-400 hover:bg-amber-50/50 dark:hover:bg-amber-400/10`}>
          <button type="button" onClick={openPicker} className={`${SEG} text-ink-500 hover:text-amber-700 dark:hover:text-amber-300 pl-3 pr-2.5`}>
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
          <span className="font-display font-semibold text-ink-900 truncate max-w-[110px] sm:max-w-[170px] lg:max-w-[210px]">
            {professional.name}
          </span>
        </button>

        <Seam />
        <TierSegments quote={quote} onUpdateQuote={onUpdateQuote} />
      </span>

      {picker}
    </>
  );
}

/* The outer pill: one rounded-full segmented container shared by both states. */
const PILL =
  'inline-flex items-stretch rounded-full border border-ink-200 bg-surface hover:border-ink-400 ' +
  'transition-all max-w-full min-w-0 text-xs overflow-hidden ring-1 ring-inset ring-black/5';

/* A segment: full-height flex cell with consistent touch height + feedback. */
const SEG =
  'inline-flex items-center gap-1.5 min-h-6 coarse:min-h-9 transition-all ' +
  'hover:bg-ink-50 active:bg-ink-100 active:scale-[0.98] focus-visible:outline-none focus-visible:bg-ink-100';

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
            className={`px-2 min-h-6 coarse:min-h-9 inline-flex items-center font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500/50 ${
              i > 0 ? 'border-l border-ink-200' : ''
            } ${
              active
                ? 'bg-amber-600 text-white'
                : 'text-ink-500 hover:text-ink-800 hover:bg-ink-500/10'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </span>
  );
}

