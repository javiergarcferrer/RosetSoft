// Audit trail ViewModel — the append-only bitácora of changes to the financial
// tables, formatted for a read-only log view. Pure: no React, no db.

const TABLE_LABEL = {
  sales_postings: 'Factura', expenses: 'Gasto', purchases: 'Compra',
  payments: 'Pago / cobro', journal_entries: 'Asiento', journal_lines: 'Línea de asiento',
};
const ACTION_LABEL = { insert: 'Creó', update: 'Modificó', delete: 'Eliminó' };
const HIDE = new Set(['updated_at', 'created_at']);

function changedFields(before, after) {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  for (const k of keys) {
    if (HIDE.has(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(k);
  }
  return out;
}

export function resolveAuditTrail({ rows, profilesById, query, tableFilter, actionFilter, limit = 500 } = {}) {
  const q = (query || '').trim().toLowerCase();
  let items = (rows || []).map((r) => {
    const changed = r.action === 'update' ? changedFields(r.before, r.after) : [];
    return {
      id: r.id,
      loggedAt: r.loggedAt || 0,
      action: r.action,
      actionLabel: ACTION_LABEL[r.action] || r.action,
      tableName: r.tableName,
      tableLabel: TABLE_LABEL[r.tableName] || r.tableName,
      rowId: r.rowId || '',
      userName: (profilesById && r.userId && profilesById.get(r.userId)?.name)
        || (r.userId ? 'Usuario' : 'Sistema'),
      changed,
      summary: r.action === 'update'
        ? (changed.length ? `${changed.length} campo(s): ${changed.slice(0, 5).join(', ')}` : 'sin cambios')
        : (TABLE_LABEL[r.tableName] || r.tableName),
    };
  });
  if (tableFilter) items = items.filter((i) => i.tableName === tableFilter);
  if (actionFilter) items = items.filter((i) => i.action === actionFilter);
  if (q) items = items.filter((i) => [i.tableLabel, i.userName, i.rowId, i.changed.join(' ')].some((v) => (v || '').toLowerCase().includes(q)));
  items.sort((a, b) => b.loggedAt - a.loggedAt);
  return {
    rows: items.slice(0, limit),
    count: items.length,
    tables: [...new Set((rows || []).map((r) => r.tableName))].sort(),
  };
}
