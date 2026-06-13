import type { ReactNode } from 'react';
import { CheckCircle2, Undo2, ChevronRight, Ban } from 'lucide-react';

export interface StageDef {
  key: string;
  label: string;
  description?: string;
  /** Property on `row` that carries the timestamp for this stage. */
  timestampField?: string | null;
}

export interface StepperProps {
  stages: readonly StageDef[];
  currentIndex: number;
  /** The entity row (order or container); used to read per-stage timestamps. */
  row?: Record<string, unknown> | null;
  nextStage?: StageDef | null;
  prevStage?: StageDef | null;
  currentLabel?: ReactNode;
  currentDescription?: ReactNode;
  onAdvance?: (stage: StageDef) => void;
  onUndo?: (stage: StageDef) => void;
  cancelled?: boolean;
}

/** Per-step visual state shared by both track layouts. */
type StepState = {
  isPast: boolean;
  isCurrent: boolean;
  isTerminalCurrent: boolean;
};

/** Dot classes — identical glyph/colour logic for the vertical and horizontal tracks. */
function dotClass({ isPast, isCurrent, isTerminalCurrent }: StepState, cancelled: boolean): string {
  if (cancelled) return 'bg-ink-100 border-ink-200 text-ink-400';
  if (isPast || isTerminalCurrent) return 'bg-brand-500 border-brand-500 text-white';
  if (isCurrent) return 'bg-surface border-brand-500 ring-2 ring-brand-200';
  return 'bg-surface border-ink-200';
}

/** Label colour — current is brand, past is ink-700, future is muted. */
function labelClass({ isPast, isCurrent }: StepState, cancelled: boolean): string {
  if (cancelled) return 'text-ink-400';
  if (isCurrent) return 'text-brand-700';
  if (isPast) return 'text-ink-700';
  return 'text-ink-400';
}

function fmtDate(ts: unknown): string {
  return ts ? new Date(ts as number | string).toLocaleDateString() : '—';
}

/**
 * Progress stepper for the order lifecycle (draft → … → received). It adapts
 * to the viewport: a VERTICAL rail on phones (full labels + dates, nothing
 * truncated) and the classic HORIZONTAL track from `sm` up where there's room
 * for six columns side-by-side.
 *
 * Why two layouts: six Spanish stage labels can't fit across a ~320px phone
 * without truncating to "BORRAD…/COLOCAD…", and a horizontally-scrolled track
 * both hides steps and clips the current dot's focus ring (an `overflow-x`
 * container forces `overflow-y` to clip the box-shadow). Stacking the steps on
 * mobile keeps every label and date legible and the ring intact.
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
}: StepperProps) {
  const lastIdx = stages.length - 1;
  const stepStates: StepState[] = stages.map((_, i) => ({
    isPast: i < currentIndex,
    isCurrent: i === currentIndex,
    isTerminalCurrent: i === currentIndex && i === lastIdx,
  }));
  const tsFor = (s: StageDef): unknown => {
    const r = row as Record<string, unknown> | null | undefined;
    return s.timestampField ? r?.[s.timestampField] : r?.createdAt;
  };
  return (
    <div className="card card-pad space-y-4">
      {/* Phone: vertical rail — full labels + dates, no truncation, no clipped ring. */}
      <ol className="sm:hidden">
        {stages.map((s, i) => {
          const st = stepStates[i];
          const isLast = i === lastIdx;
          // The connector segment below a dot is "done" once we've moved past
          // this step (isPast); otherwise it's the muted track colour.
          const connectorDone = !cancelled && st.isPast;
          return (
            <li key={s.key} className="relative flex gap-3 pb-4 last:pb-0">
              {!isLast && (
                <span
                  className={`absolute left-3 top-6 bottom-0 -translate-x-1/2 w-0.5 ${
                    connectorDone ? 'bg-brand-500' : 'bg-ink-100'
                  }`}
                  aria-hidden="true"
                />
              )}
              <div
                className={`relative z-10 w-6 h-6 shrink-0 rounded-full border-2 flex items-center justify-center ${dotClass(st, cancelled)}`}
              >
                {!cancelled && (st.isPast || st.isTerminalCurrent) && <CheckCircle2 size={12} />}
                {cancelled && st.isCurrent && <Ban size={12} />}
              </div>
              <div className="min-w-0 flex-1 -mt-px flex items-baseline justify-between gap-2">
                <span className={`eyebrow-xs tracking-wide ${labelClass(st, cancelled)}`}>
                  {s.label}
                </span>
                <span className="text-[10px] text-ink-500 tabular-nums shrink-0">
                  {fmtDate(tsFor(s))}
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      {/* sm+: horizontal track — six columns fit, so keep the classic layout.
          The fill width is (currentIndex / lastIdx) so the current dot sits on
          the head of the fill. `pt-1` keeps the focus ring off the card edge. */}
      <div className="relative hidden sm:block pt-1">
        <div className="absolute top-4 left-0 right-0 h-0.5 bg-ink-100" />
        {!cancelled && (
          <div
            className="absolute top-4 left-0 h-0.5 bg-brand-500 transition-all"
            style={{ width: `${Math.max(0, currentIndex / lastIdx) * 100}%` }}
          />
        )}
        <div className="relative flex justify-between gap-1">
          {stages.map((s, i) => {
            const st = stepStates[i];
            return (
              <div key={s.key} className="flex flex-col items-center text-center flex-1 min-w-0">
                <div
                  className={`w-6 h-6 rounded-full border-2 z-10 flex items-center justify-center ${dotClass(st, cancelled)}`}
                >
                  {!cancelled && (st.isPast || st.isTerminalCurrent) && <CheckCircle2 size={12} />}
                  {cancelled && st.isCurrent && <Ban size={12} />}
                </div>
                <div
                  className={`mt-1.5 eyebrow-xs tracking-wide truncate w-full ${labelClass(st, cancelled)}`}
                  title={s.label}
                >
                  {s.label}
                </div>
                <div className="text-[10px] text-ink-500 mt-0.5">{fmtDate(tsFor(s))}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="pt-3 border-t border-ink-100 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="eyebrow tracking-wide">Estado actual</div>
          <div className="font-display text-sm font-semibold mt-0.5">{currentLabel}</div>
          {currentDescription ? (
            <div className="text-xs text-ink-500 mt-1">{currentDescription}</div>
          ) : null}
        </div>
        {!cancelled && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">
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
