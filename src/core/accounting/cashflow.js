// Estado de flujo de efectivo (direct method, by activity/source). Pure: no
// React, no db. Cash = the postable Cajas y Bancos leaves (1-01-001); each
// journal entry's net effect on those accounts is grouped by its source into
// operating / investing / financing, with the opening and closing cash for the
// window so opening + flujo neto = efectivo final.
import { round2 } from '../../lib/accounting/ledger.js';

/** Friendly labels for the journal sources a cash movement can come from. */
export const CASHFLOW_SOURCE_LABEL = {
  sale: 'Ventas (facturación)',
  payment: 'Cobros y pagos',
  expense: 'Gastos',
  purchase: 'Compras',
  import: 'Importaciones',
  payroll: 'Nómina',
  gateway: 'Comisiones de tarjeta',
  tax: 'Impuestos',
  fx: 'Diferencia cambiaria',
  opening: 'Aportes / apertura',
  adjustment: 'Ajustes',
  manual: 'Asientos manuales',
  depreciation: 'Depreciación',
};

// Owner capital (opening) is a financing flow; everything else this dealer books
// is operating (imports capitalize inventory — operating working capital).
const ACTIVITY_OF = { opening: 'financing' };
const activityOf = (source) => ACTIVITY_OF[source] || 'operating';

export function resolveCashFlow({ accounts, entries, lines, start, end } = {}) {
  const cashCodes = new Set(
    (accounts || []).filter((a) => a.isPostable && String(a.code).startsWith('1-01-001')).map((a) => a.code),
  );
  const entryById = new Map((entries || []).map((e) => [e.id, e]));

  // Net cash effect per entry = Σ(debit − credit) over its lines on cash accounts.
  const deltaByEntry = new Map();
  if (cashCodes.size) {
    for (const l of lines || []) {
      if (!cashCodes.has(l.accountCode)) continue;
      const d = (Number(l.debit) || 0) - (Number(l.credit) || 0);
      deltaByEntry.set(l.entryId, (deltaByEntry.get(l.entryId) || 0) + d);
    }
  }

  let opening = 0;
  let netChange = 0;
  const bySource = new Map();
  for (const [entryId, deltaRaw] of deltaByEntry) {
    const e = entryById.get(entryId);
    if (!e) continue;
    const delta = round2(deltaRaw);
    if (delta === 0) continue;
    const t = e.postedAt || 0;
    if (start != null && t < start) { opening = round2(opening + delta); continue; }
    if (end != null && t > end) continue;
    netChange = round2(netChange + delta);
    const src = e.source || 'manual';
    bySource.set(src, round2((bySource.get(src) || 0) + delta));
  }

  const rows = [...bySource.entries()]
    .map(([source, amount]) => ({ source, label: CASHFLOW_SOURCE_LABEL[source] || source, amount, activity: activityOf(source) }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const activityTotal = (act) => round2(rows.filter((r) => r.activity === act).reduce((s, r) => s + r.amount, 0));
  const operating = activityTotal('operating');
  const investing = activityTotal('investing');
  const financing = activityTotal('financing');
  const sections = [
    { key: 'operating', label: 'Actividades de operación', total: operating },
    { key: 'investing', label: 'Actividades de inversión', total: investing },
    { key: 'financing', label: 'Actividades de financiamiento', total: financing },
  ].map((s) => ({ ...s, rows: rows.filter((r) => r.activity === s.key) })).filter((s) => s.rows.length > 0);

  return {
    start: start ?? null, end: end ?? null,
    rows, sections,
    operating, investing, financing,
    netChange, opening, closing: round2(opening + netChange),
  };
}
