import { useState } from 'react';
import { ChevronDown, UserSquare2 } from 'lucide-react';
import ProfessionalPicker from './ProfessionalPicker.jsx';
import { DebouncedInput } from '../DebouncedInput.jsx';
import { effectiveCommissionPct, clampCommissionPct } from '../../lib/commissions.js';

/**
 * Chip that displays the assigned professional (architect / decorator
 * earning a commission on this sale) and an inline % override input.
 *
 * Visual model:
 *
 *   [ 🟦 Marta López ⌄ ]  [ 12 % ]   ← when assigned
 *   [ + Asignar profesional ]        ← when unassigned
 *
 * Why a separate component from CustomerChip even though they look
 * similar: the customer relationship is *who the quote belongs to* —
 * one-to-one, mandatory for shipping. The professional relationship is
 * a *referral* that may not exist on most quotes, and when it does it
 * carries the extra commission % field. Keeping them separate makes
 * each role clear in the header.
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
          className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-ink-300 px-3 py-1 text-xs text-ink-500 hover:border-ink-500 hover:text-ink-900 transition-colors"
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

  // The effective % drives the chip's display so it always reflects
  // what the dealer will actually pay out. The little input below
  // it sets the *override*; placeholder shows the inherited default
  // when the override is empty so the dealer knows what they're
  // diverging from.
  const effective = effectiveCommissionPct(quote, professional);
  const overrideRaw = quote.commissionPct;
  const hasOverride = overrideRaw != null && overrideRaw !== '';

  return (
    <>
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="inline-flex items-center gap-2 rounded-full border border-ink-200 bg-white px-2 py-1 pr-2.5 text-xs hover:border-ink-400 hover:bg-ink-50 transition-colors max-w-full min-w-0"
        title={[professional.name, professional.company, professional.email].filter(Boolean).join(' · ')}
      >
        <Avatar name={professional.name} />
        <span className="min-w-0 inline-flex items-baseline gap-1.5 max-w-[260px]">
          <span className="font-medium text-ink-900 truncate">{professional.name}</span>
          <span className="text-ink-500 text-[10px] tabular-nums whitespace-nowrap">
            {effective}%{hasOverride ? '*' : ''}
          </span>
        </span>
        <ChevronDown size={12} className="text-ink-400 flex-shrink-0" />
      </button>

      {/* Per-sale override. Blank means "inherit professional.defaultCommissionPct".
          0 means "explicitly zero for this deal" (handled by effectiveCommissionPct
          treating 0 as a real value). */}
      <div className="inline-flex items-center gap-1 text-xs">
        <span className="text-ink-500">Comisión</span>
        <div className="relative">
          <DebouncedInput
            type="number"
            inputMode="decimal"
            min="0"
            max="20"
            step="0.5"
            value={hasOverride ? overrideRaw : ''}
            onCommit={(v) => {
              // Treat empty as "remove override" so display falls back
              // to professional.defaultCommissionPct. Anything else
              // gets clamped before storing — defense against pasting
              // 50 from a spreadsheet, etc.
              if (v == null || v === '') {
                onUpdateQuote({ commissionPct: null });
              } else {
                onUpdateQuote({ commissionPct: clampCommissionPct(v) });
              }
            }}
            placeholder={String(professional.defaultCommissionPct ?? 10)}
            className="input h-7 w-14 pr-5 text-xs tabular-nums"
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-ink-500 pointer-events-none">%</span>
        </div>
      </div>

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
