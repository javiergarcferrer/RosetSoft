// Recurring transactions ViewModel — the agenda of memorized templates: what's
// due to generate today, what's upcoming, what's paused. Pure: no React, no db.
import { round2 } from '../../lib/accounting/ledger.js';
import { isDue } from '../../lib/accounting/recurring.js';

function scheduleLabel(t) {
  const n = Math.max(1, Math.trunc(t.interval || 1));
  const unit = t.freq === 'weekly'
    ? (n === 1 ? 'semana' : 'semanas')
    : t.freq === 'yearly'
      ? (n === 1 ? 'año' : 'años')
      : (n === 1 ? 'mes' : 'meses');
  return n === 1 ? `Cada ${unit}` : `Cada ${n} ${unit}`;
}

export function resolveRecurring({ templates, now } = {}) {
  const at = now || 0;
  const rows = (templates || []).map((t) => ({
    template: t,
    name: t.name || 'Recurrente',
    kind: t.kind || 'expense',
    status: t.status || 'active',
    nextRunAt: t.nextRunAt || 0,
    lastRunAt: t.lastRunAt || null,
    endAt: t.endAt || null,
    amount: round2((t.payload?.base || 0) + (t.payload?.itbis || 0)),
    scheduleLabel: scheduleLabel(t),
    due: isDue(t, at),
  }));
  const byNext = (a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0);
  const due = rows.filter((r) => r.due).sort(byNext);
  const upcoming = rows.filter((r) => r.status === 'active' && !r.due).sort(byNext);
  const paused = rows.filter((r) => r.status === 'paused').sort(byNext);
  return {
    rows, due, upcoming, paused,
    count: rows.length,
    dueCount: due.length,
    dueTotal: round2(due.reduce((s, r) => s + r.amount, 0)),
  };
}
