import { useState, useEffect, useRef } from 'react';
import { Check, CheckCircle2, ChevronRight, ChevronDown, Undo2, X, Archive } from 'lucide-react';
import {
  QUOTE_STAGES, QUOTE_STAGE_BY_KEY, QUOTE_TERMINAL_STAGES,
  quoteStageIndex, nextQuoteStage, currentQuoteStage, isTerminalStage,
} from '../../lib/quoteStages.js';
import OrderChip from './OrderChip.jsx';

/**
 * The quote lifecycle stepper — same visual language as the container
 * `StageStepper` so the dealer's mental model carries over.
 *
 * Layout: horizontal 3-dot track for the linear path (Borrador → Enviada →
 * Aceptada) with a "Más estados" menu for the terminal alternates (Rechazada,
 * Archivada). Advancing fires the timestamp on the target stage; "Volver"
 * clears it and falls back to the previous stage.
 */
export default function QuoteStatusStepper({ quote, onTransition, profileId, onAttachOrder }) {
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

  // Rail geometry. Dots sit at the centre of their equal-width columns, i.e.
  // at (i+0.5)/N across the row — NOT at 0/…/100%. So inset the rail by half a
  // column (`edge`) on each side to run exactly first-dot-centre → last-dot-
  // centre (no poke-out past the ends), and size the fill as a fraction of
  // that span so its head lands precisely on the active dot.
  const stepCount = QUOTE_STAGES.length;
  const edge = 50 / stepCount;
  const fillPct = stepCount > 1 ? (trackIdx / (stepCount - 1)) * 100 : 0;

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
    <div className="card card-pad space-y-4">
      {/* ── Progress track ──────────────────────────────────────────────
          A single rounded rail with an animated brand fill plus the step
          dots. Both share this one relative box so the rail's percentage
          insets line up with the dot columns below. */}
      <div className="relative" role="list" aria-label="Progreso de la cotización">
        {/* Rail: inset to the first/last dot centres so it never pokes past
            the end dots; overflow-hidden + rounded clips the fill cleanly. */}
        <div
          className="absolute top-[13px] h-1.5 rounded-full bg-ink-100 overflow-hidden"
          style={{ left: `${edge}%`, right: `${edge}%` }}
        >
          <div
            className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out
              ${terminal ? 'bg-gradient-to-r from-red-400 to-red-500' : 'bg-gradient-to-r from-brand-400 to-brand-500'}`}
            style={{ width: `${fillPct}%` }}
          />
        </div>

        {/* Dots + labels. Deliberately NO overflow-x box here — an `overflow-x`
            container forces `overflow-y` to clip too, which would shear the
            active dot's ring/halo. Four columns always fit; long labels wrap
            to two reserved lines so the date row stays aligned. */}
        <div className="relative flex justify-between gap-1">
          {QUOTE_STAGES.map((s, i) => {
            const isPast = i < trackIdx;
            const isCurrent = i === trackIdx;
            const isLast = i === stepCount - 1;
            // Reaching the final stage reads as "done" (filled + check), not an
            // in-progress ring.
            const isDone = isPast || (isCurrent && isLast);
            // On a terminal alternate the current (last) dot turns red with an X.
            const isTermCur = terminal && isCurrent;
            const ts = s.timestampField ? quote?.[s.timestampField] : quote?.createdAt;
            const label = isTermCur ? stageDef.label : s.label;
            const labelCls = isTermCur
              ? 'text-red-600 font-bold'
              : isCurrent
                ? 'text-brand-700 font-bold'
                : isPast
                  ? 'text-ink-700 font-semibold'
                  : 'text-ink-400 font-medium';
            return (
              <div
                key={s.key}
                role="listitem"
                aria-current={isCurrent ? 'step' : undefined}
                className="relative z-10 flex flex-col items-center text-center flex-1 basis-0 min-w-0 px-0.5"
              >
                {/* Dot */}
                <span className="relative grid place-items-center w-7 h-7">
                  {/* Soft live glow on the active (still-pending) step. */}
                  {isCurrent && !isDone && (
                    <span
                      className={`absolute -inset-1 rounded-full animate-pulse ${isTermCur ? 'bg-red-400/25' : 'bg-brand-400/25'}`}
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className={`relative w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all duration-300
                      ${isDone
                        ? isTermCur
                          ? 'bg-red-500 border-red-500 text-white shadow-sm shadow-red-500/30'
                          : 'bg-brand-500 border-brand-500 text-white shadow-sm shadow-brand-500/30'
                        : isCurrent
                          ? isTermCur
                            ? 'bg-surface border-red-500 ring-4 ring-red-100'
                            : 'bg-surface border-brand-500 ring-4 ring-brand-100'
                          : 'bg-surface border-ink-200'}`}
                  >
                    {isDone ? (
                      isTermCur ? <X size={14} strokeWidth={3} /> : <Check size={14} strokeWidth={3} />
                    ) : isCurrent ? (
                      <span className={`w-2 h-2 rounded-full ${isTermCur ? 'bg-red-500' : 'bg-brand-500'}`} />
                    ) : (
                      <span className="w-1.5 h-1.5 rounded-full bg-ink-200" />
                    )}
                  </span>
                </span>

                {/* Label — reserves two lines so the date row never jitters
                    when "Depósito recibido" wraps. */}
                <span
                  className={`mt-2.5 flex w-full items-start justify-center min-h-[2.5em] eyebrow-xs tracking-wide leading-tight ${labelCls}`}
                  title={label}
                >
                  {label}
                </span>

                {/* Date — hidden on the smallest phones to save vertical space. */}
                <span className="text-[10px] text-ink-400 -mt-1 tabular-nums hidden sm:block">
                  {ts ? new Date(ts).toLocaleDateString('es-DO') : '—'}
                </span>
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
          <div className="eyebrow text-brand-600">Estado</div>
          {/* Status label + the order pill to its right (renders nothing until
              the quote is accepted — then "Agregar a pedido" / "Pedido #…"). */}
          <div className="flex items-center gap-2 flex-wrap mt-0.5">
            <div className="font-display text-sm font-bold text-ink-900">{(terminal ? stageDef.label : QUOTE_STAGE_BY_KEY[stage]?.label) || 'Borrador'}</div>
            <OrderChip quote={quote} profileId={profileId} onAttach={onAttachOrder} inline />
          </div>
          <div className="text-xs text-ink-500 mt-1 leading-relaxed">{(terminal ? stageDef.description : QUOTE_STAGE_BY_KEY[stage]?.description) || ''}</div>
        </div>
        {/* Primary CTA on its own row on mobile (full-width, prominent), with
            the secondary choices (Volver + Más) sharing the row below so they
            distribute evenly instead of wrapping one-per-line. From sm up the
            whole cluster collapses back into a right-aligned button row. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
          {!terminal && next && (
            <button
              type="button"
              onClick={() => advance(next.key)}
              className="btn-primary active:scale-[0.98] w-full sm:w-auto justify-center whitespace-nowrap"
              title={`Avanzar a ${next.label}`}
            >
              {next.key === 'deposito_recibido' ? 'Registrar depósito' : `Marcar ${next.label.toLowerCase()}`}
              <ChevronRight size={14} />
            </button>
          )}
          {!terminal && !next && (
            <span className="inline-flex items-center justify-center gap-1.5 text-emerald-700 text-sm font-semibold bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1 w-full sm:w-auto">
              <CheckCircle2 size={14} /> {stageDef?.label || 'Listo'}
            </span>
          )}
          <div className="flex items-center gap-2">
            {(idx > 0 || terminal) && (
              <button
                type="button"
                onClick={undo}
                className="btn-secondary text-xs flex-1 sm:flex-none justify-center"
                title="Revertir al estado anterior"
              >
                <Undo2 size={12} /> Volver
              </button>
            )}
            <TerminalMenu stage={stage} terminal={terminal} onPick={advance} />
          </div>
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
    <div className="relative flex-1 sm:flex-none" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn-secondary text-xs w-full justify-center"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        Más <ChevronDown size={12} className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        // Opens upward so the menu never collides with the bottom nav bar on
        // phones (the stepper sits low on the screen).
        <div className="absolute right-0 bottom-full mb-1.5 w-52 max-w-[calc(100vw-1rem)] rounded-lg border border-ink-200 bg-surface shadow-pop py-1 z-30 overflow-hidden" role="menu">
          {QUOTE_TERMINAL_STAGES.map((t) => (
            <button
              key={t.key}
              type="button"
              role="menuitem"
              disabled={t.key === stage}
              onClick={() => { onPick(t.key); setOpen(false); }}
              className="w-full text-left px-3 py-2 coarse:min-h-11 text-sm hover:bg-ink-50 active:bg-ink-100 disabled:text-ink-300 disabled:bg-ink-50 disabled:cursor-default inline-flex items-center gap-2 transition-colors"
            >
              {t.key === 'declined' ? <X size={13} className="text-red-400 flex-shrink-0" /> : <Archive size={13} className="text-ink-400 flex-shrink-0" />}
              Marcar {t.label.toLowerCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
