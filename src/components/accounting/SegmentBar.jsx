import { Search } from 'lucide-react';

/**
 * Odoo-style segmentation bar: a "Agrupar por" dimension picker + a free-text
 * segment filter. Controlled: `groupBy`/`query` + their setters; `options` is
 * `[{ key, label }]`.
 */
export default function SegmentBar({ groupBy, onGroupBy, options, query, onQuery }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <label className="text-xs text-ink-500">Agrupar por</label>
      <div className="flex gap-1">
        {(options || []).map((o) => (
          <button key={o.key} type="button" onClick={() => onGroupBy(o.key)}
            className={`btn ${groupBy === o.key ? 'tab-pill-active' : 'tab-pill'}`}>
            {o.label}
          </button>
        ))}
      </div>
      <div className="relative sm:ml-auto">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-300" />
        <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Filtrar…"
          className="input py-1.5 pl-8 text-sm w-44" />
      </div>
    </div>
  );
}
