// Accounting COCKPIT ViewModel — the "command center" band at the top of the
// contabilidad home. Unlike the dashboard's analytics (scoped to a selected
// period), the cockpit is always "as of today": the upcoming fiscal deadlines,
// the period-close status, and a single PRIORITIZED action center (what needs
// doing now — transmit e-CF, file 606/607/IT-1, chase overdue cuentas, invoice
// accepted quotes, close last month). Pure: no React, no db. Returns structured
// data (counts/amounts/severities/routes); the View formats the money + copy.
import { round2 } from '../../lib/accounting/ledger.js';
import { resolveReceivables, resolvePayables } from './receivables.js';
import { resolveEcfSequenceAlerts } from './dashboard.js';
import { activeFiscalPlugin, resolveFilingDeadline } from './fiscal/index.js';
import { QUOTE_STATUS_ACCEPTED } from '../../lib/constants.js';

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const SEV_RANK = { danger: 0, warn: 1, info: 2 };

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** 'YYYYMM' → "Junio 2026". */
function periodLabel(period) {
  const y = Number(String(period).slice(0, 4));
  const m = Number(String(period).slice(4, 6));
  return `${capitalize(MONTHS_ES[m - 1] || '')} ${y}`;
}
const monthLabel = (date) => `${capitalize(MONTHS_ES[date.getMonth()])} ${date.getFullYear()}`;

/**
 * @returns {{
 *   deadlines: Array<{code,label,to,period,periodLabel,daysLeft,dueAt,severity}>,
 *   periodClose: {currentLabel,prevLabel,prevClosed,lastClosedLabel},
 *   actions: Array<{id,kind,severity,to,...payload}>,   // prioritized (danger→info)
 *   counts: {actions,danger}
 * }}
 */
export function resolveAccountingCockpit({
  settings, fiscalPeriods, quotes, salesPostings, payments, purchases, expenses,
  customersById, suppliersById, ecfSequences, now = Date.now(),
} = {}) {
  // ── 1) Upcoming periodic fiscal filings (606/607/IT-1…) ──────────────────
  const plugin = activeFiscalPlugin(settings);
  const deadlines = (plugin.reports || [])
    .filter((r) => r.dueDay)
    .map((r) => {
      const dl = resolveFilingDeadline(r.dueDay, now);
      if (!dl) return null;
      return {
        code: r.code, label: r.label, to: r.to,
        period: dl.period, periodLabel: periodLabel(dl.period),
        daysLeft: dl.daysLeft, dueAt: dl.dueAt,
        severity: dl.daysLeft <= 2 ? 'danger' : dl.daysLeft <= 7 ? 'warn' : 'info',
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  // ── 2) Period-close status ───────────────────────────────────────────────
  const ref = new Date(now);
  const prev = new Date(ref.getFullYear(), ref.getMonth() - 1, 1);
  const closedSet = new Set((fiscalPeriods || []).filter((p) => p.status === 'closed').map((p) => `${p.year}-${p.month}`));
  const prevClosed = closedSet.has(`${prev.getFullYear()}-${prev.getMonth() + 1}`);
  let lastClosed = null;
  for (const p of fiscalPeriods || []) {
    if (p.status !== 'closed') continue;
    const k = p.year * 12 + (p.month - 1);
    if (!lastClosed || k > lastClosed.k) lastClosed = { k, year: p.year, month: p.month };
  }
  const periodClose = {
    currentLabel: monthLabel(ref),
    prevLabel: monthLabel(prev),
    prevClosed,
    lastClosedLabel: lastClosed ? `${capitalize(MONTHS_ES[lastClosed.month - 1])} ${lastClosed.year}` : null,
  };

  // ── 3) Overdue cuentas (aging as of today) ───────────────────────────────
  const cxc = resolveReceivables({ salesPostings, payments, customersById, asOf: now });
  const cxp = resolvePayables({ purchases, expenses, payments, suppliersById, asOf: now });
  const arOverdue = round2(cxc.totals.d31_60 + cxc.totals.d61_90 + cxc.totals.d90);
  const apOverdue = round2(cxp.totals.d31_60 + cxp.totals.d61_90 + cxp.totals.d90);

  // ── 4) e-CF transmission backlog + sequence health ───────────────────────
  const ecfPending = (salesPostings || [])
    .filter((s) => /^E\d{2}/.test(s.ncf || '') && s.ecfStatus !== 'sent' && s.ecfStatus !== 'accepted').length;
  const ecfSeqAlerts = resolveEcfSequenceAlerts(ecfSequences, { now });

  // ── 5) Accepted quotes not yet invoiced (a sales posting links by quoteId) ─
  const invoiced = new Set((salesPostings || []).map((s) => s.quoteId).filter(Boolean));
  const toInvoice = (quotes || []).filter((q) => q.status === QUOTE_STATUS_ACCEPTED && !invoiced.has(q.id)).length;

  // ── Build the prioritized action center ──────────────────────────────────
  const actions = [];
  for (const a of ecfSeqAlerts) {
    actions.push({
      id: `ecfseq-${a.type}`, kind: 'ecfSeq', to: '/accounting/ecf',
      severity: a.kind === 'none' ? 'danger' : 'warn',
      seqKind: a.kind, name: a.label, remaining: a.remaining ?? null, expiresAt: a.expiresAt ?? null,
    });
  }
  if (ecfPending > 0) actions.push({ id: 'ecf-pending', kind: 'ecf', severity: 'warn', to: '/accounting/facturacion', count: ecfPending });
  for (const dl of deadlines) {
    if (dl.daysLeft <= 7) {
      actions.push({ id: `due-${dl.code}`, kind: 'deadline', severity: dl.severity, to: dl.to, code: dl.code, name: dl.label, daysLeft: dl.daysLeft, periodLabel: dl.periodLabel });
    }
  }
  if (apOverdue > 0) actions.push({ id: 'ap-overdue', kind: 'payable', severity: cxp.totals.d90 > 0 ? 'danger' : 'warn', to: '/accounting/cuentas', amount: apOverdue, severe90: cxp.totals.d90 });
  if (arOverdue > 0) actions.push({ id: 'ar-overdue', kind: 'receivable', severity: cxc.totals.d90 > 0 ? 'danger' : 'warn', to: '/accounting/cuentas', amount: arOverdue, severe90: cxc.totals.d90 });
  if (toInvoice > 0) actions.push({ id: 'to-invoice', kind: 'invoice', severity: 'info', to: '/accounting/facturacion', count: toInvoice });
  if (!prevClosed) actions.push({ id: 'period-close', kind: 'periodClose', severity: 'info', to: '/accounting/periodos', label: periodClose.prevLabel });

  actions.sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || ((b.amount || 0) - (a.amount || 0)));

  return {
    deadlines,
    periodClose,
    actions,
    counts: { actions: actions.length, danger: actions.filter((a) => a.severity === 'danger').length },
  };
}
