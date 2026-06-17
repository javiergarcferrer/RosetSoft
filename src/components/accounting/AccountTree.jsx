import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { formatDop } from '../../lib/format.js';
import { ACCOUNT_CLASS_NAMES } from '../../core/accounting/index.js';

/**
 * Interactive chart-of-accounts navigator — the master pane of the Mayor
 * master-detail. Renders the catálogo tree (from `resolveChartTree`) with a
 * live rolled-up saldo beside every row; clicking a postable (leaf) account
 * calls `onSelect(code)` so the detail pane opens that account's mayor. Title
 * accounts toggle open/closed. A search box flattens the tree to matching
 * code/name.
 *
 * Pure View: derives nothing — it just renders the tree the VM handed it and
 * raises selection back to the parent.
 */
const CLASS_TONE = {
  1: 'bg-sky-100 text-sky-700',
  2: 'bg-amber-100 text-amber-700',
  3: 'bg-teal-100 text-teal-700',
  4: 'bg-emerald-100 text-emerald-700',
  5: 'bg-rose-100 text-rose-700',
  6: 'bg-orange-100 text-orange-700',
};

/** Depth-first flatten — used to turn the tree into a flat search list. */
function flatten(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
}

function TreeNode({ node, depth, selectedCode, onSelect }) {
  const hasChildren = (node.children || []).length > 0;
  // Open the class roots by default; deeper titles start collapsed.
  const [open, setOpen] = useState(depth < 1);
  const selected = node.isPostable && node.code === selectedCode;
  const onClick = node.isPostable
    ? () => onSelect(node.code)
    : hasChildren
      ? () => setOpen((v) => !v)
      : undefined;
  return (
    <div>
      <div
        className={`flex items-center gap-2 py-1.5 coarse:py-2.5 border-b border-ink-50 min-w-0 transition-colors ${
          onClick ? 'cursor-pointer' : ''
        } ${selected ? 'bg-brand-50' : onClick ? 'hover:bg-ink-50 active:bg-ink-100' : ''}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={onClick}
      >
        <span className="text-ink-400 w-3 text-xs shrink-0">{hasChildren ? (open ? '▾' : '▸') : ''}</span>
        <code className="text-[11px] text-ink-500 tabular-nums shrink-0">{node.code}</code>
        <span
          className={`text-sm min-w-0 break-words flex-1 ${
            node.isPostable
              ? selected ? 'text-brand-800 font-medium' : 'text-ink-800'
              : 'font-semibold text-ink-900'
          }`}
        >
          {node.name}
        </span>
        {node.amount !== 0 && (
          <span className={`ml-auto text-xs tabular-nums shrink-0 ${node.isPostable ? 'text-ink-600' : 'text-ink-500 font-medium'}`}>
            {formatDop(node.amount)}
          </span>
        )}
      </div>
      {open && hasChildren && node.children.map((c) => (
        <TreeNode key={c.code} node={c} depth={depth + 1} selectedCode={selectedCode} onSelect={onSelect} />
      ))}
    </div>
  );
}

export default function AccountTree({ roots, selectedCode, onSelect }) {
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return null;
    return flatten(roots)
      .filter((n) => n.code.includes(needle) || (n.name || '').toLowerCase().includes(needle));
  }, [q, roots]);

  return (
    <div className="card overflow-hidden flex flex-col max-h-[72vh]">
      <div className="p-2 border-b border-ink-100 shrink-0">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar cuenta…"
            className="input pl-8 py-1.5 text-sm"
          />
        </div>
      </div>
      <div className="overflow-y-auto min-h-0">
        {matches ? (
          matches.length === 0 ? (
            <p className="text-sm text-ink-500 py-6 text-center">Sin coincidencias.</p>
          ) : (
            matches.map((n) => (
              <button
                key={n.code}
                type="button"
                onClick={n.isPostable ? () => onSelect(n.code) : undefined}
                disabled={!n.isPostable}
                className={`w-full flex items-center gap-2 py-1.5 px-2.5 border-b border-ink-50 text-left min-w-0 ${
                  n.isPostable ? 'cursor-pointer hover:bg-ink-50' : 'cursor-default'
                } ${n.isPostable && n.code === selectedCode ? 'bg-brand-50' : ''}`}
              >
                <span className={`chip shrink-0 ${CLASS_TONE[n.class] || 'bg-ink-100 text-ink-600'}`}>
                  {ACCOUNT_CLASS_NAMES[n.class] || n.class}
                </span>
                <code className="text-[11px] text-ink-500 tabular-nums shrink-0">{n.code}</code>
                <span className={`text-sm min-w-0 break-words flex-1 ${n.isPostable ? 'text-ink-800' : 'font-semibold text-ink-900'}`}>
                  {n.name}
                </span>
                {n.amount !== 0 && (
                  <span className="ml-auto text-xs tabular-nums text-ink-600 shrink-0">{formatDop(n.amount)}</span>
                )}
              </button>
            ))
          )
        ) : (
          (roots || []).map((root) => (
            <TreeNode key={root.code} node={root} depth={0} selectedCode={selectedCode} onSelect={onSelect} />
          ))
        )}
      </div>
    </div>
  );
}
