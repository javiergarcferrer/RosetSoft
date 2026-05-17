import { CheckCircle2, Undo2, ChevronRight, Ban } from 'lucide-react';

/**
 * Horizontal progress stepper. Both the order lifecycle and the container
 * pipeline render with this — they're the same visual shape (linear
 * progression with per-step timestamps), just different stage tables.
 *
 * Props:
 *   stages           : array of { key, label, description, timestampField }
 *   currentIndex     : 0-based index of the current stage in `stages`
 *                      (cancelled/terminal off-track use -1)
 *   row              : the entity row (order or container); used to read
 *                      `row[stage.timestampField]` for each step's date
 *   nextStage        : the next main-track stage, or null at the end
 *   prevStage        : the previous main-track stage, or null at the start
 *   currentLabel     : label of the currently active stage (for the
 *                      "Estado actual" footer)
 *   currentDescription : longer copy under the footer label
 *   onAdvance        : called with the next stage def; renders an "Advance"
 *                      button only when present
 *   onUndo           : called with the stage being undone; renders a "Volver"
 *                      button when prevStage is set
 *   cancelled        : true if the row is on the cancelled terminal — flips
 *                      the entire track to a quiet grey + shows a ban glyph
 *
 * The stepper is purely presentational — it doesn't know about Orders or
 * Containers, so adding a new lifecycle elsewhere in the app (e.g. a
 * customer-onboarding flow) is a question of declaring its stage table
 * and rendering this component with the right indices.
 */
export default function Stepper({
  stages,
  currentIndex,
  row,
  nextStage,
  prevStage,
  currentLabel,
  currentDescription,
  onAdvance,
  onUndo,
  cancelled = false,
}) {
  const lastIdx = stages.length - 1;
  return (
    <div className="card card-pad space-y-4">
      <div className="relative">
        {/* Background track + filled-portion track. The filled width is
            (currentIndex / lastIdx) so the dot of the current stage sits
            on top of the head of the fill. */}
        <div className="absolute top-3 left-0 right-0 h-0.5 bg-ink-100" />
        {!cancelled && (
          <div
            className="absolute top-3 left-0 h-0.5 bg-brand-500 transition-all"
            style={{ width: `${Math.max(0, currentIndex / lastIdx) * 100}%` }}
          />
        )}
        <div className="relative flex justify-between gap-1">
          {stages.map((s, i) => {
            const ts = s.timestampField ? row?.[s.timestampField] : row?.createdAt;
            const isPast = i < currentIndex;
            const isCurrent = i === currentIndex;
            const isTerminalCurrent = isCurrent && i === lastIdx;
            return (
              <div key={s.key} className="flex flex-col items-center text-center flex-1 min-w-0">
                <div
                  className={`w-6 h-6 rounded-full border-2 z-10 flex items-center justify-center ${
                    cancelled
                      ? 'bg-ink-100 border-ink-200 text-ink-400'
                      : isPast || isTerminalCurrent
                        ? 'bg-brand-500 border-brand-500 text-white'
                        : isCurrent
                          ? 'bg-white border-brand-500 ring-2 ring-brand-200'
                          : 'bg-white border-ink-200'
                  }`}
                >
                  {!cancelled && (isPast || isTerminalCurrent) && <CheckCircle2 size={12} />}
                  {cancelled && i === currentIndex && <Ban size={12} />}
                </div>
                <div
                  className={`mt-1.5 text-[10px] font-semibold uppercase tracking-wide truncate w-full ${
                    cancelled
                      ? 'text-ink-400'
                      : isCurrent
                        ? 'text-brand-700'
                        : isPast
                          ? 'text-ink-700'
                          : 'text-ink-400'
                  }`}
                  title={s.label}
                >
                  {s.label}
                </div>
                <div className="text-[10px] text-ink-500 mt-0.5">
                  {ts ? new Date(ts).toLocaleDateString() : '—'}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="pt-3 border-t border-ink-100 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-500">Estado actual</div>
          <div className="text-sm font-semibold mt-0.5">{currentLabel}</div>
          {currentDescription ? (
            <div className="text-xs text-ink-500 mt-1">{currentDescription}</div>
          ) : null}
        </div>
        {!cancelled && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {prevStage && onUndo && (
              <button
                onClick={() => {
                  if (confirm(`Regresar a ${prevStage.label}?`)) onUndo(prevStage);
                }}
                className="btn-ghost text-xs"
                title="Volver al paso anterior"
              >
                <Undo2 size={12} /> Volver
              </button>
            )}
            {nextStage && onAdvance && (
              <button
                onClick={() => {
                  if (confirm(`Avanzar a ${nextStage.label}? Esto registra la transición con la fecha de hoy.`)) {
                    onAdvance(nextStage);
                  }
                }}
                className="btn-primary"
              >
                Avanzar a {nextStage.label} <ChevronRight size={14} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
