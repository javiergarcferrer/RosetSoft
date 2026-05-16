import { Minus, Plus } from 'lucide-react';
import { DebouncedInput } from '../DebouncedInput.jsx';

export default function QtyStepper({ value, onChange }) {
  return (
    <div className="inline-flex items-center border border-ink-200 rounded-md">
      <button
        onClick={() => onChange(Math.max(0, (value || 0) - 1))}
        className="px-3 py-2 text-ink-600 hover:bg-ink-100"
        aria-label="Restar"
      >
        <Minus size={14} />
      </button>
      <DebouncedInput
        type="number"
        min="0"
        value={value ?? 0}
        onCommit={(v) => onChange(Math.max(0, Number(v) || 0))}
        className="w-12 text-center bg-transparent border-0 px-0 focus:outline-none focus:ring-0"
      />
      <button
        onClick={() => onChange((value || 0) + 1)}
        className="px-3 py-2 text-ink-600 hover:bg-ink-100"
        aria-label="Sumar"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
