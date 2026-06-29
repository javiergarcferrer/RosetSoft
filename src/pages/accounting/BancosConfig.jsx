import { useMemo, useState } from 'react';
import { Landmark, Plus, Pencil, Archive, ArchiveRestore, Loader2 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import Modal from '../../components/Modal.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import { formatDop } from '../../lib/format.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import { resolveBankAccounts, BANK_OPTIONS } from '../../core/accounting/bankAccounts.js';

const EMPTY_FORM = {
  name: '', bank: '', currency: 'DOP', accountCode: '', accountNumber: '', openingBalance: '',
};

/**
 * Cuentas bancarias — the dealer registers their own bank/cash accounts so the
 * cobro form and the conciliación picker can offer them by name. Each account
 * optionally binds to a postable chart leaf under Cajas y Bancos (1-01-001);
 * left empty, asientos fall back to the default Bancos account. Soft-archive
 * (never hard-delete) keeps historical references intact. Self-gates on
 * accounting/admin via AccountingGate.
 */
export default function BancosConfig() {
  const { profileId } = useApp();
  const scope = profileId || 'team';

  const bankQ = useLiveQueryStatus(() => db.bankAccounts.where('profileId').equals(scope).toArray(), [scope], []);
  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = bankQ.loaded && accountsQ.loaded;

  const { rows } = useMemo(
    () => resolveBankAccounts({ bankAccounts: bankQ.data, accounts: accountsQ.data }),
    [bankQ.data, accountsQ.data],
  );

  // Postable leaves under Cajas y Bancos (1-01-001) — the bindable chart codes.
  const chartLeaves = useMemo(
    () => accountsQ.data
      .filter((a) => a.isPostable && a.code.startsWith('1-01-001'))
      .sort((a, b) => a.code.localeCompare(b.code)),
    [accountsQ.data],
  );

  const [editing, setEditing] = useState(null); // the row being edited, or null
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  function openNew() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setErr('');
    setOpen(true);
  }

  function openEdit(row) {
    setEditing(row);
    setForm({
      name: row.name || '',
      bank: row.bank || '',
      currency: row.currency || 'DOP',
      accountCode: row.accountCode || '',
      accountNumber: row.accountNumber || '',
      openingBalance: row.openingBalance ?? '',
    });
    setErr('');
    setOpen(true);
  }

  function set(key, v) { setForm((f) => ({ ...f, [key]: v })); }

  async function save() {
    if (!form.name.trim() || !form.currency) return;
    setErr('');
    setSaving(true);
    try {
      const now = Date.now();
      await db.bankAccounts.put({
        id: editing?.id || newId(),
        profileId: scope,
        name: form.name.trim(),
        bank: form.bank || null,
        currency: form.currency,
        accountCode: form.accountCode || null,
        accountNumber: form.accountNumber.trim() || null,
        openingBalance: form.openingBalance === '' ? null : Number(form.openingBalance),
        archived: editing?.archived ?? false,
        sortOrder: editing?.sortOrder ?? rows.length,
        createdAt: editing?.createdAt ?? now,
        updatedAt: now,
      });
      setOpen(false);
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setSaving(false);
    }
  }

  async function toggleArchive(row) {
    await db.bankAccounts.put({ ...row, archived: !row.archived, updatedAt: Date.now() });
  }

  return (
    <AccountingGate title="Cuentas bancarias">
      <PageHeader
        title="Cuentas bancarias"
        subtitle="Configura tus cuentas para cobrar y conciliar"
        actions={
          <button type="button" onClick={openNew} className="btn-primary">
            <Plus size={15} /> Nueva cuenta
          </button>
        }
      />

      {!loaded ? <ListLoading /> : rows.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title="Sin cuentas bancarias"
          description="Agrega tu primera cuenta para empezar a cobrar y conciliar."
          action={<button type="button" onClick={openNew} className="btn-primary"><Plus size={15} /> Nueva cuenta</button>}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {rows.map((row) => (
            <div key={row.id} className={`card p-4 min-w-0 ${row.archived ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-display font-semibold text-ink-900 truncate">{row.name}</div>
                  <div className="text-xs text-ink-400 mt-0.5">
                    {(BANK_OPTIONS.find((b) => b.key === row.bank)?.label) || 'Banco'} · {row.currency}
                    {row.archived && ' · archivada'}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" onClick={() => openEdit(row)} className="btn-icon text-ink-400" aria-label="Editar"><Pencil size={15} /></button>
                  <button type="button" onClick={() => toggleArchive(row)} className="btn-icon text-ink-400"
                    aria-label={row.archived ? 'Activar' : 'Archivar'} title={row.archived ? 'Activar' : 'Archivar'}>
                    {row.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                  </button>
                </div>
              </div>

              {row.accountNumber && (
                <div className="text-xs text-ink-500 mt-3 tabular-nums truncate">No. {row.accountNumber}</div>
              )}
              <div className="text-xs text-ink-400 mt-1 truncate">
                {row.accountCode
                  ? row.chartExists
                    ? `${row.accountCode} · ${row.chartName}`
                    : <span className="text-rose-600">{row.accountCode} · cuenta no encontrada</span>
                  : 'Bancos (por defecto)'}
              </div>
              {row.openingBalance != null && (
                <div className="text-sm text-ink-700 mt-2 tabular-nums whitespace-nowrap overflow-x-auto">
                  Saldo inicial {formatDop(row.openingBalance)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? 'Editar cuenta' : 'Nueva cuenta'} size="sm"
        footer={
          <>
            <button type="button" onClick={() => setOpen(false)} className="btn-ghost">Cancelar</button>
            <button type="button" onClick={save} disabled={saving || !form.name.trim() || !form.currency} className="btn-primary">
              {saving ? <Loader2 size={15} className="animate-spin" /> : null} Guardar
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block text-sm">Nombre
            <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="p. ej. Popular cheques USD"
              className="input w-full mt-1" autoFocus />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">Banco
              <select value={form.bank} onChange={(e) => set('bank', e.target.value)} className="input w-full mt-1">
                <option value="">— Banco —</option>
                {BANK_OPTIONS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
              </select>
            </label>
            <label className="block text-sm">Moneda
              <select value={form.currency} onChange={(e) => set('currency', e.target.value)} className="input w-full mt-1">
                <option value="DOP">DOP</option>
                <option value="USD">USD</option>
              </select>
            </label>
          </div>

          <label className="block text-sm">Cuenta contable
            <select value={form.accountCode} onChange={(e) => set('accountCode', e.target.value)} className="input w-full mt-1">
              <option value="">— usar Bancos por defecto —</option>
              {chartLeaves.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
            </select>
          </label>

          <label className="block text-sm">No. de cuenta
            <input value={form.accountNumber} onChange={(e) => set('accountNumber', e.target.value)}
              inputMode="numeric" placeholder="Opcional" className="input w-full mt-1 tabular-nums" />
          </label>

          <label className="block text-sm">Saldo inicial
            <input type="number" step="0.01" inputMode="decimal" value={form.openingBalance}
              onChange={(e) => set('openingBalance', e.target.value)} placeholder="Opcional"
              className="input w-full mt-1 text-right tabular-nums" />
          </label>

          {err && <p className="text-sm text-rose-600">{err}</p>}
        </div>
      </Modal>
    </AccountingGate>
  );
}
