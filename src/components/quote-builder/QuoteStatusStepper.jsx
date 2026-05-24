import { useState, useEffect, useRef } from 'react';
import { CheckCircle2, ChevronRight, ChevronDown, Undo2, X, Archive } from 'lucide-react';
import {
  QUOTE_STAGES, QUOTE_STAGE_BY_KEY, QUOTE_TERMINAL_STAGES,
  quoteStageIndex, nextQuoteStage, currentQuoteStage, isTerminalStage,
} from '../../lib/quoteStages.js';

/**
 * The quote lifecycle stepper — same visual language as the container
 * `StageStepper` so the dealer's mental model carries over.
 *
 * Layout: horizontal 3-dot track for the linear path (Borrador → Enviada →
 * Aceptada) with a "Más estados" menu for the terminal alternates (Rechazada,
 * Archivada). Advancing fires the timestamp on the target stage; "Volver"
 * clears it and falls back to the previous stage.
 */
export default function QuoteStatusStepper({ quote, onTransition }) {
  const stage = currentQuoteStage(quote);
  const terminal = isTerminalStage(stage);
  const idx = quoteStageIndex(stage);
  const next = nextQuoteStage(stage);
  const stageDef = QUOTE_STAGE_BY_KEY[stage];

  // If the quote is on a terminal alternate (declined/archived), the linear
  // track is rendered as if it were at the final main stage, but with a
  // visual override so the terminal label shows. This way users in those
  // states still see the journey context.
  const trackIdx = terminal ? QUOTE_STAGES.length - 1 : idx;

  function advance(stageKey) {
    const def = QUOTE_STAGE_BY_KEY[stageKey];
    // Milestone stages (depósito recibido) are backed by their timestamp
    // only, NOT a status value — depositReceivedAt is the single source of
    // truth, shared with the order's deposit milestone. So we stamp the
    // timestamp and leave `status` untouched (the order page writing the
    // same field keeps the two in sync automatically).
    const patch = def.milestone ? {} : { status: stageKey };
    if (def.timestampField) patch[def.timestampField] = Date.now();
    onTransition(patch);
  }

  function undo() {
    if (terminal) {
      // Roll back to 'sent' (or 'draft' if the alt was set before sending).
      const patch = { status: quote.sentAt ? 'sent' : 'draft' };
      if (stageDef.timestampField) patch[stageDef.timestampField] = null;
      onTransition(patch);
      return;
    }
    if (idx <= 0) return;
    const prev = QUOTE_STAGES[idx - 1];
    const patch = { status: prev.key };
    if (stageDef?.timestampField) patch[stageDef.timestampField] = null;
    onTransition(patch);
  }

  return (
    <div className="card card-pad space-y-3">
      {/* Track */}
      <div className="relative">
        <div className="absolute top-3 left-0 right-0 h-0.5 bg-ink-100" />
        <div
          className="absolute top-3 left-0 h-0.5 bg-brand-500 transition-all"
          style={{ width: `${(trackIdx / (QUOTE_STAGES.length - 1)) * 100}%` }}
        />
        <div className="relative flex justify-between gap-1">
          {QUOTE_STAGES.map((s, i) => {
            const isPast = i < trackIdx;
            const isCurrent = i === trackIdx;
            const ts = s.timestampField ? quote?.[s.timestampField] : quote?.createdAt;
            // Override label & color when sitting on a terminal alternate.
            const label = (terminal && isCurrent) ? stageDef.label : s.label;
            const accent = terminal && isCurrent ? 'red' : 'brand';
            const labelMute = terminal && isCurrent ? 'text-red-700' : (isCurrent ? 'text-brand-700' : isPast ? 'text-ink-700' : 'text-ink-400');
            return (
              <div key={s.key} className="flex flex-col items-center text-center flex-1 min-w-0">
                <div
                  className={`w-6 h-6 rounded-full border-2 z-10 flex items-center justify-center
                    ${isPast || (isCurrent && i === QUOTE_STAGES.length - 1)
                      ? (accent === 'red' ? 'bg-red-500 border-red-500 text-white' : 'bg-brand-500 border-brand-500 text-white')
                      : isCurrent
                        ? `bg-white ${accent === 'red' ? 'border-red-500 ring-2 ring-red-200' : 'border-brand-500 ring-2 ring-brand-200'}`
                        : 'bg-white border-ink-200'}`}
                >
                  {(isPast || (isCurrent && i === QUOTE_STAGES.length - 1)) && (
                    accent === 'red' ? <X size={12} /> : <CheckCircle2 size={12} />
                  )}
                </div>
                <div className={`mt-1.5 eyebrow-xs tracking-wide truncate w-full ${labelMute}`} title={label}>
                  {label}
                </div>
                <div className="text-[10px] text-ink-500 mt-0.5">
                  {ts ? new Date(ts).toLocaleDateString('es-DO') : '—'}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Description + actions.
          Stacked on mobile, side-by-side from sm up. The previous
          flex+flex-wrap layout squeezed the description column down
          to ~50px on phones because `min-w-0 flex-1` shrunk before
          the button cluster ever wrapped — long status descriptions
          ("Compartida con el cliente; esperando respuesta") ended up
          breaking word-by-word into a tower. Stacking explicitly
          gives the description full width on phones and avoids the
          collision. */}
      <div className="pt-3 border-t border-ink-100 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 sm:flex-1">
          <div className="eyebrow">Estado</div>
          <div className="text-sm font-semibold mt-0.5">{(terminal ? stageDef.label : QUOTE_STAGE_BY_KEY[stage]?.label) || 'Borrador'}</div>
          <div className="text-xs text-ink-500 mt-1">{(terminal ? stageDef.description : QUOTE_STAGE_BY_KEY[stage]?.description) || ''}</div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
          {(idx > 0 || terminal) && (
            <button
              type="button"
              onClick={undo}
              className="btn text-xs text-ink-700 bg-white border border-ink-200 hover:bg-ink-50 hover:border-ink-300 hover:text-ink-900 active:bg-ink-100 active:border-ink-400"
              title="Revertir al estado anterior"
            >
              <Undo2 size={12} /> Volver
            </button>
          )}
          {!terminal && next && (
            <button
              type="button"
              onClick={() => advance(next.key)}
              className="btn-primary"
              title={`Avanzar a ${next.label}`}
            >
              Marcar {next.label.toLowerCase()} <ChevronRight size={14} />
            </button>
          )}
          {!terminal && !next && (
            <span className="inline-flex items-center gap-1 text-emerald-700 text-sm font-medium">
              <CheckCircle2 size={14} /> {stageDef?.label || 'Listo'}
            </span>
          )}
          <TerminalMenu stage={stage} terminal={terminal} onPick={advance} />
        </div>
      </div>
    </div>
  );
}

function TerminalMenu({ stage, terminal, onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    function onClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn text-xs text-ink-700 bg-white border border-ink-200 hover:bg-ink-50 hover:border-ink-300 hover:text-ink-900 active:bg-ink-100 active:border-ink-400"
      >
        Más <ChevronDown size={12} />
      </button>
      {open && (
        <div className="absolute right-0 mt-1.5 w-48 rounded-md border border-ink-200 bg-white shadow-pop py-1 z-30">
          {QUOTE_TERMINAL_STAGES.map((t) => (
            <button
              key={t.key}
              type="button"
              disabled={t.key === stage}
              onClick={() => { onPick(t.key); setOpen(false); }}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-ink-50 disabled:text-ink-300 disabled:bg-ink-50 inline-flex items-center gap-2"
            >
              {t.key === 'declined' ? <X size={13} className="text-red-500" /> : <Archive size={13} className="text-ink-500" />}
              Marcar {t.label.toLowerCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
