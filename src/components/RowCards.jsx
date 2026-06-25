import { Link } from 'react-router-dom';

/**
 * RowCards — the shared mobile fallback for dense data tables.
 *
 * The desktop table stays the source of truth at `md:`+; below `md` the rows
 * render as a single panel of divided LINES (not floating cards): a title/right
 * pair, an optional second line, and compact label→value pairs, plus an
 * optional totals footer (tables lose their `<tfoot>` to horizontal scroll on
 * phones — the footer keeps totals visible). Pages keep their table markup and
 * pair the two variants:
 *
 *   <RowCards rows={rows.map((r) => ({ key, title, right, sub,
 *     kv: [['Fecha', fecha], ['NCF', ncf]] }))} footer={[['Total', t]]} />
 *   <div className="hidden md:block …"><table …/></div>
 *
 * `inCard` renders the divided list bare, to drop INSIDE an existing `card`
 * (for tables that share a card with a header); the default wraps the same
 * list in its own bordered panel. A row with `to` navigates via Link (whole
 * line is the touch target).
 */
function KV({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-2 min-w-0">
      <span className="text-[11px] text-ink-400 shrink-0">{label}</span>
      <span className="text-xs tabular-nums text-ink-700 truncate">{children}</span>
    </div>
  );
}

function RowBody({ row }) {
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink-900 truncate">{row.title}</span>
        {row.right != null && (
          <span className="text-sm font-semibold tabular-nums text-ink-900 shrink-0">{row.right}</span>
        )}
      </div>
      {row.sub != null && <div className="text-xs text-ink-500 truncate">{row.sub}</div>}
      {row.kv?.length > 0 && (
        <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5">
          {row.kv.filter(Boolean).map(([label, value], i) => <KV key={i} label={label}>{value}</KV>)}
        </div>
      )}
      {row.actions != null && (
        <div className="mt-2 flex flex-wrap items-center gap-2">{row.actions}</div>
      )}
    </>
  );
}

function Totals({ footer }) {
  return (
    <div className="px-3.5 py-2.5 bg-ink-50/60">
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        {footer.map(([label, value], i) => (
          <div key={i} className="flex items-baseline justify-between gap-2 min-w-0">
            <span className="text-[11px] text-ink-500 shrink-0">{label}</span>
            <span className="text-xs font-semibold tabular-nums text-ink-900 truncate">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function RowCards({ rows, footer, empty = null, inCard = false }) {
  if (!rows?.length) {
    return empty != null ? <div className="md:hidden">{empty}</div> : null;
  }
  const rowClass = 'block px-3.5 py-2.5';
  const items = rows.map((row) => {
    const body = <RowBody row={row} />;
    if (row.to) {
      return <Link key={row.key} to={row.to} className={`${rowClass} hover:bg-ink-50 transition-colors`}>{body}</Link>;
    }
    if (row.onClick) {
      return (
        <button key={row.key} type="button" onClick={row.onClick}
          className={`${rowClass} w-full text-left hover:bg-ink-50 transition-colors`}>{body}</button>
      );
    }
    return <div key={row.key} className={rowClass}>{body}</div>;
  });
  const list = (
    <div className="divide-y divide-ink-100">
      {items}
      {footer?.length > 0 && <Totals footer={footer} />}
    </div>
  );
  // `inCard`: caller already owns a card → render the divided list bare.
  // Default: wrap the same list in its own flat bordered panel.
  return inCard
    ? <div className="md:hidden">{list}</div>
    : <div className="md:hidden card overflow-hidden">{list}</div>;
}
