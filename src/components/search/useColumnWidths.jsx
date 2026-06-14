import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * useColumnWidths — drag-to-resize column widths for a list table, persisted
 * per browser. The sibling of useColumns: that hook owns which columns show,
 * this one owns how wide each is. A page wires it with the SAME visibility-
 * filtered `cols` array it renders, plus its own storage key.
 *
 * How it works (kept generic so every table can opt in with ~3 lines):
 *  - We MEASURE each header cell's natural width once (a column with no stored
 *    width), then render the table `table-layout: fixed` so those widths are
 *    authoritative and a drag can shrink a column below its content (it clips),
 *    not just grow it. Measurement reads natural widths even after the switch to
 *    fixed by briefly toggling the live `<table>` to `auto` inside a layout
 *    effect (pre-paint, so it's invisible) — that way a column toggled ON later
 *    gets its real content width, not a fixed-layout share.
 *  - Measurement is (re)triggered when the <table> actually mounts (via a
 *    callback ref, so tables gated behind a `loaded` check still get measured),
 *    when the visible `cols` change, and on reset — never just "once on mount".
 *  - A returning visitor with stored widths starts fixed immediately.
 *  - A column that is display:none at measure time (a responsive
 *    `hidden lg:table-cell`) measures 0; we skip it rather than pin it to 0, so
 *    it isn't collapsed when a wider breakpoint later reveals it.
 *  - Fixed leading/trailing cells (select checkbox, row actions) are NOT in
 *    `cols`; they keep their existing `w-10`/`w-12` width utilities.
 *  - `storageKey` may change at runtime (a per-tab table, e.g. cobrar/pagar):
 *    we reload the widths for the new key during render so one tab never
 *    overwrites the other's saved widths.
 *
 * PARAMS
 *   cols        the visibility-filtered column array the table renders (stable
 *               `key` per entry). Newly shown columns get measured & seeded.
 *   storageKey  per-view localStorage key, e.g. 'rs.quotes.widths.v1'.
 *
 * RETURNS
 *   tableRef     callback ref for the <table> (measures header cells on mount).
 *   tableStyle   spread onto the <table> ({ tableLayout } — auto until measured).
 *   thProps      thProps(key) → spread onto a resizable <th> (data attr +
 *                position:relative + the persisted width).
 *   ResizeHandle ResizeHandle(key) → the drag affordance; render inside the <th>.
 *   reset        () => void — clear widths and re-measure natural widths.
 *   hasWidths    whether any width is set (e.g. to enable a "reset" control).
 */
export default function useColumnWidths(cols, storageKey) {
  const tableElRef = useRef(null);
  const [widths, setWidths] = useState(() => loadWidths(storageKey));
  // `ready` gates the auto→fixed switch: stay auto until we have widths to pin.
  const [ready, setReady] = useState(() => Object.keys(loadWidths(storageKey)).length > 0);
  // Bumped to request a (re)measure: table (re)mounted, or reset.
  const [measureTick, setMeasureTick] = useState(0);

  // Mirror the latest widths into a ref so the measure effect can read them
  // without depending on `widths` (which would defeat its run-once-per-change).
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  // Reload state when the storage key changes at runtime (a per-tab table),
  // BEFORE the persist effect runs — otherwise the outgoing tab's widths get
  // written onto the incoming tab's key. React's "adjust state on prop change".
  const [prevKey, setPrevKey] = useState(storageKey);
  if (storageKey !== prevKey) {
    setPrevKey(storageKey);
    const loaded = loadWidths(storageKey);
    setWidths(loaded);
    setReady(Object.keys(loaded).length > 0);
    setMeasureTick((t) => t + 1);
  }

  // Callback ref: when the <table> attaches (incl. after a `loaded` gate),
  // request a measure. Stable identity, so it only fires on mount/unmount.
  const tableRef = useCallback((node) => {
    tableElRef.current = node;
    if (node) setMeasureTick((t) => t + 1);
  }, []);

  // Measure any still-unmeasured visible columns at their natural width, then
  // mark ready (→ fixed layout). Runs when cols change or a measure is requested.
  useLayoutEffect(() => {
    const table = tableElRef.current;
    if (!table) return;
    const unmeasured = cols.filter((c) => widthsRef.current[c.key] == null);
    if (unmeasured.length) {
      const saved = table.style.tableLayout;
      table.style.tableLayout = 'auto'; // read natural widths, even if rendered fixed
      const measured = {};
      for (const col of unmeasured) {
        const th = table.querySelector(`th[data-col-key="${cssEscape(col.key)}"]`);
        if (!th) continue;
        const w = Math.round(th.getBoundingClientRect().width);
        if (w > 0) measured[col.key] = w; // skip display:none columns (width 0)
      }
      table.style.tableLayout = saved;
      if (Object.keys(measured).length) setWidths((cur) => ({ ...cur, ...measured }));
    }
    setReady(true);
  }, [cols, measureTick]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(widths));
    } catch {
      /* storage unavailable — widths just won't persist */
    }
  }, [storageKey, widths]);

  // Clean up a drag still in flight if the component unmounts mid-drag.
  const dragCleanup = useRef(null);
  useEffect(() => () => dragCleanup.current?.(), []);

  const startResize = useCallback((key, e) => {
    // Pointer events cover mouse + touch; keep the header's own click (sort) from
    // firing and stop text selection while dragging.
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.closest('th');
    const startX = e.clientX;
    const startW = th ? th.getBoundingClientRect().width : 120;
    // Capture so we keep getting moves/up even if the pointer leaves the handle;
    // pointercancel covers a lost/interrupted pointer (the up that never comes).
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* unsupported */ }

    const onMove = (ev) => {
      const w = Math.max(MIN_COL_PX, Math.round(startW + (ev.clientX - startX)));
      setWidths((cur) => (cur[key] === w ? cur : { ...cur, [key]: w }));
    };
    const end = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      document.body.classList.remove('rs-resizing');
      dragCleanup.current = null;
    };
    dragCleanup.current = end;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
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

  // Clear widths and re-measure from scratch (back to natural widths).
  const reset = useCallback(() => {
    setWidths({});
    setReady(false);
    setMeasureTick((t) => t + 1);
  }, []);

  return {
    tableRef,
    tableStyle: { tableLayout: ready ? 'fixed' : 'auto' },
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

/** Prefer the platform CSS.escape; fall back to escaping selector metachars. */
function cssEscape(s) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return String(s).replace(/["\\\][]/g, '\\$&');
}
