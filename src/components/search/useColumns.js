import { useEffect, useMemo, useState } from 'react';

/**
 * useColumns — localStorage-backed column-visibility state for a list table.
 *
 * The Shopify "edit columns" control (the eye-toggle popover, ColumnsMenu)
 * shipped first on the Quotes list; this hook factors out the wiring so EVERY
 * table view turns its columns on/off the same way and remembers the choice
 * per browser. A page declares ONE ordered column array (each entry a pure
 * `{ key, label, canHide?, thClass?, tdClass?, cell(ctx) }`) plus its defaults
 * and a storage key, then renders `cols` and feeds the rest straight into
 * <ColumnsMenu> (or ListSearchHeader's column props).
 *
 * PARAMS
 *   allColumns  Array<{ key, label, canHide?, … }> — the full ordered set. A
 *               column with `canHide === false` is the fixed anchor: always
 *               visible and never offered in the menu.
 *   defaults    { [key]: boolean } — initial visibility for the hideable
 *               columns (anchors are implicitly always on).
 *   storageKey  string — per-view localStorage key, e.g. 'rs.customers.cols.v1'.
 *               Bump the suffix to force-reset after changing the column set.
 *
 * RETURNS (named to drop straight into ColumnsMenu / ListSearchHeader)
 *   { columns, visible, setVisible, reset, cols }
 *     columns    — the full set            → <ColumnsMenu columns=… />
 *     visible    — current visibility map  → visible= / visibleColumns=
 *     setVisible — next-map setter         → onChange= / onColumnsChange=
 *     reset      — restore defaults        → onReset= / onColumnsReset=
 *     cols       — what the table renders  → anchor + toggled-on, original order
 */
export default function useColumns(allColumns, defaults, storageKey) {
  const [visible, setVisible] = useState(() => loadVisible(storageKey, defaults));

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(visible));
    } catch {
      /* storage unavailable (private mode / quota) — choice just won't persist */
    }
  }, [storageKey, visible]);

  const cols = useMemo(
    () => allColumns.filter((c) => c.canHide === false || visible[c.key]),
    [allColumns, visible],
  );

  return {
    columns: allColumns,
    visible,
    setVisible,
    reset: () => setVisible(defaults),
    cols,
  };
}

function loadVisible(storageKey, defaults) {
  try {
    const raw = localStorage.getItem(storageKey);
    // Merge over defaults so a column added after the user's last visit appears
    // with its shipped default instead of vanishing.
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable — fall back to defaults */
  }
  return defaults;
}
