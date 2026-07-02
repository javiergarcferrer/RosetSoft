import { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Wallet, Plus, X, Loader2, Receipt, RefreshCw, Scale, ArrowLeft, AlertTriangle } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import RowCards from '../../components/RowCards.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import {
  resolveCajaChica, resolveFundLedger, buildPettyCashEntry,
  resolveAccountingConfig, accountFor, round2, VOUCHER_TYPE_LABEL,
} from '../../core/accounting/index.js';

const today = () => new Date().toISOString().slice(0, 10);

/** Persist a voucher: its balanced asiento (entry + lines) then the numbered
 *  voucher row linked to it. Shared by every action on the page. */
async function postPettyVoucher({ scope, config, fund, voucher }) {
  const built = buildPettyCashEntry({ newId, config, fund, voucher });
  await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
  await db.journalLines.bulkPut(built.lines);
  await assignSequenceNumber({
    table: 'pettyCashVouchers', profileId: scope, start: 1,
    build: (n) => ({ ...voucher, number: n, journalEntryId: built.entry.id }),
  });
}

/** Postable-account picker filtered to the given chart classes (code · name). */
function AccountSelect({ accounts, classes, value, onChange }) {
  const opts = useMemo(() => (accounts || [])
    .filter((a) => a.isPostable && classes.includes(a.class))
    .sort((a, b) => a.code.localeCompare(b.code)), [accounts, classes]);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="input w-full">
      <option value="">—</option>
      {opts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
    </select>
  );
}

/**
 * Caja chica — petty-cash funds run on the imprest system. Open a fund, register
 * vales (gastos paid from the box — a vale with an NCF feeds the 606), reponer
 * (top the cash back up) and arqueo (count the box, book the over/short). Every
 * movement posts a balanced asiento. Self-gates on accounting/admin.
 */
export default function CajaChica() {
  const { profileId, settings } = useApp();
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const fundsQ = useLiveQueryStatus(() => db.pettyCashFunds.where('profileId').equals(scope).toArray(), [scope], []);
  const vouchersQ = useLiveQueryStatus(() => db.pettyCashVouchers.where('profileId').equals(scope).toArray(), [scope], []);
  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = fundsQ.loaded && vouchersQ.loaded && accountsQ.loaded && suppliersQ.loaded;

  const overview = useMemo(() => resolveCajaChica({ funds: fundsQ.data, vouchers: vouchersQ.data }), [fundsQ.data, vouchersQ.data]);

  const [params] = useSearchParams();
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(null); // 'fund' | 'vale' | 'reponer' | 'arqueo' | null

  const selectedFund = useMemo(() => fundsQ.data.find((f) => f.id === selectedId) || null, [fundsQ.data, selectedId]);
  const ledger = useMemo(() => (selectedFund ? resolveFundLedger({ fund: selectedFund, vouchers: vouchersQ.data }) : null), [selectedFund, vouchersQ.data]);

  // Quick-create (?new=1): jump straight to a vale on the only/first open caja.
  useEffect(() => {
    if (!loaded || params.get('new') !== '1') return;
    const open = overview.rows.find((r) => r.status === 'open');
    if (open) { setSelectedId(open.fund.id); setForm('vale'); } else { setForm('fund'); }
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  function closeForm() { setForm(null); }

  return (
    <AccountingGate title="Caja chica">
      <PageHeader title="Caja chica" subtitle="Fondos fijos, vales y arqueos — valores en RD$"
        actions={<button type="button" onClick={() => { setSelectedId(null); setForm('fund'); }} className="btn-primary"><Plus size={15} /> Nueva caja</button>} />

      {!loaded ? <ListLoading /> : (
        <>
          {form === 'fund' && (
            <FundForm scope={scope} config={config} accounts={accountsQ.data}
              defaultAccount={accountFor(config, 'cash')} onClose={closeForm} />
          )}

          {overview.count === 0 && form !== 'fund' ? (
            <EmptyState icon={Wallet} title="Sin cajas chicas"
              description="Abre una caja con su fondo fijo para registrar gastos menores y arqueos."
              action={<button type="button" onClick={() => setForm('fund')} className="btn-primary"><Plus size={15} /> Abrir caja</button>} />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 mb-5">
              {overview.rows.map((r) => (
                <button type="button" key={r.fund.id} onClick={() => { setSelectedId(r.fund.id); setForm(null); }}
                  className={`card p-4 text-left hover:border-ink-300 transition ${selectedId === r.fund.id ? 'border-brand-400 ring-1 ring-brand-300' : ''}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display font-semibold truncate">{r.fund.name}</span>
                    {r.status === 'closed'
                      ? <span className="text-[11px] px-1.5 py-0.5 rounded bg-ink-100 text-ink-500">Cerrada</span>
                      : r.lowOnCash && <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400 inline-flex items-center gap-1"><AlertTriangle size={11} /> Reponer</span>}
                  </div>
                  <div className="mt-2 text-2xl font-semibold tabular-nums">{formatDop(r.balance)}</div>
                  <div className="mt-1 text-xs text-ink-500">
                    Fondo {formatDop(r.fixedAmount)}{r.toReplenish > 0 ? ` · faltan ${formatDop(r.toReplenish)}` : ' · al tope'}
                  </div>
                  {r.fund.custodian && <div className="mt-1 text-xs text-ink-400 truncate">Responsable: {r.fund.custodian}</div>}
                </button>
              ))}
            </div>
          )}

          {selectedFund && (
            <FundPanel
              fund={selectedFund} ledger={ledger}
              overviewRow={overview.rows.find((r) => r.fund.id === selectedFund.id)}
              form={form} setForm={setForm}
              scope={scope} config={config} accounts={accountsQ.data} suppliers={suppliersQ.data}
              onBack={() => { setSelectedId(null); setForm(null); }} />
          )}
        </>
      )}
    </AccountingGate>
  );
}

function FundPanel({ fund, ledger, overviewRow, form, setForm, scope, config, accounts, suppliers, onBack }) {
  const balance = ledger?.balance ?? 0;
  return (
    <div className="card p-4 mt-1 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <button type="button" onClick={onBack} className="btn-icon text-ink-400 shrink-0" aria-label="Volver"><ArrowLeft size={18} /></button>
          <div className="min-w-0">
            <h3 className="font-display font-semibold break-words">{fund.name}</h3>
            <p className="text-xs text-ink-500">Saldo en caja <b className="tabular-nums text-ink-800">{formatDop(balance)}</b> · fondo {formatDop(overviewRow?.fixedAmount || 0)}</p>
          </div>
        </div>
        {fund.status !== 'closed' && (
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={() => setForm('vale')} className="btn-primary"><Receipt size={14} /> Vale</button>
            <button type="button" onClick={() => setForm('reponer')} className="btn-ghost"><RefreshCw size={14} /> Reponer</button>
            <button type="button" onClick={() => setForm('arqueo')} className="btn-ghost"><Scale size={14} /> Arqueo</button>
          </div>
        )}
      </div>

      {form === 'vale' && <ValeForm scope={scope} config={config} fund={fund} accounts={accounts} suppliers={suppliers} onClose={() => setForm(null)} />}
      {form === 'reponer' && <ReponerForm scope={scope} config={config} fund={fund} toReplenish={overviewRow?.toReplenish || 0} onClose={() => setForm(null)} />}
      {form === 'arqueo' && <ArqueoForm scope={scope} config={config} fund={fund} accounts={accounts} bookBalance={balance} onClose={() => setForm(null)} />}

      {ledger && ledger.count === 0 ? (
        <EmptyState icon={Receipt} title="Sin movimientos" description="Registra un vale o una reposición para ver el detalle." />
      ) : ledger && (
        <RowCards
          rows={ledger.rows.map((m) => ({
            key: m.voucher.id,
            title: m.voucher.description || m.label,
            right: <span className={m.delta < 0 ? 'text-rose-600' : 'text-emerald-600'}>{m.delta < 0 ? '−' : '+'}{formatDop(Math.abs(m.delta))}</span>,
            sub: <span className="text-ink-400">{m.label}{m.ncf ? ` · ${m.ncf}` : ''}</span>,
            kv: [
              ['Fecha', formatDate(m.voucher.voucherAt)],
              ['Saldo', formatDop(m.balance)],
            ],
          }))}
        />
      )}
    </div>
  );
}

const fieldCls = 'input w-full';
const numCls = 'input w-full text-right tabular-nums';

function FormShell({ title, children, onClose, onSave, saving, err, saveLabel = 'Guardar' }) {
  return (
    <div className="card p-4 mb-4 border-ink-300 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-display font-semibold">{title}</h4>
        <button type="button" onClick={onClose} className="btn-icon text-ink-400 shrink-0" aria-label="Cerrar"><X size={18} /></button>
      </div>
      {children}
      {err && <p className="text-sm text-rose-600 mt-3">{err}</p>}
      <div className="flex justify-end gap-2 mt-4">
        <button type="button" onClick={onClose} className="btn-ghost">Cancelar</button>
        <button type="button" onClick={onSave} disabled={saving} className="btn-primary">
          {saving ? <Loader2 size={14} className="animate-spin" /> : null} {saveLabel}
        </button>
      </div>
    </div>
  );
}

function FundForm({ scope, config, accounts, defaultAccount, onClose }) {
  const [f, setF] = useState({ name: '', custodian: '', accountCode: defaultAccount || '', fixedAmount: '', fundedFrom: 'bank' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    setErr('');
    if (!f.name.trim()) { setErr('Ponle un nombre a la caja.'); return; }
    if (!f.accountCode) { setErr('Elige la cuenta contable de la caja chica.'); return; }
    const fixedAmount = round2(Number(f.fixedAmount) || 0);
    setSaving(true);
    try {
      const fundId = newId();
      await assignSequenceNumber({
        table: 'pettyCashFunds', profileId: scope, start: 1,
        build: (n) => ({ id: fundId, profileId: scope, number: n, name: f.name.trim(), custodian: f.custodian.trim(), accountCode: f.accountCode, fixedAmount, status: 'open', openedAt: Date.now() }),
      });
      if (fixedAmount > 0) {
        await postPettyVoucher({
          scope, config, fund: { id: fundId, accountCode: f.accountCode },
          voucher: { id: newId(), profileId: scope, fundId, type: 'opening', voucherAt: Date.now(), base: fixedAmount, itbis: 0, total: fixedAmount, paymentMethod: f.fundedFrom, description: `Apertura de ${f.name.trim()}` },
        });
      }
      onClose();
    } catch (e) { setErr(userMessageFor(e)); setSaving(false); }
  }
  return (
    <FormShell title="Nueva caja chica" onClose={onClose} onSave={save} saving={saving} err={err} saveLabel="Abrir caja">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-sm">Nombre<br /><input value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} placeholder="Caja chica administración" className={fieldCls} /></label>
        <label className="text-sm">Responsable<br /><input value={f.custodian} onChange={(e) => setF((s) => ({ ...s, custodian: e.target.value }))} className={fieldCls} /></label>
        <label className="text-sm">Cuenta contable (caja chica)<br /><AccountSelect accounts={accounts} classes={[1]} value={f.accountCode} onChange={(v) => setF((s) => ({ ...s, accountCode: v }))} /></label>
        <label className="text-sm">Fondo fijo<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={f.fixedAmount} onChange={(e) => setF((s) => ({ ...s, fixedAmount: e.target.value }))} className={numCls} /></label>
        <label className="text-sm">Fondo tomado de<br />
          <select value={f.fundedFrom} onChange={(e) => setF((s) => ({ ...s, fundedFrom: e.target.value }))} className={fieldCls}>
            <option value="bank">Banco</option><option value="cash">Caja general</option>
          </select>
        </label>
      </div>
      <p className="text-xs text-ink-400 mt-2">Al abrir con fondo &gt; 0 se registra el asiento de apertura (Caja chica a {f.fundedFrom === 'cash' ? 'Caja general' : 'Banco'}).</p>
    </FormShell>
  );
}

function ValeForm({ scope, config, fund, accounts, suppliers, onClose }) {
  const [f, setF] = useState({ date: today(), accountCode: '', description: '', supplierId: '', beneficiary: '', ncf: '', base: '', itbis: '', itbisCreditable: true });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  function applyItbis() {
    const base = Number(f.base) || 0;
    setF((s) => ({ ...s, itbis: String(round2((base * config.itbisRate) / 100)) }));
  }
  async function save() {
    setErr('');
    const base = round2(Number(f.base) || 0);
    const itbis = round2(Number(f.itbis) || 0);
    if (!f.accountCode) { setErr('Elige la cuenta de gasto.'); return; }
    if (base + itbis <= 0) { setErr('El vale debe tener un monto mayor que cero.'); return; }
    setSaving(true);
    try {
      await postPettyVoucher({
        scope, config, fund,
        voucher: {
          id: newId(), profileId: scope, fundId: fund.id, type: 'expense', voucherAt: new Date(f.date).getTime(),
          accountCode: f.accountCode, description: f.description.trim(), supplierId: f.supplierId || null,
          beneficiary: f.beneficiary.trim(), ncf: f.ncf.trim(), base, itbis,
          itbisCreditable: f.itbisCreditable, total: round2(base + itbis),
        },
      });
      onClose();
    } catch (e) { setErr(userMessageFor(e)); setSaving(false); }
  }
  return (
    <FormShell title="Vale de gasto" onClose={onClose} onSave={save} saving={saving} err={err} saveLabel="Registrar vale">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-sm">Fecha<br /><input type="date" value={f.date} onChange={(e) => setF((s) => ({ ...s, date: e.target.value }))} className={fieldCls} /></label>
        <label className="text-sm">Cuenta de gasto<br /><AccountSelect accounts={accounts} classes={[6, 5]} value={f.accountCode} onChange={(v) => setF((s) => ({ ...s, accountCode: v }))} /></label>
        <label className="text-sm sm:col-span-2">Concepto<br /><input value={f.description} onChange={(e) => setF((s) => ({ ...s, description: e.target.value }))} placeholder="Café, transporte, ferretería…" className={fieldCls} /></label>
        <label className="text-sm">Proveedor (opcional)<br />
          <select value={f.supplierId} onChange={(e) => setF((s) => ({ ...s, supplierId: e.target.value }))} className={fieldCls}>
            <option value="">—</option>
            {(suppliers || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="text-sm">Beneficiario (si no hay proveedor)<br /><input value={f.beneficiary} onChange={(e) => setF((s) => ({ ...s, beneficiary: e.target.value }))} className={fieldCls} /></label>
        <label className="text-sm">NCF (para el 606)<br /><input value={f.ncf} onChange={(e) => setF((s) => ({ ...s, ncf: e.target.value }))} placeholder="B0100000001" className={fieldCls} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">Base<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={f.base} onChange={(e) => setF((s) => ({ ...s, base: e.target.value }))} onBlur={() => { if (f.ncf && !f.itbis) applyItbis(); }} className={numCls} /></label>
          <label className="text-sm">ITBIS<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={f.itbis} onChange={(e) => setF((s) => ({ ...s, itbis: e.target.value }))} className={numCls} /></label>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-2">
        <button type="button" onClick={applyItbis} className="text-xs text-ink-600 hover:text-ink-900">ITBIS {config.itbisRate}%</button>
        <label className="text-xs text-ink-600 inline-flex items-center gap-1.5">
          <input type="checkbox" checked={f.itbisCreditable} onChange={(e) => setF((s) => ({ ...s, itbisCreditable: e.target.checked }))} /> ITBIS adelantado (crédito fiscal)
        </label>
        <span className="text-xs text-ink-400 ml-auto tabular-nums">Sale de la caja: {formatDop(round2((Number(f.base) || 0) + (Number(f.itbis) || 0)))}</span>
      </div>
    </FormShell>
  );
}

function ReponerForm({ scope, config, fund, toReplenish, onClose }) {
  const [f, setF] = useState({ amount: toReplenish ? String(round2(toReplenish)) : '', fundedFrom: 'bank', description: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    setErr('');
    const amount = round2(Number(f.amount) || 0);
    if (amount <= 0) { setErr('El monto debe ser mayor que cero.'); return; }
    setSaving(true);
    try {
      await postPettyVoucher({
        scope, config, fund,
        voucher: { id: newId(), profileId: scope, fundId: fund.id, type: 'replenishment', voucherAt: Date.now(), base: amount, itbis: 0, total: amount, paymentMethod: f.fundedFrom, description: f.description.trim() || 'Reposición de caja' },
      });
      onClose();
    } catch (e) { setErr(userMessageFor(e)); setSaving(false); }
  }
  return (
    <FormShell title="Reponer caja" onClose={onClose} onSave={save} saving={saving} err={err} saveLabel="Reponer">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-sm">Monto<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={f.amount} onChange={(e) => setF((s) => ({ ...s, amount: e.target.value }))} className={numCls} /></label>
        <label className="text-sm">Tomado de<br />
          <select value={f.fundedFrom} onChange={(e) => setF((s) => ({ ...s, fundedFrom: e.target.value }))} className={fieldCls}>
            <option value="bank">Banco</option><option value="cash">Caja general</option>
          </select>
        </label>
        <label className="text-sm sm:col-span-2">Referencia (opcional)<br /><input value={f.description} onChange={(e) => setF((s) => ({ ...s, description: e.target.value }))} className={fieldCls} /></label>
      </div>
    </FormShell>
  );
}

function ArqueoForm({ scope, config, fund, accounts, bookBalance, onClose }) {
  const [f, setF] = useState({ counted: '', accountCode: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const diff = round2((Number(f.counted) || 0) - bookBalance);
  const direction = diff >= 0 ? 'over' : 'short';
  async function save() {
    setErr('');
    if (f.counted === '') { setErr('Ingresa el efectivo contado.'); return; }
    if (diff === 0) { setErr('No hay diferencia que registrar — la caja cuadra.'); return; }
    if (!f.accountCode) { setErr(`Elige la cuenta de ${direction === 'over' ? 'sobrante (ingreso)' : 'faltante (gasto)'}.`); return; }
    setSaving(true);
    try {
      await postPettyVoucher({
        scope, config, fund,
        voucher: { id: newId(), profileId: scope, fundId: fund.id, type: 'adjustment', direction, voucherAt: Date.now(), accountCode: f.accountCode, base: 0, itbis: 0, total: Math.abs(diff), description: `Arqueo — ${direction === 'over' ? 'sobrante' : 'faltante'}` },
      });
      onClose();
    } catch (e) { setErr(userMessageFor(e)); setSaving(false); }
  }
  return (
    <FormShell title="Arqueo de caja" onClose={onClose} onSave={save} saving={saving} err={err} saveLabel="Registrar arqueo">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="text-sm">Saldo en libros<br /><div className="input w-full bg-ink-50 tabular-nums">{formatDop(bookBalance)}</div></div>
        <label className="text-sm">Efectivo contado<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={f.counted} onChange={(e) => setF((s) => ({ ...s, counted: e.target.value }))} className={numCls} /></label>
      </div>
      {f.counted !== '' && diff !== 0 && (
        <div className="mt-3">
          <p className={`text-sm ${direction === 'short' ? 'text-rose-600' : 'text-emerald-600'}`}>
            {direction === 'short' ? 'Faltante' : 'Sobrante'} de <b className="tabular-nums">{formatDop(Math.abs(diff))}</b>
          </p>
          <label className="text-sm block mt-2">Cuenta de {direction === 'over' ? 'sobrante (ingreso)' : 'faltante (gasto)'}<br />
            <AccountSelect accounts={accounts} classes={direction === 'over' ? [4] : [6]} value={f.accountCode} onChange={(v) => setF((s) => ({ ...s, accountCode: v }))} />
          </label>
        </div>
      )}
    </FormShell>
  );
}
