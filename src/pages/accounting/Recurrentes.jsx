import { useMemo, useState } from 'react';
import { Repeat, Plus, X, Loader2, Zap, Play, Pause, Trash2 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import {
  resolveRecurring, materializeExpense, advance, buildExpenseEntry, resolveAccountingConfig,
} from '../../core/accounting/index.js';

const today = () => new Date().toISOString().slice(0, 10);
const FREQS = [{ v: 'monthly', l: 'Mensual' }, { v: 'weekly', l: 'Semanal' }, { v: 'yearly', l: 'Anual' }];

/**
 * Recurrentes — memorized recurring transactions (v1: bills). Define a plantilla
 * once; each period it surfaces as "due" and one click posts the gasto + asiento
 * and advances the schedule. Human-in-the-loop: the generated gasto carries a
 * BLANK NCF — add the supplier's real NCF in Compras y gastos for the 606.
 */
export default function Recurrentes() {
  const { profileId, settings } = useApp();
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const templatesQ = useLiveQueryStatus(() => db.recurringTemplates.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = templatesQ.loaded && suppliersQ.loaded && accountsQ.loaded;

  const agenda = useMemo(() => resolveRecurring({ templates: templatesQ.data, now: Date.now() }), [templatesQ.data]);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(null);

  async function generate(t) {
    setBusy(t.id);
    try {
      const id = newId();
      const expense = materializeExpense(t);
      const built = buildExpenseEntry({ newId, config, expense: { ...expense, id } });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      await assignSequenceNumber({
        table: 'expenses', profileId: scope, start: 1,
        build: (n) => ({ ...expense, id, profileId: scope, number: n, journalEntryId: built.entry.id }),
      });
      const adv = advance(t);
      await db.recurringTemplates.update(t.id, { lastRunAt: adv.lastRunAt, nextRunAt: adv.nextRunAt, updatedAt: Date.now() });
    } catch (e) {
      window.alert(userMessageFor(e));
    } finally {
      setBusy(null);
    }
  }
  async function toggle(t) { await db.recurringTemplates.update(t.id, { status: t.status === 'active' ? 'paused' : 'active', updatedAt: Date.now() }); }
  async function remove(t) { if (window.confirm(`¿Eliminar la recurrente "${t.name}"?`)) await db.recurringTemplates.delete(t.id); }

  const Row = ({ r, due }) => (
    <div className={`card p-3 flex flex-wrap items-center gap-x-4 gap-y-2 ${due ? 'border-amber-300' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">{r.name}</div>
        <div className="text-xs text-ink-500">{r.scheduleLabel} · {due ? 'vence' : 'próx.'} {formatDate(r.nextRunAt)}{r.lastRunAt ? ` · última ${formatDate(r.lastRunAt)}` : ''}</div>
      </div>
      <div className="text-right tabular-nums font-semibold whitespace-nowrap">{formatDop(r.amount)}</div>
      {due
        ? <button type="button" disabled={busy === r.template.id} onClick={() => generate(r.template)} className="btn-primary disabled:opacity-40 whitespace-nowrap">{busy === r.template.id ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />} Generar</button>
        : <button type="button" onClick={() => toggle(r.template)} className="btn-ghost" title={r.status === 'active' ? 'Pausar' : 'Reanudar'}>{r.status === 'active' ? <Pause size={14} /> : <Play size={14} />}</button>}
      <button type="button" onClick={() => remove(r.template)} className="btn-icon text-ink-400" aria-label="Eliminar"><Trash2 size={15} /></button>
    </div>
  );

  return (
    <AccountingGate title="Recurrentes">
      <PageHeader title="Transacciones recurrentes" subtitle="Plantillas de gastos que se repiten — genéralas con un clic"
        actions={<button type="button" onClick={() => setShowForm((v) => !v)} className="btn-primary"><Plus size={15} /> Nueva recurrente</button>} />

      {!loaded ? <ListLoading /> : (
        <>
          {showForm && <RecurrenteForm scope={scope} accounts={accountsQ.data} suppliers={suppliersQ.data} onClose={() => setShowForm(false)} />}

          {agenda.count === 0 && !showForm ? (
            <EmptyState icon={Repeat} title="Sin recurrentes" description="Crea una plantilla para alquiler, internet, servicios… y genérala cada período sin volver a teclearla." />
          ) : (
            <div className="space-y-5">
              {agenda.due.length > 0 && (
                <section>
                  <h3 className="eyebrow font-semibold text-amber-600 mb-2">Para generar hoy · {formatDop(agenda.dueTotal)}</h3>
                  <div className="space-y-2">{agenda.due.map((r) => <Row key={r.template.id} r={r} due />)}</div>
                  <p className="text-xs text-ink-400 mt-2">Al generar se crea el gasto y su asiento con NCF en blanco — agrega el NCF del proveedor en Compras y gastos para el 606.</p>
                </section>
              )}
              {agenda.upcoming.length > 0 && (
                <section>
                  <h3 className="eyebrow font-semibold text-ink-600 mb-2">Próximas</h3>
                  <div className="space-y-2">{agenda.upcoming.map((r) => <Row key={r.template.id} r={r} />)}</div>
                </section>
              )}
              {agenda.paused.length > 0 && (
                <section>
                  <h3 className="eyebrow font-semibold text-ink-400 mb-2">Pausadas</h3>
                  <div className="space-y-2">{agenda.paused.map((r) => <Row key={r.template.id} r={r} />)}</div>
                </section>
              )}
            </div>
          )}
        </>
      )}
    </AccountingGate>
  );
}

const fieldCls = 'input w-full';
const numCls = 'input w-full text-right tabular-nums';

function RecurrenteForm({ scope, accounts, suppliers, onClose }) {
  const [f, setF] = useState({
    name: '', freq: 'monthly', interval: 1, startAt: today(), supplierId: '', accountCode: '',
    description: '', base: '', itbis: '', itbisCreditable: true, paymentMethod: 'credit',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const gastoAccounts = useMemo(() => (accounts || []).filter((a) => a.isPostable && [5, 6].includes(a.class)).sort((a, b) => a.code.localeCompare(b.code)), [accounts]);

  async function save() {
    setErr('');
    if (!f.name.trim()) { setErr('Ponle un nombre a la recurrente.'); return; }
    if (!f.accountCode) { setErr('Elige la cuenta de gasto.'); return; }
    const base = Math.round((Number(f.base) || 0) * 100) / 100;
    if (base <= 0) { setErr('El monto base debe ser mayor que cero.'); return; }
    const startAt = new Date(f.startAt).getTime();
    setSaving(true);
    try {
      await db.recurringTemplates.put({
        id: newId(), profileId: scope, name: f.name.trim(), kind: 'expense',
        freq: f.freq, interval: Math.max(1, Number(f.interval) || 1),
        startAt, nextRunAt: startAt, status: 'active',
        payload: {
          supplierId: f.supplierId || null, accountCode: f.accountCode, description: f.description.trim(),
          base, itbis: Math.round((Number(f.itbis) || 0) * 100) / 100, itbisCreditable: f.itbisCreditable, paymentMethod: f.paymentMethod,
        },
        createdAt: Date.now(),
      });
      onClose();
    } catch (e) { setErr(userMessageFor(e)); setSaving(false); }
  }

  return (
    <div className="card p-4 mb-4 border-ink-300 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display font-semibold">Nueva recurrente</h3>
        <button type="button" onClick={onClose} className="btn-icon text-ink-400 shrink-0" aria-label="Cerrar"><X size={18} /></button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-sm">Nombre<br /><input value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} placeholder="Alquiler local" className={fieldCls} /></label>
        <label className="text-sm">Cuenta de gasto<br />
          <select value={f.accountCode} onChange={(e) => setF((s) => ({ ...s, accountCode: e.target.value }))} className={fieldCls}>
            <option value="">—</option>
            {gastoAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
        </label>
        <label className="text-sm">Frecuencia<br />
          <select value={f.freq} onChange={(e) => setF((s) => ({ ...s, freq: e.target.value }))} className={fieldCls}>
            {FREQS.map((x) => <option key={x.v} value={x.v}>{x.l}</option>)}
          </select>
        </label>
        <label className="text-sm">Cada<br /><input type="number" min="1" step="1" value={f.interval} onChange={(e) => setF((s) => ({ ...s, interval: e.target.value }))} className={numCls} /></label>
        <label className="text-sm">Primera fecha<br /><input type="date" value={f.startAt} onChange={(e) => setF((s) => ({ ...s, startAt: e.target.value }))} className={fieldCls} /></label>
        <label className="text-sm">Proveedor (opcional)<br />
          <select value={f.supplierId} onChange={(e) => setF((s) => ({ ...s, supplierId: e.target.value }))} className={fieldCls}>
            <option value="">—</option>
            {(suppliers || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="text-sm sm:col-span-2">Concepto<br /><input value={f.description} onChange={(e) => setF((s) => ({ ...s, description: e.target.value }))} className={fieldCls} /></label>
        <label className="text-sm">Base<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={f.base} onChange={(e) => setF((s) => ({ ...s, base: e.target.value }))} onBlur={() => { if (!f.itbis && f.base) setF((s) => ({ ...s, itbis: String(Math.round((Number(s.base) || 0) * 18) / 100 * 10) / 10 })); }} className={numCls} /></label>
        <label className="text-sm">ITBIS<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={f.itbis} onChange={(e) => setF((s) => ({ ...s, itbis: e.target.value }))} className={numCls} /></label>
        <label className="text-sm">Forma de pago<br />
          <select value={f.paymentMethod} onChange={(e) => setF((s) => ({ ...s, paymentMethod: e.target.value }))} className={fieldCls}>
            <option value="credit">Crédito (CxP)</option><option value="bank">Banco</option><option value="cash">Efectivo</option>
          </select>
        </label>
        <label className="text-xs text-ink-600 inline-flex items-center gap-1.5 self-end pb-2">
          <input type="checkbox" checked={f.itbisCreditable} onChange={(e) => setF((s) => ({ ...s, itbisCreditable: e.target.checked }))} /> ITBIS adelantado (crédito fiscal)
        </label>
      </div>
      {err && <p className="text-sm text-rose-600 mt-3">{err}</p>}
      <div className="flex justify-end gap-2 mt-4">
        <button type="button" onClick={onClose} className="btn-ghost">Cancelar</button>
        <button type="button" onClick={save} disabled={saving} className="btn-primary">{saving ? <Loader2 size={14} className="animate-spin" /> : null} Guardar</button>
      </div>
    </div>
  );
}
