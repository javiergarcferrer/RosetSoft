// Import-liquidation ViewModel — the Importaciones list with landed cost + unit
// cost. Pure: no React, no db.
import { round2 } from '../../lib/accounting/ledger.js';
import { landedCost, landedUnitCost } from '../../lib/accounting/importLiquidation.js';

export function resolveImportsList({ imports, suppliers, items, start, end } = {}) {
  const supById = new Map((suppliers || []).map((s) => [s.id, s]));
  const itemById = new Map((items || []).map((i) => [i.id, i]));
  const rows = (imports || [])
    .filter((l) => {
      if (start != null && l.liquidatedAt < start) return false;
      if (end != null && l.liquidatedAt > end) return false;
      return true;
    })
    .map((l) => {
      const landed = landedCost(l);
      return {
        liq: l,
        supplier: l.supplierId ? supById.get(l.supplierId) || null : null,
        item: l.itemId ? itemById.get(l.itemId) || null : null,
        landed,
        unitCost: landedUnitCost(l, l.qty),
        total: round2(landed + (l.importItbis || 0)),
      };
    })
    .sort((a, b) => (b.liq.liquidatedAt || 0) - (a.liq.liquidatedAt || 0));

  const totals = rows.reduce((acc, r) => ({
    cif: acc.cif + (r.liq.cif || 0),
    duty: acc.duty + (r.liq.duty || 0),
    importItbis: acc.importItbis + (r.liq.importItbis || 0),
    landed: acc.landed + r.landed,
  }), { cif: 0, duty: 0, importItbis: 0, landed: 0 });
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);

  return { rows, totals, count: rows.length };
}
