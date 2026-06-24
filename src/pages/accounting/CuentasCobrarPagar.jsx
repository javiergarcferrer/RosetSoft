import { userMessageFor } from '../../lib/errorMessages.js';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeftRight, Plus, Loader2, Check, X, FileText, Printer, Send, ListChecks, Share2 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { postPaymentTx } from '../../lib/paymentPosting.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import { useToast } from '../../components/ConfirmProvider.jsx';
import TabPills from '../../components/accounting/TabPills.jsx';
import RowCards from '../../components/RowCards.jsx';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { cleanRnc } from '../../lib/rncLookup.js';
import { newShareToken, statementLinkUrl } from '../../lib/accountStatementShare.js';
import PrintPdfModal from '../../components/PrintPdfModal.jsx';
import {
  resolveReceivables, resolvePayables, resolveStatementFor,
  buildPaymentEntry, paymentNet, resolveAccountingConfig, resolveCollectionsQueue,
} from '../../core/accounting/index.js';

// Aging table columns (Shopify "edit columns"). The party column is the fixed
// identity anchor (`canHide: false`) — its header label is dynamic (Cliente /
// Proveedor) so it's not offered in the menu; the buckets and balance toggle.
// Each `cell` is a pure render off the per-row `ctx` the row assembles.
const AGING_COLUMNS = [
  {
    key: 'party', label: 'Cliente/Proveedor', canHide: false,
    tdClass: 'font-medium min-w-[120px]',
    cell: ({ r }) => r.party?.name || '—',
  },
  {
    key: 'd0_30', label: '0–30',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => formatDop(r.buckets.d0_30),
  },
  {
    key: 'd31_60', label: '31–60',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => formatDop(r.buckets.d31_60),
  },
  {
    key: 'd61_90', label: '61–90',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => formatDop(r.buckets.d61_90),
  },
  {
    key: 'd90', label: '+90',
    thClass: 'text-right whitespace-nowrap',
    tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => <span className={r.buckets.d90 > 0 ? 'text-rose-600' : ''}>{formatDop(r.buckets.d90)}</span>,
  },
  {
    key: 'balance', label: 'Balance',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums font-semibold whitespace-nowrap',
    cell: ({ r }) => formatDop(r.balance),
  },
];
const AGING_DEFAULT = { d0_30: true, d31_60: true, d61_90: true, d90: true, balance: true };

// Estado de cuenta columns. The fecha column is the fixed anchor; concepto,
// ref, cargo, abono and saldo toggle.
const STATEMENT_COLUMNS = [
  {
    key: 'date', label: 'Fecha', canHide: false,
    thClass: 'whitespace-nowrap', tdClass: 'text-ink-500 whitespace-nowrap',
    cell: ({ r }) => formatDate(r.date),
  },
  {
    key: 'concept', label: 'Concepto',
    cell: ({ r }) => r.label,
  },
  {
    key: 'ref', label: 'Ref.',
    tdClass: 'tabular-nums text-ink-500 whitespace-nowrap',
    cell: ({ r }) => r.ref || '—',
  },
  {
    key: 'charge', label: 'Cargo',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => (r.charge ? formatDop(r.charge) : ''),
  },
  {
    key: 'payment', label: 'Abono',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => (r.payment ? formatDop(r.payment) : ''),
  },
  {
    key: 'balance', label: 'Saldo',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums font-medium whitespace-nowrap',
    cell: ({ r }) => formatDop(r.balance),
  },
];
const STATEMENT_DEFAULT = { concept: true, ref: true, charge: true, payment: true, balance: true };

/**
 * Cuentas por cobrar y pagar — open balances with FIFO aging, register cobros
 * (incl. the card-gateway deductions) and pagos, and per-party estado de cuenta.
 * Each payment posts a balanced asiento. Self-gates on accounting/admin.
 */
export default function CuentasCobrarPagar() {
  const { profileId, settings } = useApp();
  const scope = profileId || 'team';
  const toast = useToast();
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const salesQ = useLiveQueryStatus(() => db.salesPostings.where('profileId').equals(scope).toArray(), [scope], []);
  const customersQ = useLiveQueryStatus(() => db.customers.where('profileId').equals(scope).toArray(), [scope], []);
  const purchasesQ = useLiveQueryStatus(() => db.purchases.where('profileId').equals(scope).toArray(), [scope], []);
  const expensesQ = useLiveQueryStatus(() => db.expenses.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const paymentsQ = useLiveQueryStatus(() => db.payments.where('profileId').equals(scope).toArray(), [scope], []);
  const remindersQ = useLiveQueryStatus(() => db.collectionReminders.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = salesQ.loaded && customersQ.loaded && purchasesQ.loaded && expensesQ.loaded && suppliersQ.loaded && paymentsQ.loaded && remindersQ.loaded;

  const customersById = useMemo(() => new Map(customersQ.data.map((c) => [c.id, c])), [customersQ.data]);
  const suppliersById = useMemo(() => new Map(suppliersQ.data.map((s) => [s.id, s])), [suppliersQ.data]);

  const receivables = useMemo(() => resolveReceivables({ salesPostings: salesQ.data, payments: paymentsQ.data, customersById }),
    [salesQ.data, paymentsQ.data, customersById]);
  const payables = useMemo(() => resolvePayables({ purchases: purchasesQ.data, expenses: expensesQ.data, payments: paymentsQ.data, suppliersById }),
    [purchasesQ.data, expensesQ.data, paymentsQ.data, suppliersById]);
  // Cobranza queue — who to chase today (escalating cadence, status-gated).
  const collections = useMemo(
    () => resolveCollectionsQueue({ receivables, reminders: remindersQ.data, policy: settings?.dunningPolicy, now: Date.now() }),
    [receivables, remindersQ.data, settings],
  );

  const [params] = useSearchParams();
  const urlTab = params.get('tab');
  const [tab, setTab] = useState(urlTab === 'cxc' || urlTab === 'cxp' ? urlTab : params.get('new') === 'out' ? 'cxp' : 'cxc'); // 'cxc' | 'cxp'
  const [showForm, setShowForm] = useState(!!params.get('new'));
  const [payBills, setPayBills] = useState(false);
  // ?statement=<partyId> deep-links straight into a party's estado de cuenta
  // (the CustomerDetail "Cuenta" card uses it).
  const [selected, setSelected] = useState(() => (params.get('statement')
    ? { type: tab === 'cxp' ? 'supplier' : 'customer', id: params.get('statement') }
    : null)); // { type, id }
  const [printingSt, setPrintingSt] = useState(false);
  const [reminding, setReminding] = useState(null);

  // The estado de cuenta is a Model projection (core/accounting/receivables:
  // resolveStatementFor) — the same money rules as the aging views, so the
  // panel and the printed PDF can't disagree with the table that opened them.
  const statement = useMemo(
    () => resolveStatementFor({
      selected,
      salesPostings: salesQ.data, payments: paymentsQ.data,
      purchases: purchasesQ.data, expenses: expensesQ.data,
      customersById, suppliersById,
    }),
    [selected, salesQ.data, paymentsQ.data, purchasesQ.data, expensesQ.data, customersById, suppliersById],
  );

  // In-app print preview state — the modal rasterizes the PDF and prints via
  // window.print() on our own page, so printing can never become a download.
  const [printDoc, setPrintDoc] = useState(null);   // { blob, title } | null
  // Share a customer's estado de cuenta as a public link (mints the token once).
  async function shareStatement() {
    if (!selected || selected.type !== 'customer') return;
    let token = customersById.get(selected.id)?.statementToken;
    if (!token) { token = newShareToken(); await db.customers.update(selected.id, { statementToken: token }); }
    const url = statementLinkUrl(token);
    try { await navigator.clipboard.writeText(url); toast('Enlace del estado de cuenta copiado'); }
    catch { toast('No se pudo copiar el enlace', { tone: 'error' }); }
  }

  async function printStatement() {
    if (!statement || !selected) return;
    setPrintingSt(true);
    try {
      const party = selected.type === 'customer' ? customersById.get(selected.id) : suppliersById.get(selected.id);
      // The same per-party aging buckets the cobrar/pagar table shows — printed
      // as an "Antigüedad del saldo" strip on the statement.
      const src = selected.type === 'customer' ? receivables : payables;
      const aging = src.rows.find((r) => r.partyId === selected.id)?.buckets;
      const mod = await safeDynamicImport(() => import('../../pdf/accounting/index.js'));
      const blob = await mod.generateStatementPdf({
        emisor: { name: settings?.companyName || '', rnc: cleanRnc(settings?.companyRnc) },
        party: { name: statement.name, rnc: party?.rnc },
        title: selected.type === 'customer' ? 'Estado de cuenta — cliente' : 'Estado de cuenta — proveedor',
        rows: statement.rows, balance: statement.balance, asOf: Date.now(), aging,
      });
      setPrintDoc({ blob, title: 'Estado de cuenta' });
    } catch (e) {
      window.alert(userMessageFor(e));
    } finally {
      setPrintingSt(false);
    }
  }

  // Draft the reminder in WhatsApp for the dealer to review + send (never
  // auto-sent), then log it so the cadence doesn't nudge the same step twice.
  async function remind(r) {
    const due = r.dueReminders && r.dueReminders[0];
    if (!due) return;
    setReminding(r.partyId);
    try {
      const phone = String(r.party?.phone || '').replace(/\D/g, '');
      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(due.message)}`, '_blank', 'noopener');
      await db.collectionReminders.put({
        id: newId(), profileId: scope, customerId: r.partyId, docId: due.docId, docType: 'sale',
        channel: due.channel, stepOffset: due.stepOffset, message: due.message, status: 'sent', sentAt: Date.now(),
      });
    } finally {
      setReminding(null);
    }
  }

  const view = tab === 'cxc' ? receivables : payables;
  const partyLabel = tab === 'cxc' ? 'Cliente' : 'Proveedor';
  const docsByParty = new Map(view.rows.map((r) => [r.partyId, r.docs || []]));

  // Column visibility (Shopify "edit columns"), persisted per browser. The
  // aging table keys per tab (cobrar / pagar) so each side remembers its own
  // column choice; the estado de cuenta has its own key.
  const aging = useColumns(AGING_COLUMNS, AGING_DEFAULT, tab === 'cxc' ? 'rs.cuentas.cobrar.cols.v1' : 'rs.cuentas.pagar.cols.v1');
  const stmtCols = useColumns(STATEMENT_COLUMNS, STATEMENT_DEFAULT, 'rs.cuentas.statement.cols.v1');
  // Drag-to-resize widths (persisted) for the same visible columns — keyed per
  // side so cobrar/pagar each keep their own widths, like the visibility keys.
  const agingW = useColumnWidths(aging.cols, tab === 'cxc' ? 'rs.cuentas.cobrar.widths.v1' : 'rs.cuentas.pagar.widths.v1');
  const stmtW = useColumnWidths(stmtCols.cols, 'rs.cuentas.statement.widths.v1');

  return (
    <AccountingGate title="Cuentas por cobrar y pagar">
      <PageHeader title="Cuentas por cobrar y pagar" subtitle="Saldos, antigüedad y estados de cuenta — valores en RD$"
        actions={tab === 'cobranza' ? null : (
          <div className="flex items-center gap-2">
            {tab === 'cxp' && (
              <button type="button" onClick={() => { setPayBills((v) => !v); setShowForm(false); setSelected(null); }}
                className="btn-ghost"><ListChecks size={14} /> Pagar facturas</button>
            )}
            <button type="button" onClick={() => { setShowForm((v) => !v); setPayBills(false); setSelected(null); }}
              className="btn-primary"><Plus size={15} /> Registrar {tab === 'cxc' ? 'cobro' : 'pago'}</button>
          </div>
        )} />

      <TabPills tabs={[{ key: 'cxc', label: 'Por cobrar' }, { key: 'cxp', label: 'Por pagar' }, { key: 'cobranza', label: 'Cobranza' }]}
        active={tab} onChange={(k) => { setTab(k); setSelected(null); setShowForm(false); }} />
      {loaded && tab !== 'cobranza' && (
        <p className="text-sm text-ink-500 -mt-2 mb-4">
          Balance total <b className="tabular-nums text-ink-800">{formatDop(view.totals.balance)}</b>
        </p>
      )}

      {showForm && loaded && (
        <PaymentForm
          direction={tab === 'cxc' ? 'in' : 'out'} scope={scope} config={config}
          parties={tab === 'cxc' ? customersQ.data : suppliersQ.data}
          docsByParty={docsByParty}
          initial={{
            partyId: params.get('party') || '',
            amount: params.get('amount') || '',
            reference: params.get('ref') || '',
          }}
          onClose={() => setShowForm(false)} />
      )}

      {tab === 'cxp' && payBills && loaded && (
        <PayBillsPanel
          bills={payables.rows.flatMap((r) => (r.docs || []).filter((d) => d.open > 0.001).map((d) => ({ ...d, supplierId: r.partyId, supplierName: r.party?.name || '—' })))}
          scope={scope} config={config} onClose={() => setPayBills(false)} />
      )}

      {!loaded ? <ListLoading /> : tab === 'cobranza' ? (
        <CobranzaView queue={collections} onRemind={remind} busyId={reminding} />
      ) : view.count === 0 ? (
        <EmptyState icon={ArrowLeftRight} title={tab === 'cxc' ? 'Nada por cobrar' : 'Nada por pagar'}
          description={tab === 'cxc' ? 'Las facturas con saldo pendiente aparecen aquí.' : 'Las compras y gastos a crédito con saldo aparecen aquí.'} />
      ) : (
        <>
        <RowCards
          rows={view.rows.map((r) => ({
            key: r.partyId,
            title: r.party?.name || '—',
            right: formatDop(r.balance),
            sub: <span className="inline-flex items-center gap-1"><FileText size={11} /> Estado de cuenta</span>,
            onClick: () => setSelected({ type: tab === 'cxc' ? 'customer' : 'supplier', id: r.partyId }),
            kv: [
              ['0–30', formatDop(r.buckets.d0_30)],
              ['31–60', formatDop(r.buckets.d31_60)],
              ['61–90', formatDop(r.buckets.d61_90)],
              ['+90', <span className={r.buckets.d90 > 0 ? 'text-rose-600' : ''}>{formatDop(r.buckets.d90)}</span>],
            ],
          }))}
          footer={[
            [partyLabel + 's', view.count],
            ['Balance', formatDop(view.totals.balance)],
            ['0–30', formatDop(view.totals.d0_30)],
            ['31–60', formatDop(view.totals.d31_60)],
            ['61–90', formatDop(view.totals.d61_90)],
            ['+90', formatDop(view.totals.d90)],
          ]}
        />
        <div className="hidden md:block">
          <div className="flex justify-end mb-2">
            <ColumnsMenu columns={aging.columns} visible={aging.visible} onChange={aging.setVisible} onReset={() => { aging.reset(); agingW.reset(); }} />
          </div>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table ref={agingW.tableRef} style={agingW.tableStyle} className="table min-w-[640px]">
                <thead>
                  <tr>
                    {aging.cols.map((col) => (
                      <th key={col.key} className={col.thClass || ''} {...agingW.thProps(col.key)}>{col.key === 'party' ? partyLabel : col.label}{agingW.ResizeHandle(col.key)}</th>
                    ))}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((r) => {
                    const ctx = { r };
                    return (
                      <tr key={r.partyId}>
                        {aging.cols.map((col) => (
                          <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                        ))}
                        <td className="text-right">
                          <button type="button" onClick={() => setSelected({ type: tab === 'cxc' ? 'customer' : 'supplier', id: r.partyId })}
                            className="text-xs text-ink-600 hover:text-ink-900 active:text-ink-700 inline-flex items-center gap-1 min-h-8 coarse:min-h-11 whitespace-nowrap"><FileText size={13} /> Estado</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-ink-200 font-semibold">
                    {aging.cols.map((col) => {
                      if (col.key === 'party') return <td key={col.key}>{view.count} {partyLabel.toLowerCase()}s</td>;
                      const total = col.key === 'balance' ? view.totals.balance : view.totals[col.key];
                      return <td key={col.key} className="text-right tabular-nums whitespace-nowrap">{formatDop(total)}</td>;
                    })}
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
        </>
      )}

      {statement && (
        <div className="card p-4 mt-4 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <h3 className="font-display font-semibold break-words min-w-0">Estado de cuenta — {statement.name}</h3>
            <div className="flex items-center gap-2 shrink-0">
              {selected?.type === 'customer' && (
                <button type="button" onClick={shareStatement} className="btn-ghost"><Share2 size={14} /> Compartir</button>
              )}
              <button type="button" onClick={printStatement} disabled={printingSt}
                className="btn-ghost">
                {printingSt ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />} Imprimir
              </button>
              <button type="button" onClick={() => setSelected(null)} className="btn-icon text-ink-400" aria-label="Cerrar"><X size={18} /></button>
            </div>
          </div>
          <RowCards
            rows={statement.rows.map((r, i) => ({
              key: i,
              title: r.label,
              right: formatDop(r.balance),
              sub: r.ref || null,
              kv: [
                ['Fecha', formatDate(r.date)],
                r.charge ? ['Cargo', formatDop(r.charge)] : null,
                r.payment ? ['Abono', formatDop(r.payment)] : null,
              ],
            }))}
          />
          <div className="hidden md:block">
            <div className="flex justify-end mb-2">
              <ColumnsMenu columns={stmtCols.columns} visible={stmtCols.visible} onChange={stmtCols.setVisible} onReset={() => { stmtCols.reset(); stmtW.reset(); }} />
            </div>
            <div className="overflow-x-auto">
              <table ref={stmtW.tableRef} style={stmtW.tableStyle} className="table min-w-[560px]">
                <thead>
                  <tr>
                    {stmtCols.cols.map((col) => (
                      <th key={col.key} className={col.thClass || ''} {...stmtW.thProps(col.key)}>{col.label}{stmtW.ResizeHandle(col.key)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {statement.rows.map((r, i) => {
                    const ctx = { r };
                    return (
                      <tr key={i}>
                        {stmtCols.cols.map((col) => (
                          <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {printDoc && (
        <PrintPdfModal blob={printDoc.blob} title={printDoc.title} onClose={() => setPrintDoc(null)} />
      )}
    </AccountingGate>
  );
}

/**
 * Cobranza — the collections queue: open customers ranked by balance × age,
 * with a one-click "Recordar" that drafts the escalating reminder in WhatsApp
 * for the dealer to review and send (human-in-the-loop). Paid invoices and
 * already-sent steps drop out via the cadence in the VM.
 */
function CobranzaView({ queue, onRemind, busyId }) {
  if (queue.count === 0) {
    return <EmptyState icon={Send} title="Nada que cobrar" description="Las facturas con saldo pendiente aparecen aquí para gestionar el cobro." />;
  }
  return (
    <>
      <p className="text-sm text-ink-500 -mt-2 mb-3">
        <b className="text-ink-800">{queue.dueCount}</b> cliente(s) para contactar hoy · <b className="tabular-nums text-ink-800">{formatDop(queue.totalDue)}</b> por cobrar
      </p>
      <div className="space-y-2">
        {queue.rows.map((r) => (
          <div key={r.partyId} className="card p-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">{r.party?.name || '—'}</div>
              <div className="text-xs text-ink-500">
                {r.oldestDays > 0 ? `${r.oldestDays} días de atraso` : 'Al día'}
                {r.lastSentAt ? ` · última gestión ${formatDate(r.lastSentAt)}` : ''}
              </div>
            </div>
            {r.buckets.d90 > 0 && <span className="text-[11px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 whitespace-nowrap">+90: {formatDop(r.buckets.d90)}</span>}
            <div className="text-right tabular-nums font-semibold whitespace-nowrap">{formatDop(r.balance)}</div>
            <button type="button" disabled={!r.dueCount || busyId === r.partyId} onClick={() => onRemind(r)}
              className="btn-primary disabled:opacity-40 whitespace-nowrap"
              title={r.dueCount ? 'Abrir WhatsApp con el recordatorio' : 'Sin recordatorio pendiente hoy'}>
              {busyId === r.partyId ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Recordar
            </button>
          </div>
        ))}
      </div>
      <p className="text-xs text-ink-400 mt-3">Los recordatorios se abren en WhatsApp para revisarlos y enviarlos — no se envían solos.</p>
    </>
  );
}

/**
 * Pay-bills batch — select open supplier bills and register a pago for each in
 * one action (each allocated to its bill, posting a balanced asiento). The
 * QuickBooks "Pay Bills" flow.
 */
function PayBillsPanel({ bills, scope, config, onClose }) {
  const [sel, setSel] = useState({});
  const [method, setMethod] = useState('bank');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const chosen = bills.filter((b) => sel[b.docId]);
  const total = chosen.reduce((s, b) => s + b.open, 0);
  const allOn = bills.length > 0 && chosen.length === bills.length;

  async function pay() {
    if (!chosen.length) return;
    setErr(''); setSaving(true);
    try {
      const postedAt = new Date(date).getTime();
      for (const b of chosen) {
        const id = newId();
        const payment = { id, direction: 'out', partyType: 'supplier', partyId: b.supplierId, amount: b.open, method, commission: 0, commissionItbis: 0, itbisRetained: 0, isrRetained: 0 };
        const built = buildPaymentEntry({ newId, config, postedAt, payment });
        // Asiento + lines + payments row in ONE transaction (numbers assigned
        // server-side) — never an orphan asiento that lets the bill be paid twice.
        await postPaymentTx({
          entry: built.entry,
          lines: built.lines,
          payment: { ...payment, profileId: scope, paidAt: postedAt, allocations: [{ docId: b.docId, amount: b.open }], journalEntryId: built.entry.id },
        });
      }
      onClose();
    } catch (e) { setErr(userMessageFor(e)); setSaving(false); }
  }

  return (
    <div className="card p-4 mb-4 border-ink-300 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display font-semibold">Pagar facturas</h3>
        <button type="button" onClick={onClose} className="btn-icon text-ink-400 shrink-0" aria-label="Cerrar"><X size={18} /></button>
      </div>
      {bills.length === 0 ? (
        <p className="text-sm text-ink-500">No hay facturas a crédito con saldo.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3 mb-3">
            <label className="text-sm">Fecha<br /><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input" /></label>
            <label className="text-sm">Desde<br />
              <select value={method} onChange={(e) => setMethod(e.target.value)} className="input">
                <option value="bank">Banco</option><option value="cash">Efectivo</option>
              </select>
            </label>
            <button type="button" onClick={() => { const next = {}; if (!allOn) bills.forEach((b) => { next[b.docId] = true; }); setSel(next); }}
              className="text-xs text-ink-600 hover:text-ink-900 min-h-8">{allOn ? 'Quitar todos' : 'Seleccionar todos'}</button>
          </div>
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {bills.map((b) => (
              <label key={b.docId} className="flex items-center gap-2 text-sm border border-ink-50 rounded-lg p-2 cursor-pointer">
                <input type="checkbox" checked={!!sel[b.docId]} onChange={(e) => setSel((m) => ({ ...m, [b.docId]: e.target.checked }))} />
                <span className="flex-1 min-w-0 truncate">{b.supplierName} · {b.label} <span className="text-ink-400">{formatDate(b.date)}</span></span>
                <span className="tabular-nums whitespace-nowrap">{formatDop(b.open)}</span>
              </label>
            ))}
          </div>
          {err && <p className="text-sm text-rose-600 mt-3">{err}</p>}
          <div className="flex items-center justify-between mt-4">
            <span className="text-sm text-ink-600">{chosen.length} factura(s) · <b className="tabular-nums">{formatDop(total)}</b></span>
            <button type="button" onClick={pay} disabled={saving || !chosen.length} className="btn-primary">{saving ? <Loader2 size={14} className="animate-spin" /> : null} Registrar pagos</button>
          </div>
        </>
      )}
    </div>
  );
}

function PaymentForm({ direction, scope, config, parties, docsByParty, initial, onClose }) {
  // `initial` seeds the deposit→cobro handoff (?party&amount&ref from a quote
  // milestone) so the accountant doesn't re-type what the CRM already knows.
  const [form, setForm] = useState({
    partyId: initial?.partyId || '', date: new Date().toISOString().slice(0, 10),
    amount: initial?.amount || '', method: 'bank', reference: initial?.reference || '',
    commission: '', commissionItbis: '', itbisRetained: '', isrRetained: '',
  });
  const [alloc, setAlloc] = useState({}); // docId -> amount string
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const isCard = form.method === 'card' && direction === 'in';
  const openDocs = (docsByParty && docsByParty.get(form.partyId)) || [];

  function autoFill() {
    let remaining = Number(form.amount) || 0;
    const next = {};
    for (const d of openDocs) {
      if (remaining <= 0) break;
      const applied = Math.min(d.open, remaining);
      if (applied > 0) { next[d.docId] = String(Math.round(applied * 100) / 100); remaining = Math.round((remaining - applied) * 100) / 100; }
    }
    setAlloc(next);
  }

  const net = paymentNet({
    amount: Number(form.amount) || 0, commission: Number(form.commission) || 0,
    commissionItbis: Number(form.commissionItbis) || 0, itbisRetained: Number(form.itbisRetained) || 0,
    isrRetained: Number(form.isrRetained) || 0,
  });

  async function save() {
    setErr('');
    const amount = Number(form.amount) || 0;
    if (!form.partyId) { setErr('Elige el ' + (direction === 'in' ? 'cliente' : 'proveedor') + '.'); return; }
    if (amount <= 0) { setErr('El monto debe ser mayor que cero.'); return; }
    const allocations = openDocs
      .map((d) => ({ docId: d.docId, amount: Number(alloc[d.docId]) || 0 }))
      .filter((a) => a.amount > 0);
    // A payment can never allocate more than it received — otherwise the aging
    // would over-clear invoices (each doc dropped past what was actually paid).
    const allocSum = Math.round(allocations.reduce((s, a) => s + a.amount, 0) * 100) / 100;
    if (allocSum - amount > 0.005) {
      setErr(`Las asignaciones (${formatDop(allocSum)}) superan el monto del pago (${formatDop(amount)}).`);
      return;
    }
    setSaving(true);
    try {
      const id = newId();
      const postedAt = new Date(form.date).getTime();
      const payment = {
        id, direction, partyType: direction === 'in' ? 'customer' : 'supplier', partyId: form.partyId,
        amount, method: form.method, reference: form.reference,
        commission: Number(form.commission) || 0, commissionItbis: Number(form.commissionItbis) || 0,
        itbisRetained: Number(form.itbisRetained) || 0, isrRetained: Number(form.isrRetained) || 0,
      };
      const built = buildPaymentEntry({ newId, config, postedAt, payment });
      // Asiento + lines + payments row in ONE transaction (numbers assigned
      // server-side), so a mid-way failure can't leave a paid-looking asiento
      // with no payment row (which would let the same cobro be entered twice).
      await postPaymentTx({
        entry: built.entry,
        lines: built.lines,
        payment: { ...payment, profileId: scope, paidAt: postedAt, allocations, journalEntryId: built.entry.id },
      });
      onClose();
    } catch (e) {
      setErr(userMessageFor(e));
      setSaving(false);
    }
  }

  const field = 'input';
  const numField = 'input text-right tabular-nums';

  return (
    <div className="card p-4 mb-4 border-ink-300 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display font-semibold">Registrar {direction === 'in' ? 'cobro' : 'pago'}</h3>
        <button type="button" onClick={onClose} className="btn-icon text-ink-400 shrink-0" aria-label="Cerrar"><X size={18} /></button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap items-end gap-3">
        <label className="text-sm">{direction === 'in' ? 'Cliente' : 'Proveedor'}<br />
          <select value={form.partyId} onChange={(e) => { setForm((f) => ({ ...f, partyId: e.target.value })); setAlloc({}); }} className={`${field} w-full`}>
            <option value="">—</option>
            {parties.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-sm">Fecha<br /><input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className={`${field} w-full`} /></label>
        <label className="text-sm">Monto<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} className={numField} /></label>
        <label className="text-sm">Método<br />
          <select value={form.method} onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))} className={`${field} w-full`}>
            <option value="bank">Banco</option><option value="cash">Efectivo</option><option value="transfer">Transferencia</option>
            {direction === 'in' && <option value="card">Tarjeta</option>}
          </select>
        </label>
        <label className="text-sm">Referencia<br /><input value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} className={`${field} w-full`} /></label>
      </div>

      {isCard && (
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-end gap-3 mt-3 pt-3 border-t border-ink-100">
          <span className="text-xs text-ink-500 col-span-2 sm:w-full">Deducciones de la pasarela (lo que retiene el procesador):</span>
          <label className="text-sm">Comisión<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={form.commission} onChange={(e) => setForm((f) => ({ ...f, commission: e.target.value }))} className={numField} /></label>
          <label className="text-sm">ITBIS comisión<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={form.commissionItbis} onChange={(e) => setForm((f) => ({ ...f, commissionItbis: e.target.value }))} className={numField} /></label>
          <label className="text-sm">ITBIS retenido<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={form.itbisRetained} onChange={(e) => setForm((f) => ({ ...f, itbisRetained: e.target.value }))} className={numField} /></label>
          <label className="text-sm">ISR retenido<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={form.isrRetained} onChange={(e) => setForm((f) => ({ ...f, isrRetained: e.target.value }))} className={numField} /></label>
        </div>
      )}

      {form.partyId && openDocs.length > 0 && (
        <div className="mt-3 pt-3 border-t border-ink-100">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-ink-500">Aplicar a facturas (opcional)</span>
            <button type="button" onClick={autoFill} className="text-xs text-ink-600 hover:text-ink-900 active:text-ink-700 inline-flex items-center min-h-8 coarse:min-h-11">Auto (FIFO)</button>
          </div>
          <div className="space-y-2">
            {openDocs.map((d) => (
              <div key={d.docId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-ink-500 shrink-0 whitespace-nowrap">{formatDate(d.date)}</span>
                <span className="flex-1 min-w-0">{d.label} · pendiente <span className="whitespace-nowrap tabular-nums">{formatDop(d.open)}</span></span>
                <input type="number" step="0.01" min="0" inputMode="decimal" value={alloc[d.docId] || ''}
                  onChange={(e) => setAlloc((a) => ({ ...a, [d.docId]: e.target.value }))}
                  className="input w-28 text-right tabular-nums" />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 mt-3 pt-3 border-t border-ink-100">
        {isCard ? <div className="text-sm text-ink-600">Neto al banco <b className="tabular-nums">{formatDop(net)}</b></div> : <span />}
        <button type="button" onClick={save} disabled={saving} className="btn-primary">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Registrar
        </button>
      </div>
      {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
    </div>
  );
}
