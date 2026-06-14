import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * useColumnWidths — drag-to-resize column widths for a list table, persisted
 * per browser. The sibling of useColumns: that hook owns which columns show,
 * this one owns how wide each is. A page wires it with the SAME visibility-
 * filtered `cols` array it renders, plus its own storage key.
 *
 * How it works (kept generic so every table can opt in with ~3 lines):
 *  - The table starts in normal `table-layout: auto` so columns size to their
 *    content naturally. On first paint we MEASURE each header cell's rendered
 *    width, seed that as the column's width, then flip the table to
 *    `table-layout: fixed` — now the seeded widths are authoritative and a drag
 *    can shrink a column below its content (it clips), not just grow it.
 *  - A returning visitor with stored widths skips the measure and starts fixed.
 *  - Each resizable header renders {ResizeHandle(col.key)} on its right edge;
 *    dragging it updates that column's width live and persists on release.
 *  - Fixed leading/trailing cells (select checkbox, row actions) are NOT in
 *    `cols`; they keep their existing `w-10`/`w-12` width utilities, which
 *    `table-layout: fixed` honours, so nothing about them changes.
 *  - Responsive columns (`hidden lg:table-cell`) collapse correctly: their
 *    <th> and <td> share the breakpoint class, so under fixed layout the whole
 *    column drops together and the rest stay aligned.
 *
 * PARAMS
 *   cols        the visibility-filtered column array the table renders (each
 *               entry has a stable `key`). Order/content may change as the user
 *               toggles columns — newly shown columns get measured & seeded.
 *   storageKey  per-view localStorage key, e.g. 'rs.quotes.widths.v1'.
 *
 * RETURNS
 *   tableRef     attach to the <table> (used to measure header cells).
 *   tableStyle   spread onto the <table> ({ tableLayout } — auto until seeded).
 *   thProps      thProps(key) → spread onto a resizable <th> (data attr +
 *                position:relative + the persisted width).
 *   ResizeHandle ResizeHandle(key) → the drag affordance; render inside the <th>.
 *   reset        () => void — clear all widths (back to auto-measured).
 *   hasWidths    whether any width is set (e.g. to enable a "reset" control).
 */
export default function useColumnWidths(cols, storageKey) {
  const tableRef = useRef(null);
  const [widths, setWidths] = useState(() => loadWidths(storageKey));
  // Seeded once we either loaded stored widths or measured the natural layout.
  const [seeded, setSeeded] = useState(() => Object.keys(loadWidths(storageKey)).length > 0);

  // Seed any unmeasured (currently-visible) column from its natural width, then
  // switch to fixed layout. Runs on mount and whenever the visible set changes
  // so a freshly-toggled-on column gets a sensible starting width.
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    let nextSeeded = false;
    setWidths((cur) => {
      const next = { ...cur };
      let changed = false;
      for (const col of cols) {
        if (next[col.key] != null) continue;
        const th = table.querySelector(`th[data-col-key="${cssEscape(col.key)}"]`);
        if (th) {
          next[col.key] = Math.round(th.getBoundingClientRect().width);
          changed = true;
        }
      }
      return changed ? next : cur;
    });
    nextSeeded = true;
    if (nextSeeded) setSeeded(true);
  }, [cols]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(widths));
    } catch {
      /* storage unavailable — widths just won't persist */
    }
  }, [storageKey, widths]);

  const startResize = useCallback((key, e) => {
    // Pointer events cover mouse + touch; keep the header's own click (sort) from
    // firing and stop text selection while dragging.
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.closest('th');
    const startX = e.clientX;
    const startW = th ? th.getBoundingClientRect().width : 120;

    const onMove = (ev) => {
      const w = Math.max(MIN_COL_PX, Math.round(startW + (ev.clientX - startX)));
      setWidths((cur) => (cur[key] === w ? cur : { ...cur, [key]: w }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('rs-resizing');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.classList.add('rs-resizing');
  }, []);

  const thProps = useCallback(
    (key) => {
      const w = widths[key];
      return {
        'data-col-key': key,
        style: w != null
          ? { width: w, minWidth: w, position: 'relative' }
          : { position: 'relative' },
      };
    },
    [widths],
  );

  const ResizeHandle = useCallback(
    (key) => (
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label="Cambiar ancho de columna"
        onPointerDown={(e) => startResize(key, e)}
        onClick={(e) => e.stopPropagation()}
        className="rs-col-resize"
      />
    ),
    [startResize],
  );

  const reset = useCallback(() => setWidths({}), []);

  return {
    tableRef,
    tableStyle: { tableLayout: seeded ? 'fixed' : 'auto' },
    thProps,
    ResizeHandle,
    reset,
    hasWidths: Object.keys(widths).length > 0,
  };
}

/** Floor so a column can never be dragged to nothing. */
const MIN_COL_PX = 56;

function loadWidths(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    /* storage unavailable — start unmeasured */
  }
  return {};
}

/** CSS.escape isn't on every target; a column key is alnum/._- so this is safe. */
function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}
