import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Check, ChevronDown, ChevronRight, AlertTriangle, CalendarClock, FileText } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { collectInstallment } from '../../db/paymentPlans.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import { resolvePaymentPlanFollowUp } from '../../core/quote/index.js';
import { resolveAccountingConfig } from '../../core/accounting/index.js';
import { effectiveDopRate } from '../../lib/exchangeRate.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import { formatMoney, formatDate } from '../../lib/format.js';

/**
 * Planes de pago — the collections follow-up board.
 *
 * Lists every active payment plan with an outstanding balance (most urgent
 * first: overdue, then soonest due) so accounting can chase cuotas. Collecting a
 * cuota posts a real cobro to the ledger (allocated to the quote's invoice, or
 * an advance if not yet invoiced) via the SAME `collectInstallment` service the
 * quote editor uses — so the receivables aging + estado de cuenta stay in sync.
 */
export default function PaymentPlans() {
  const { profileId, settings } = useApp();
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);
  const rate = effectiveDopRate(settings);

  const plansQ = useLiveQueryStatus(() => db.paymentPlans.where('profileId').equals(scope).toArray(), [scope], []);
  const customersQ = useLiveQueryStatus(() => db.customers.where('profileId').equals(scope).toArray(), [scope], []);

  const customersById = useMemo(() => {
    const m = new Map();
    for (const c of (customersQ.data || [])) m.set(c.id, c);
    return m;
  }, [customersQ.data]);

  const { rows, totals } = useMemo(
    () => resolvePaymentPlanFollowUp({ plans: plansQ.data || [], customersById, rate }),
    [plansQ.data, customersById, rate],
  );

  const [expanded, setExpanded] = useState(null); // planId
  const [collecting, setCollecting] = useState(''); // `${planId}:${n}`
  const [err, setErr] = useState('');

  const usd = (v) => formatMoney(v, 'USD');
  const dop = (v) => (rate ? formatMoney(v, 'DOP', { DOP: rate }) : '');

  async function collect(plan, n) {
    if (!plan) return; // plansQ.data may be mid-refetch when the row was clicked
    const key = `${plan.id}:${n}`;
    if (collecting) return;
    setCollecting(key);
    setErr('');
    try {
      await collectInstallment({ plan, installmentN: n, config, scope, rate });
      // The live query refetches on the mutation's invalidate — no local update.
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setCollecting('');
    }
  }

  const loaded = plansQ.loaded;

  return (
    <AccountingGate>
      <PageHeader title="Planes de pago" subtitle="Seguimiento de cobros por cuotas" />

      {!loaded ? (
        <ListLoading />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Sin planes activos"
          message="Los planes de pago con saldo pendiente aparecerán aquí para darles seguimiento."
        />
      ) : (
        <div className="space-y-4">
          {/* KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Kpi label="Por cobrar" value={dop(totals.outstandingDop)} sub={usd(totals.outstandingUsd)} />
            <Kpi label="Cuotas vencidas" value={String(totals.overdueCount)} tone={totals.overdueCount > 0 ? 'danger' : 'default'} />
            <Kpi label="Planes activos" value={String(totals.count)} />
          </div>

          {err && <p role="alert" className="text-sm text-red-600">{err}</p>}

          {/* Plans */}
          <div className="space-y-2">
            {rows.map((r) => {
              const open = expanded === r.planId;
              return (
                <div key={r.planId} className="card">
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : r.planId)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left"
                  >
                    {open ? <ChevronDown size={16} className="text-ink-400 shrink-0" /> : <ChevronRight size={16} className="text-ink-400 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-ink-900 truncate flex items-center gap-2">
                        {r.customerName}
                        {r.isSigned ? <span className="inline-flex items-center gap-0.5 text-[11px] text-emerald-700"><Check size={11} /> Firmado</span> : null}
                      </div>
                      <div className="text-xs text-ink-500">
                        Plan {r.number ?? '—'} · {r.view.installmentCount} cuotas · cobrado {usd(r.paidUsd)}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-semibold text-ink-900">{usd(r.outstandingUsd)}</div>
                      {r.nextDue ? (
                        <div className={`text-xs ${r.overdueCount > 0 ? 'text-red-600' : 'text-ink-500'}`}>
                          {r.overdueCount > 0
                            ? <span className="inline-flex items-center gap-1"><AlertTriangle size={11} /> {r.overdueCount} vencida{r.overdueCount > 1 ? 's' : ''}</span>
                            : `Próx. ${formatDate(r.nextDue.dueAt)}`}
                        </div>
                      ) : null}
                    </div>
                  </button>

                  {open ? (
                    <div className="border-t border-ink-100 px-4 py-3 space-y-3">
                      <div className="flex items-center justify-between text-xs">
                        <Link to={`/quotes/${r.quoteId}`} className="inline-flex items-center gap-1 text-brand-700 hover:text-brand-900">
                          <FileText size={13} /> Abrir cotización
                        </Link>
                        <Link to="/accounting/cuentas?tab=cxc" className="text-ink-500 hover:text-ink-800">Estado de cuenta →</Link>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-[11px] uppercase tracking-wide text-ink-500 border-b border-ink-100">
                              <th className="text-left py-1.5 px-2">#</th>
                              <th className="text-left py-1.5 px-2">Vence</th>
                              <th className="text-right py-1.5 px-2">Cuota</th>
                              <th className="text-right py-1.5 px-2">DOP</th>
                              <th className="text-center py-1.5 px-2">Cobro</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.view.installments.map((c) => (
                              <tr key={c.n} className={`border-b border-ink-50 ${c.isOverdue ? 'bg-red-50/50' : ''}`}>
                                <td className="py-1.5 px-2 text-ink-500">{c.n}</td>
                                <td className="py-1.5 px-2 text-ink-700">{formatDate(c.dueAt)}</td>
                                <td className="py-1.5 px-2 text-right font-medium text-ink-900">{usd(c.amount)}</td>
                                <td className="py-1.5 px-2 text-right text-ink-500">{dop(c.amount)}</td>
                                <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                  {c.isPaid ? (
                                    <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><Check size={13} /> {formatDate(c.paidAt)}</span>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => collect(plansQ.data.find((p) => p.id === r.planId), c.n)}
                                      disabled={!!collecting}
                                      className="text-xs text-brand-700 hover:text-brand-900 inline-flex items-center gap-1 disabled:opacity-50"
                                    >
                                      {collecting === `${r.planId}:${c.n}` ? <Loader2 size={12} className="animate-spin" /> : null}
                                      Registrar cobro
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </AccountingGate>
  );
}

function Kpi({ label, value, sub, tone = 'default' }) {
  return (
    <div className={`rounded-lg border px-4 py-3 ${tone === 'danger' ? 'border-red-200 bg-red-50/50' : 'border-ink-100 bg-surface'}`}>
      <div className="text-[10px] uppercase tracking-wide text-ink-500">{label}</div>
      <div className={`text-lg font-bold mt-0.5 ${tone === 'danger' ? 'text-red-700' : 'text-ink-900'}`}>{value}</div>
      {sub ? <div className="text-[11px] text-ink-400">{sub}</div> : null}
    </div>
  );
}
