/**
 * Shared period filter for the accounting reports — preset chips (este mes,
 * mes anterior, este año, todo) + a custom date range. Controlled:
 * `{ from, to }` are 'YYYY-MM-DD' strings (or '' = unbounded) and
 * `onChange({ from, to })` fires for both chips and manual edits.
 *
 * `periodWindow(from, to)` converts the pair into the inclusive ms window the
 * resolveX projections take (`{ start, end }`, nulls when unbounded).
 */

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function periodPresets(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  return [
    { key: 'month', label: 'Este mes', from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) },
    { key: 'lastMonth', label: 'Mes anterior', from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) },
    { key: 'year', label: 'Este año', from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 11, 31)) },
    { key: 'all', label: 'Todo', from: '', to: '' },
  ];
}

/** Inclusive ms window for a from/to pair ('' ⇒ unbounded side). */
export function periodWindow(from, to) {
  return {
    start: from ? Date.parse(`${from}T00:00:00`) : null,
    end: to ? Date.parse(`${to}T23:59:59.999`) : null,
  };
}

export default function PeriodPicker({ from, to, onChange }) {
  const presets = periodPresets();
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      {presets.map((p) => {
        const active = from === p.from && to === p.to;
        return (
          <button key={p.key} type="button"
            onClick={() => onChange({ from: p.from, to: p.to })}
            className={`btn ${active ? 'tab-pill-active border border-transparent' : 'tab-pill border border-ink-200'}`}>
            {p.label}
          </button>
        );
      })}
      <div className="flex items-center gap-2 min-w-0 text-sm text-ink-500">
        <input type="date" value={from} onChange={(e) => onChange({ from: e.target.value, to })}
          className="input w-full min-w-0 flex-1 py-1.5 text-sm" aria-label="Desde" />
        <span className="shrink-0">–</span>
        <input type="date" value={to} onChange={(e) => onChange({ from, to: e.target.value })}
          className="input w-full min-w-0 flex-1 py-1.5 text-sm" aria-label="Hasta" />
      </div>
    </div>
  );
}
