import { useMemo, useState } from 'react';
import { Shield, ArrowLeftRight, Plus, Loader2, Check, X, FileText, Printer } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
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

  const [tab, setTab] = useState('cxc'); // 'cxc' | 'cxp'
  const [showForm, setShowForm] = useState(false);
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

  async function printStatement() {
    if (!statement || !selected) return;
    setPrintingSt(true);
    try {
      const party = selected.type === 'customer' ? customersById.get(selected.id) : suppliersById.get(selected.id);
      const { generateStatementPdf, downloadBlob } = await safeDynamicImport(() => import('../../pdf/accounting/index.js'));
      const blob = await generateStatementPdf({
        emisor: { name: settings?.companyName || '', rnc: (settings?.companyRnc || '').replace(/\D/g, '') },
        party: { name: statement.name, rnc: party?.rnc },
        title: selected.type === 'customer' ? 'Estado de cuenta — cliente' : 'Estado de cuenta — proveedor',
        rows: statement.rows, balance: statement.balance, asOf: Date.now(),
      });
      await downloadBlob(blob, `Estado ${statement.name}.pdf`);
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

  return (
    <>
      <PageHeader title="Cuentas por cobrar y pagar" subtitle="Saldos, antigüedad y estados de cuenta — valores en RD$"
        actions={<button type="button" onClick={() => { setShowForm((v) => !v); setSelected(null); }}
          className="btn-primary text-sm inline-flex items-center gap-1.5"><Plus size={15} /> Registrar {tab === 'cxc' ? 'cobro' : 'pago'}</button>} />

      <div className="flex flex-wrap gap-2 mb-4">
        <button type="button" onClick={() => { setTab('cxc'); setSelected(null); }} className={`text-sm px-3 py-1.5 rounded-lg ${tab === 'cxc' ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600'}`}>Por cobrar</button>
        <button type="button" onClick={() => { setTab('cxp'); setSelected(null); }} className={`text-sm px-3 py-1.5 rounded-lg ${tab === 'cxp' ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600'}`}>Por pagar</button>
        {loaded && (
          <span className="ml-auto self-center text-sm text-ink-500">
            Balance total <b className="tabular-nums text-ink-800">{formatDop(view.totals.balance)}</b>
          </span>
        )}
      </div>

      {showForm && loaded && (
        <PaymentForm
          direction={tab === 'cxc' ? 'in' : 'out'} scope={scope} config={config}
          parties={tab === 'cxc' ? customersQ.data : suppliersQ.data}
          onClose={() => setShowForm(false)} />
      )}

      {!loaded ? <ListLoading /> : view.count === 0 ? (
        <EmptyState icon={ArrowLeftRight} title={tab === 'cxc' ? 'Nada por cobrar' : 'Nada por pagar'}
          description={tab === 'cxc' ? 'Las facturas con saldo pendiente aparecen aquí.' : 'Las compras y gastos a crédito con saldo aparecen aquí.'} />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left py-2 px-3">{partyLabel}</th>
                <th className="text-right py-2 px-3">0–30</th>
                <th className="text-right py-2 px-3">31–60</th>
                <th className="text-right py-2 px-3">61–90</th>
                <th className="text-right py-2 px-3">+90</th>
                <th className="text-right py-2 px-3">Balance</th>
                <th className="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.partyId} className="border-t border-ink-50">
                  <td className="py-1.5 px-3 font-medium">{r.party?.name || '—'}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums">{formatDop(r.buckets.d0_30)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums">{formatDop(r.buckets.d31_60)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums">{formatDop(r.buckets.d61_90)}</td>
                  <td className={`py-1.5 px-3 text-right tabular-nums ${r.buckets.d90 > 0 ? 'text-rose-600' : ''}`}>{formatDop(r.buckets.d90)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-semibold">{formatDop(r.balance)}</td>
                  <td className="py-1.5 px-3 text-right">
                    <button type="button" onClick={() => setSelected({ type: tab === 'cxc' ? 'customer' : 'supplier', id: r.partyId })}
                      className="text-xs text-ink-600 hover:text-ink-900 inline-flex items-center gap-1"><FileText size={13} /> Estado</button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-ink-200 font-semibold">
                <td className="py-2 px-3">{view.count} {partyLabel.toLowerCase()}s</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatDop(view.totals.d0_30)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatDop(view.totals.d31_60)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatDop(view.totals.d61_90)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatDop(view.totals.d90)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatDop(view.totals.balance)}</td>
                <td className="py-2 px-3"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {statement && (
        <div className="card p-4 mt-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">Estado de cuenta — {statement.name}</h3>
            <div className="flex items-center gap-3">
              <button type="button" onClick={printStatement} disabled={printingSt}
                className="text-sm text-ink-600 hover:text-ink-900 inline-flex items-center gap-1 disabled:opacity-40">
                {printingSt ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />} Imprimir
              </button>
              <button type="button" onClick={() => setSelected(null)} className="text-ink-400 hover:text-ink-700"><X size={18} /></button>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="text-ink-500 text-xs uppercase tracking-wide">
              <tr><th className="text-left py-1">Fecha</th><th className="text-left py-1">Concepto</th><th className="text-left py-1">Ref.</th><th className="text-right py-1">Cargo</th><th className="text-right py-1">Abono</th><th className="text-right py-1">Saldo</th></tr>
            </thead>
            <tbody>
              {statement.rows.map((r, i) => (
                <tr key={i} className="border-t border-ink-50">
                  <td className="py-1 text-ink-500">{formatDate(r.date)}</td>
                  <td className="py-1">{r.label}</td>
                  <td className="py-1 tabular-nums text-ink-500">{r.ref || '—'}</td>
                  <td className="py-1 text-right tabular-nums">{r.charge ? formatDop(r.charge) : ''}</td>
                  <td className="py-1 text-right tabular-nums">{r.payment ? formatDop(r.payment) : ''}</td>
                  <td className="py-1 text-right tabular-nums font-medium">{formatDop(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function PaymentForm({ direction, scope, config, parties, onClose }) {
  const [form, setForm] = useState({
    partyId: '', date: new Date().toISOString().slice(0, 10), amount: '', method: 'bank', reference: '',
    commission: '', commissionItbis: '', itbisRetained: '', isrRetained: '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const isCard = form.method === 'card' && direction === 'in';

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
      await assignSequenceNumber({
        table: 'payments', profileId: scope, start: 1,
        build: (n) => ({
          id, profileId: scope, number: n, direction, partyType: direction === 'in' ? 'customer' : 'supplier',
          partyId: form.partyId, paidAt: postedAt, amount, method: form.method, reference: form.reference,
          commission: Number(form.commission) || 0, commissionItbis: Number(form.commissionItbis) || 0,
          itbisRetained: Number(form.itbisRetained) || 0, isrRetained: Number(form.isrRetained) || 0,
          journalEntryId: built.entry.id,
        }),
      });
      onClose();
    } catch (e) {
      setErr(e?.message || String(e));
      setSaving(false);
    }
  }

  const field = 'rounded-lg border border-ink-200 px-3 py-1.5 text-sm';
  const numField = 'w-28 rounded-lg border border-ink-200 px-2 py-1.5 text-sm text-right tabular-nums';

  return (
    <div className="card p-4 mb-4 border-ink-300">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Registrar {direction === 'in' ? 'cobro' : 'pago'}</h3>
        <button type="button" onClick={onClose} className="text-ink-400 hover:text-ink-700"><X size={18} /></button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">{direction === 'in' ? 'Cliente' : 'Proveedor'}<br />
          <select value={form.partyId} onChange={(e) => setForm((f) => ({ ...f, partyId: e.target.value }))} className={`${field} min-w-[200px]`}>
            <option value="">—</option>
            {parties.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-sm">Fecha<br /><input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className={field} /></label>
        <label className="text-sm">Monto<br /><input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} className={numField} /></label>
        <label className="text-sm">Método<br />
          <select value={form.method} onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))} className={field}>
            <option value="bank">Banco</option><option value="cash">Efectivo</option><option value="transfer">Transferencia</option>
            {direction === 'in' && <option value="card">Tarjeta</option>}
          </select>
        </label>
        <label className="text-sm">Referencia<br /><input value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} className={field} /></label>
      </div>

      {isCard && (
        <div className="flex flex-wrap items-end gap-3 mt-3 pt-3 border-t border-ink-100">
          <span className="text-xs text-ink-500 w-full">Deducciones de la pasarela (lo que retiene el procesador):</span>
          <label className="text-sm">Comisión<br /><input type="number" step="0.01" min="0" value={form.commission} onChange={(e) => setForm((f) => ({ ...f, commission: e.target.value }))} className={numField} /></label>
          <label className="text-sm">ITBIS comisión<br /><input type="number" step="0.01" min="0" value={form.commissionItbis} onChange={(e) => setForm((f) => ({ ...f, commissionItbis: e.target.value }))} className={numField} /></label>
          <label className="text-sm">ITBIS retenido<br /><input type="number" step="0.01" min="0" value={form.itbisRetained} onChange={(e) => setForm((f) => ({ ...f, itbisRetained: e.target.value }))} className={numField} /></label>
          <label className="text-sm">ISR retenido<br /><input type="number" step="0.01" min="0" value={form.isrRetained} onChange={(e) => setForm((f) => ({ ...f, isrRetained: e.target.value }))} className={numField} /></label>
        </div>
      )}

      <div className="flex items-center justify-between mt-3 pt-3 border-t border-ink-100">
        {isCard ? <div className="text-sm text-ink-600">Neto al banco <b className="tabular-nums">{formatDop(net)}</b></div> : <span />}
        <button type="button" onClick={save} disabled={saving} className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Registrar
        </button>
      </div>
      {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
    </div>
  );
}
