import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Receipt, Plus, Loader2, Check, X, Download, Search } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import TabPills from '../../components/accounting/TabPills.jsx';
import PeriodPicker, { periodWindow } from '../../components/accounting/PeriodPicker.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { isoDate, parseISODate } from '../../lib/commissionCycle.js';
import { downloadCsv, downloadText } from '../../lib/csv.js';
import {
  resolveExpensesList, resolve606, buildExpenseEntry, computeExpenseTaxes,
  resolveAccountingConfig, classOf, postableAccounts,
  dgii606Txt, dgiiPeriod, dgiiTxtFilename,
} from '../../core/accounting/index.js';

const PAY_LABEL = { cash: 'Efectivo', bank: 'Banco', card: 'Tarjeta', credit: 'Crédito' };

function ymd(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Gastos — capture an operating expense (it posts a balanced asiento to the
 * ledger) and the DGII 606 projection. Self-gates on accounting/admin.
 */
export default function Expenses() {
  const { profileId, settings } = useApp();
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const expensesQ = useLiveQueryStatus(() => db.expenses.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const purchasesQ = useLiveQueryStatus(() => db.purchases.where('profileId').equals(scope).toArray(), [scope], []);
  const expedientesQ = useLiveQueryStatus(() => db.importExpedientes.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = expensesQ.loaded && suppliersQ.loaded && accountsQ.loaded;

  const expenseAccounts = useMemo(
    () => postableAccounts(accountsQ.data).filter((a) => classOf(a.code) === 6).sort((a, b) => a.code.localeCompare(b.code)),
    [accountsQ.data],
  );
  const suppliersById = useMemo(() => new Map(suppliersQ.data.map((s) => [s.id, s])), [suppliersQ.data]);

  const today = useMemo(() => new Date(), []);
  const [params] = useSearchParams();
  const [tab, setTab] = useState(params.get('tab') === '606' ? '606' : 'list'); // 'list' | '606'
  const [from, setFrom] = useState(() => isoDate(new Date(today.getFullYear(), today.getMonth(), 1).getTime()));
  const [to, setTo] = useState(() => isoDate(today.getTime()));
  const [showForm, setShowForm] = useState(!!params.get('new'));
  const [txtErr, setTxtErr] = useState('');
  const [listQuery, setListQuery] = useState('');

  const win = periodWindow(from, to);
  const list = useMemo(() => resolveExpensesList({ expenses: expensesQ.data, suppliers: suppliersQ.data, accounts: accountsQ.data, query: listQuery, ...win }),
    [expensesQ.data, suppliersQ.data, accountsQ.data, listQuery, from, to]);
  const form606 = useMemo(() => resolve606({ expenses: expensesQ.data, purchases: purchasesQ.data, expedientes: expedientesQ.data, suppliers: suppliersQ.data, ...win }),
    [expensesQ.data, purchasesQ.data, expedientesQ.data, suppliersQ.data, from, to]);

  function export606() {
    const rows = [
      ['RNC/Cédula', 'Nombre', 'NCF', 'Fecha', 'Monto', 'ITBIS', 'Retención ISR', 'Retención ITBIS', 'Total'],
      ...form606.rows.map((r) => [r.rnc, r.name, r.ncf, ymd(r.date), r.base, r.itbis, r.retIsr, r.retItbis, r.total]),
    ];
    downloadCsv(`606_${from}_${to}.csv`, rows);
  }

  function export606Txt() {
    setTxtErr('');
    if (!(settings?.companyRnc || '').trim()) {
      setTxtErr('Configura el "RNC del emisor" en Configuración contable para generar el TXT.');
      return;
    }
    const period = dgiiPeriod(win.end || Date.now());
    const txt = dgii606Txt({ rows: form606.rows, rncEmisor: settings?.companyRnc, period });
    downloadText(dgiiTxtFilename('606', settings?.companyRnc, period), txt);
  }

  return (
    <AccountingGate title="Gastos">
      <PageHeader title="Gastos" subtitle="Captura un gasto y se asienta solo · 606"
        actions={<button type="button" onClick={() => { setShowForm((v) => !v); setTab('list'); }}
          className="btn-primary"><Plus size={15} /> Nuevo gasto</button>} />

      <TabPills tabs={[{ key: 'list', label: 'Gastos' }, { key: '606', label: '606' }]} active={tab} onChange={setTab} />
      <div className="flex flex-wrap items-start gap-2">
        <PeriodPicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }} />
        {tab === 'list' && (
          <div className="relative sm:ml-auto">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-300" />
            <input value={listQuery} onChange={(e) => setListQuery(e.target.value)}
              placeholder="Buscar proveedor, NCF, cuenta…" className="input py-1.5 pl-8 text-sm w-60" />
          </div>
        )}
      </div>

      {showForm && loaded && (
        <NewExpenseForm
          scope={scope} config={config} suppliers={suppliersQ.data} expenseAccounts={expenseAccounts}
          suppliersById={suppliersById} onClose={() => setShowForm(false)} />
      )}

      {!loaded ? <ListLoading /> : tab === 'list' ? (
        list.count === 0 ? (
          <EmptyState icon={Receipt} title="Sin gastos en el período"
            description="Registra un gasto con “Nuevo gasto”." />
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="table min-w-[680px]">
                <thead>
                  <tr>
                    <th className="whitespace-nowrap">Fecha</th>
                    <th>Proveedor</th>
                    <th>Cuenta</th>
                    <th className="whitespace-nowrap">NCF</th>
                    <th className="text-right whitespace-nowrap">Base</th>
                    <th className="text-right whitespace-nowrap">ITBIS</th>
                    <th className="text-right whitespace-nowrap">Total</th>
                    <th className="whitespace-nowrap">Pago</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map(({ expense: e, supplier, accountName, total }) => (
                    <tr key={e.id}>
                      <td className="text-ink-500 whitespace-nowrap">{formatDate(e.expenseAt)}</td>
                      <td className="min-w-[120px]">{supplier?.name || '—'}</td>
                      <td className="text-ink-600 min-w-[140px]"><code className="text-[11px] text-ink-400 mr-1">{e.accountCode}</code>{accountName}</td>
                      <td className="tabular-nums text-ink-500 whitespace-nowrap">{e.ncf || '—'}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(e.base)}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(e.itbis)}</td>
                      <td className="text-right tabular-nums font-medium whitespace-nowrap">{formatDop(total)}</td>
                      <td className="text-ink-600 whitespace-nowrap">{PAY_LABEL[e.paymentMethod] || e.paymentMethod}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-ink-200 font-semibold">
                    <td colSpan={4}>{list.count} gastos</td>
                    <td className="text-right tabular-nums whitespace-nowrap">{formatDop(list.totals.base)}</td>
                    <td className="text-right tabular-nums whitespace-nowrap">{formatDop(list.totals.itbis)}</td>
                    <td className="text-right tabular-nums whitespace-nowrap">{formatDop(list.totals.total)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )
      ) : (
        <>
          <div className="flex flex-wrap justify-end gap-2 mb-3">
            <button type="button" onClick={export606} disabled={form606.count === 0}
              className="btn-ghost"><Download size={14} /> Exportar 606 (CSV)</button>
            <button type="button" onClick={export606Txt} disabled={form606.count === 0}
              className="btn-ghost"><Download size={14} /> TXT DGII (606)</button>
          </div>
          {txtErr && <p className="text-sm text-rose-600 text-right mb-3">{txtErr}</p>}
          {form606.count === 0 ? (
            <EmptyState icon={Receipt} title="Sin comprobantes en el período"
              description="El 606 se arma con los gastos (y compras) con NCF del período." />
          ) : (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="table min-w-[760px]">
                  <thead>
                    <tr>
                      <th className="whitespace-nowrap">RNC/Cédula</th>
                      <th>Nombre</th>
                      <th className="whitespace-nowrap">NCF</th>
                      <th className="whitespace-nowrap">Fecha</th>
                      <th className="text-right whitespace-nowrap">Base</th>
                      <th className="text-right whitespace-nowrap">ITBIS</th>
                      <th className="text-right whitespace-nowrap">Ret. ISR</th>
                      <th className="text-right whitespace-nowrap">Ret. ITBIS</th>
                      <th className="text-right whitespace-nowrap">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {form606.rows.map((r) => (
                      <tr key={r.id}>
                        <td className="tabular-nums whitespace-nowrap">{r.rnc || '—'}</td>
                        <td className="min-w-[120px]">{r.name}</td>
                        <td className="tabular-nums text-ink-500 whitespace-nowrap">{r.ncf || '—'}</td>
                        <td className="text-ink-500 whitespace-nowrap">{formatDate(r.date)}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(r.base)}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(r.itbis)}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(r.retIsr)}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(r.retItbis)}</td>
                        <td className="text-right tabular-nums font-medium whitespace-nowrap">{formatDop(r.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-ink-200 font-semibold">
                      <td colSpan={4}>{form606.count} comprobantes</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(form606.totals.base)}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(form606.totals.itbis)}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(form606.totals.retIsr)}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(form606.totals.retItbis)}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(form606.totals.total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </AccountingGate>
  );
}

function NewExpenseForm({ scope, config, suppliers, expenseAccounts, suppliersById, onClose }) {
  const [form, setForm] = useState({
    supplierId: '', date: isoDate(Date.now()), ncf: '', ncfType: '', accountCode: '',
    description: '', base: '', itbis: '', retIsr: '', retItbis: '', paymentMethod: 'bank',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  function recompute(base, supplier) {
    const t = computeExpenseTaxes({
      base: Number(base) || 0,
      retainIsr: !!supplier?.retainIsr, retainItbis: !!supplier?.retainItbis, config,
    });
    return { itbis: String(t.itbis), retIsr: String(t.retIsr), retItbis: String(t.retItbis) };
  }

  function onSupplier(id) {
    const s = suppliersById.get(id);
    setForm((f) => ({
      ...f, supplierId: id,
      accountCode: s?.defaultAccountCode || f.accountCode,
      ...recompute(f.base, s),
    }));
  }
  function onBase(v) {
    const s = suppliersById.get(form.supplierId);
    setForm((f) => ({ ...f, base: v, ...recompute(v, s) }));
  }

  async function save() {
    setErr('');
    const base = Number(form.base) || 0;
    const itbis = Number(form.itbis) || 0;
    const retIsr = Number(form.retIsr) || 0;
    const retItbis = Number(form.retItbis) || 0;
    if (!form.accountCode) { setErr('Elige la cuenta de gasto.'); return; }
    if (base <= 0) { setErr('El monto base debe ser mayor que cero.'); return; }
    setSaving(true);
    try {
      const id = newId();
      const postedAt = parseISODate(form.date);
      const built = buildExpenseEntry({
        newId, config, postedAt,
        expense: {
          id, supplierId: form.supplierId || null, accountCode: form.accountCode,
          description: form.description, base, itbis,
          retentionIsr: retIsr, retentionItbis: retItbis,
          paymentMethod: form.paymentMethod, ncf: form.ncf,
        },
      });
      await assignSequenceNumber({
        table: 'journalEntries', profileId: scope, start: 1,
        build: (number) => ({ ...built.entry, number }),
      });
      await db.journalLines.bulkPut(built.lines);
      await assignSequenceNumber({
        table: 'expenses', profileId: scope, start: 1,
        build: (number) => ({
          id, profileId: scope, number,
          supplierId: form.supplierId || null, expenseAt: postedAt,
          ncf: form.ncf, ncfType: form.ncfType, accountCode: form.accountCode,
          description: form.description, base, itbis, itbisCreditable: true,
          retentionIsr: retIsr, retentionItbis: retItbis,
          paymentMethod: form.paymentMethod,
          paidAt: form.paymentMethod === 'credit' ? null : postedAt,
          journalEntryId: built.entry.id,
        }),
      });
      onClose();
    } catch (e) {
      setErr(e?.message || String(e));
      setSaving(false);
    }
  }

  const net = (Number(form.base) || 0) + (Number(form.itbis) || 0) - (Number(form.retIsr) || 0) - (Number(form.retItbis) || 0);
  const field = 'input';
  const numField = 'input sm:w-28 text-right tabular-nums';

  return (
    <div className="card p-4 mb-4 border-ink-300 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Nuevo gasto</h3>
        <button type="button" onClick={onClose} className="btn-icon text-ink-400 shrink-0" aria-label="Cerrar"><X size={18} /></button>
      </div>
      <div className="grid sm:grid-cols-2 gap-3 max-w-3xl">
        <select value={form.supplierId} onChange={(e) => onSupplier(e.target.value)} className={field}>
          <option value="">— Proveedor —</option>
          {suppliers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className={field} />
        <select value={form.accountCode} onChange={(e) => setForm((f) => ({ ...f, accountCode: e.target.value }))} className={field}>
          <option value="">— Cuenta de gasto —</option>
          {expenseAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
        </select>
        <input value={form.ncf} onChange={(e) => setForm((f) => ({ ...f, ncf: e.target.value }))} placeholder="NCF" className={field} />
        <input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="Descripción" className={`${field} sm:col-span-2`} />
      </div>

      <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-end gap-3 mt-3">
        <label className="text-sm">Base<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={form.base} onChange={(e) => onBase(e.target.value)} className={numField} /></label>
        <label className="text-sm">ITBIS<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={form.itbis} onChange={(e) => setForm((f) => ({ ...f, itbis: e.target.value }))} className={numField} /></label>
        <label className="text-sm">Ret. ISR<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={form.retIsr} onChange={(e) => setForm((f) => ({ ...f, retIsr: e.target.value }))} className={numField} /></label>
        <label className="text-sm">Ret. ITBIS<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={form.retItbis} onChange={(e) => setForm((f) => ({ ...f, retItbis: e.target.value }))} className={numField} /></label>
        <label className="text-sm col-span-2">Pago<br />
          <select value={form.paymentMethod} onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value }))} className={field}>
            <option value="bank">Banco</option>
            <option value="cash">Efectivo</option>
            <option value="card">Tarjeta</option>
            <option value="credit">Crédito</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mt-3 pt-3 border-t border-ink-100">
        <div className="text-sm text-ink-600">Neto a pagar <b className="tabular-nums">{formatDop(net)}</b></div>
        <button type="button" onClick={save} disabled={saving} className="btn-primary">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Registrar gasto
        </button>
      </div>
      {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
    </div>
  );
}
