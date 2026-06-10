import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Shield, ArrowLeftRight, Plus, Loader2, Check, X, FileText, Printer } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import PrintPdfModal from '../../components/PrintPdfModal.jsx';
import {
  resolveReceivables, resolvePayables, resolvePartyStatement,
  buildPaymentEntry, paymentNet, resolveAccountingConfig,
} from '../../core/accounting/index.js';

/**
 * Cuentas por cobrar y pagar — open balances with FIFO aging, register cobros
 * (incl. the card-gateway deductions) and pagos, and per-party estado de cuenta.
 * Each payment posts a balanced asiento. Self-gates on accounting/admin.
 */
export default function CuentasCobrarPagar() {
  const { profileId, currentProfile, settings } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const salesQ = useLiveQueryStatus(() => db.salesPostings.where('profileId').equals(scope).toArray(), [scope], []);
  const customersQ = useLiveQueryStatus(() => db.customers.where('profileId').equals(scope).toArray(), [scope], []);
  const purchasesQ = useLiveQueryStatus(() => db.purchases.where('profileId').equals(scope).toArray(), [scope], []);
  const expensesQ = useLiveQueryStatus(() => db.expenses.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const paymentsQ = useLiveQueryStatus(() => db.payments.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = salesQ.loaded && customersQ.loaded && purchasesQ.loaded && expensesQ.loaded && suppliersQ.loaded && paymentsQ.loaded;

  const customersById = useMemo(() => new Map(customersQ.data.map((c) => [c.id, c])), [customersQ.data]);
  const suppliersById = useMemo(() => new Map(suppliersQ.data.map((s) => [s.id, s])), [suppliersQ.data]);

  const receivables = useMemo(() => resolveReceivables({ salesPostings: salesQ.data, payments: paymentsQ.data, customersById }),
    [salesQ.data, paymentsQ.data, customersById]);
  const payables = useMemo(() => resolvePayables({ purchases: purchasesQ.data, expenses: expensesQ.data, payments: paymentsQ.data, suppliersById }),
    [purchasesQ.data, expensesQ.data, paymentsQ.data, suppliersById]);

  const [params] = useSearchParams();
  const [tab, setTab] = useState(params.get('new') === 'out' ? 'cxp' : 'cxc'); // 'cxc' | 'cxp'
  const [showForm, setShowForm] = useState(!!params.get('new'));
  const [selected, setSelected] = useState(null); // { type, id }
  const [printingSt, setPrintingSt] = useState(false);

  const statement = useMemo(() => {
    if (!selected) return null;
    if (selected.type === 'customer') {
      const charges = salesQ.data.filter((s) => s.customerId === selected.id)
        .map((s) => ({ date: s.postedAt, amount: (s.total || 0) - (s.depositApplied || 0), label: 'Factura', ref: s.ncf || '' }))
        .filter((c) => c.amount > 0.001);
      const payments = paymentsQ.data.filter((p) => p.direction === 'in' && p.partyId === selected.id)
        .map((p) => ({ date: p.paidAt, amount: p.amount, label: 'Cobro', ref: p.reference || '' }));
      return { name: customersById.get(selected.id)?.name || 'Cliente', ...resolvePartyStatement({ charges, payments }) };
    }
    const credit = (arr, df) => arr.filter((d) => d.paymentMethod === 'credit' && d.supplierId === selected.id)
      .map((d) => ({ date: d[df], amount: (d.base || 0) + (d.itbis || 0) - (d.retentionIsr || 0) - (d.retentionItbis || 0), label: df === 'purchaseAt' ? 'Compra' : 'Gasto', ref: d.ncf || '' }));
    const charges = [...credit(purchasesQ.data, 'purchaseAt'), ...credit(expensesQ.data, 'expenseAt')];
    const payments = paymentsQ.data.filter((p) => p.direction === 'out' && p.partyId === selected.id)
      .map((p) => ({ date: p.paidAt, amount: p.amount, label: 'Pago', ref: p.reference || '' }));
    return { name: suppliersById.get(selected.id)?.name || 'Proveedor', ...resolvePartyStatement({ charges, payments }) };
  }, [selected, salesQ.data, paymentsQ.data, purchasesQ.data, expensesQ.data, customersById, suppliersById]);

  // In-app print preview state — the modal rasterizes the PDF and prints via
  // window.print() on our own page, so printing can never become a download.
  const [printDoc, setPrintDoc] = useState(null);   // { blob, title } | null
  async function printStatement() {
    if (!statement || !selected) return;
    setPrintingSt(true);
    try {
      const party = selected.type === 'customer' ? customersById.get(selected.id) : suppliersById.get(selected.id);
      const mod = await safeDynamicImport(() => import('../../pdf/accounting/index.js'));
      const blob = await mod.generateStatementPdf({
        emisor: { name: settings?.companyName || '', rnc: (settings?.companyRnc || '').replace(/\D/g, '') },
        party: { name: statement.name, rnc: party?.rnc },
        title: selected.type === 'customer' ? 'Estado de cuenta — cliente' : 'Estado de cuenta — proveedor',
        rows: statement.rows, balance: statement.balance, asOf: Date.now(),
      });
      setPrintDoc({ blob, title: 'Estado de cuenta' });
    } catch (e) {
      window.alert(e?.message || 'No se pudo generar el estado de cuenta.');
    } finally {
      setPrintingSt(false);
    }
  }

  if (!allowed) {
    return (
      <>
        <PageHeader title="Cuentas por cobrar y pagar" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  const view = tab === 'cxc' ? receivables : payables;
  const partyLabel = tab === 'cxc' ? 'Cliente' : 'Proveedor';
  const docsByParty = new Map(view.rows.map((r) => [r.partyId, r.docs || []]));

  return (
    <>
      <PageHeader title="Cuentas por cobrar y pagar" subtitle="Saldos, antigüedad y estados de cuenta — valores en RD$"
        actions={<button type="button" onClick={() => { setShowForm((v) => !v); setSelected(null); }}
          className="btn-primary"><Plus size={15} /> Registrar {tab === 'cxc' ? 'cobro' : 'pago'}</button>} />

      <div className="flex flex-wrap gap-2 mb-4">
        <button type="button" onClick={() => { setTab('cxc'); setSelected(null); }} className={`btn ${tab === 'cxc' ? 'tab-pill-active' : 'tab-pill'}`}>Por cobrar</button>
        <button type="button" onClick={() => { setTab('cxp'); setSelected(null); }} className={`btn ${tab === 'cxp' ? 'tab-pill-active' : 'tab-pill'}`}>Por pagar</button>
        {loaded && (
          <span className="sm:ml-auto self-center text-sm text-ink-500">
            Balance total <b className="tabular-nums text-ink-800">{formatDop(view.totals.balance)}</b>
          </span>
        )}
      </div>

      {showForm && loaded && (
        <PaymentForm
          direction={tab === 'cxc' ? 'in' : 'out'} scope={scope} config={config}
          parties={tab === 'cxc' ? customersQ.data : suppliersQ.data}
          docsByParty={docsByParty}
          onClose={() => setShowForm(false)} />
      )}

      {!loaded ? <ListLoading /> : view.count === 0 ? (
        <EmptyState icon={ArrowLeftRight} title={tab === 'cxc' ? 'Nada por cobrar' : 'Nada por pagar'}
          description={tab === 'cxc' ? 'Las facturas con saldo pendiente aparecen aquí.' : 'Las compras y gastos a crédito con saldo aparecen aquí.'} />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table min-w-[640px]">
              <thead>
                <tr>
                  <th>{partyLabel}</th>
                  <th className="text-right whitespace-nowrap">0–30</th>
                  <th className="text-right whitespace-nowrap">31–60</th>
                  <th className="text-right whitespace-nowrap">61–90</th>
                  <th className="text-right whitespace-nowrap">+90</th>
                  <th className="text-right whitespace-nowrap">Balance</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((r) => (
                  <tr key={r.partyId}>
                    <td className="font-medium min-w-[120px]">{r.party?.name || '—'}</td>
                    <td className="text-right tabular-nums whitespace-nowrap">{formatDop(r.buckets.d0_30)}</td>
                    <td className="text-right tabular-nums whitespace-nowrap">{formatDop(r.buckets.d31_60)}</td>
                    <td className="text-right tabular-nums whitespace-nowrap">{formatDop(r.buckets.d61_90)}</td>
                    <td className={`text-right tabular-nums whitespace-nowrap ${r.buckets.d90 > 0 ? 'text-rose-600' : ''}`}>{formatDop(r.buckets.d90)}</td>
                    <td className="text-right tabular-nums font-semibold whitespace-nowrap">{formatDop(r.balance)}</td>
                    <td className="text-right">
                      <button type="button" onClick={() => setSelected({ type: tab === 'cxc' ? 'customer' : 'supplier', id: r.partyId })}
                        className="text-xs text-ink-600 hover:text-ink-900 active:text-ink-700 inline-flex items-center gap-1 min-h-8 coarse:min-h-11 whitespace-nowrap"><FileText size={13} /> Estado</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-ink-200 font-semibold">
                  <td>{view.count} {partyLabel.toLowerCase()}s</td>
                  <td className="text-right tabular-nums whitespace-nowrap">{formatDop(view.totals.d0_30)}</td>
                  <td className="text-right tabular-nums whitespace-nowrap">{formatDop(view.totals.d31_60)}</td>
                  <td className="text-right tabular-nums whitespace-nowrap">{formatDop(view.totals.d61_90)}</td>
                  <td className="text-right tabular-nums whitespace-nowrap">{formatDop(view.totals.d90)}</td>
                  <td className="text-right tabular-nums whitespace-nowrap">{formatDop(view.totals.balance)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {statement && (
        <div className="card p-4 mt-4 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <h3 className="font-semibold break-words min-w-0">Estado de cuenta — {statement.name}</h3>
            <div className="flex items-center gap-2 shrink-0">
              <button type="button" onClick={printStatement} disabled={printingSt}
                className="btn-ghost">
                {printingSt ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />} Imprimir
              </button>
              <button type="button" onClick={() => setSelected(null)} className="btn-icon text-ink-400" aria-label="Cerrar"><X size={18} /></button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="table min-w-[560px]">
              <thead>
                <tr>
                  <th className="whitespace-nowrap">Fecha</th>
                  <th>Concepto</th>
                  <th>Ref.</th>
                  <th className="text-right whitespace-nowrap">Cargo</th>
                  <th className="text-right whitespace-nowrap">Abono</th>
                  <th className="text-right whitespace-nowrap">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {statement.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="text-ink-500 whitespace-nowrap">{formatDate(r.date)}</td>
                    <td>{r.label}</td>
                    <td className="tabular-nums text-ink-500 whitespace-nowrap">{r.ref || '—'}</td>
                    <td className="text-right tabular-nums whitespace-nowrap">{r.charge ? formatDop(r.charge) : ''}</td>
                    <td className="text-right tabular-nums whitespace-nowrap">{r.payment ? formatDop(r.payment) : ''}</td>
                    <td className="text-right tabular-nums font-medium whitespace-nowrap">{formatDop(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {printDoc && (
        <PrintPdfModal blob={printDoc.blob} title={printDoc.title} onClose={() => setPrintDoc(null)} />
      )}
    </>
  );
}

function PaymentForm({ direction, scope, config, parties, docsByParty, onClose }) {
  const [form, setForm] = useState({
    partyId: '', date: new Date().toISOString().slice(0, 10), amount: '', method: 'bank', reference: '',
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
    setSaving(true);
    try {
      const id = newId();
      const postedAt = new Date(form.date).getTime();
      const built = buildPaymentEntry({
        newId, config, postedAt,
        payment: {
          id, direction, partyType: direction === 'in' ? 'customer' : 'supplier', partyId: form.partyId,
          amount, method: form.method, reference: form.reference,
          commission: Number(form.commission) || 0, commissionItbis: Number(form.commissionItbis) || 0,
          itbisRetained: Number(form.itbisRetained) || 0, isrRetained: Number(form.isrRetained) || 0,
        },
      });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      const allocations = openDocs
        .map((d) => ({ docId: d.docId, amount: Number(alloc[d.docId]) || 0 }))
        .filter((a) => a.amount > 0);
      await assignSequenceNumber({
        table: 'payments', profileId: scope, start: 1,
        build: (n) => ({
          id, profileId: scope, number: n, direction, partyType: direction === 'in' ? 'customer' : 'supplier',
          partyId: form.partyId, paidAt: postedAt, amount, method: form.method, reference: form.reference,
          commission: Number(form.commission) || 0, commissionItbis: Number(form.commissionItbis) || 0,
          itbisRetained: Number(form.itbisRetained) || 0, isrRetained: Number(form.isrRetained) || 0,
          allocations, journalEntryId: built.entry.id,
        }),
      });
      onClose();
    } catch (e) {
      setErr(e?.message || String(e));
      setSaving(false);
    }
  }

  const field = 'input';
  const numField = 'input text-right tabular-nums';

  return (
    <div className="card p-4 mb-4 border-ink-300 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Registrar {direction === 'in' ? 'cobro' : 'pago'}</h3>
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
