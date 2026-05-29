export interface SwitchProps {
  /** On/off state — the control is fully controlled by the parent. */
  checked: boolean;
  /** Called with the NEXT state when the user flips it. */
  onChange: (next: boolean) => void;
  /** Accessible name (the control itself carries no visible text). */
  label?: string;
  /** A touch-friendlier size for primary, in-flow toggles. */
  size?: 'sm' | 'md';
  disabled?: boolean;
}

/**
 * A small, accessible on/off toggle (`role="switch"`). Used where a choice is
 * binary and reversible — e.g. the client share link folding an optional
 * add-on in or out. Controlled: the parent owns `checked` and applies the
 * change, this just renders the track + sliding knob.
 *
 * ON reads emerald (the same accent the optionals checklist already used);
 * OFF is a quiet grey. Distinct from `ScopeToggle` (a two-label segmented
 * control) — this is a single binary switch.
 */
export default function Switch({ checked, onChange, label, size = 'md', disabled = false }: SwitchProps) {
  const dims = size === 'sm'
    ? { track: 'h-4 w-7', knob: 'h-3 w-3', on: 'translate-x-3.5', off: 'translate-x-0.5' }
    : { track: 'h-5 w-9', knob: 'h-4 w-4', on: 'translate-x-4', off: 'translate-x-0.5' };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => { if (!disabled) onChange(!checked); }}
      className={`relative inline-flex ${dims.track} flex-shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${
        checked ? 'bg-emerald-600' : 'bg-ink-300'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block ${dims.knob} transform rounded-full bg-white shadow transition-transform ${
          checked ? dims.on : dims.off
        }`}
      />
    </button>
  );
}
