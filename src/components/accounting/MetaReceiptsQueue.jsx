import { useMemo, useState } from 'react';
import { Megaphone, Loader2, RefreshCw, FileText, Check, X, ExternalLink } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber, invalidate } from '../../db/database.js';
import { supabase } from '../../db/supabaseClient.js';
import { useApp } from '../../context/AppContext.jsx';
import { useConfirm, useToast } from '../ConfirmProvider.jsx';
import { formatDop } from '../../lib/format.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import { effectiveDopRate } from '../../lib/exchangeRate.js';
import {
  resolveMetaReceiptsQueue, resolveAccountingConfig, buildExpenseEntry,
} from '../../core/accounting/index.js';

// Alpha backgrounds + a dark: text variant so the pill reads in BOTH themes
// (flat emerald-50 glares on the dark canvas).
const SOURCE_BADGE = {
  email: { label: 'Recibo', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  invoice: { label: 'Factura', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  spend: { label: 'Estimado', cls: 'bg-ink-500/10 text-ink-500' },
};

/** Pick a sensible default marketing/publicidad gasto account for the auto
 *  Meta supplier — a 6-02* code or one whose name mentions ads/marketing. */
function guessMarketingAccount(accounts) {
  const list = (accounts || []).filter((a) => String(a.code || '').startsWith('6'));
  return (
    list.find((a) => /public|market|anunci|mercad/i.test(a.name || ''))
    || list.find((a) => String(a.code).startsWith('6-02'))
    || null
  );
}

/**
 * Meta receipts review queue — the human-in-the-loop step that lands Meta Ads
 * billing in the books. The `meta-receipts` Edge Function (monthly cron + this
 * "Sincronizar" button) parks one PENDING draft per closed cycle; here the
 * dealer posts it as a gasto (exterior "Meta" supplier, ITBIS 0, 606 tipo 02,
 * receipt pre-attached) or dismisses it. Renders nothing when the queue is empty
 * AND nothing is connected to sync — it only appears when there's something to do.
 */
export default function MetaReceiptsQueue() {
  const { profileId, settings } = useApp();
  const scope = profileId || 'team';
  const confirm = useConfirm();
  const toast = useToast();
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);
  const dopRate = useMemo(() => effectiveDopRate(settings), [settings]);

  const receiptsQ = useLiveQueryStatus(() => db.metaReceipts.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);

  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState(null);

  const vm = useMemo(() => resolveMetaReceiptsQueue({
    receipts: receiptsQ.data, suppliers: suppliersQ.data, accounts: accountsQ.data, dopRate,
  }), [receiptsQ.data, suppliersQ.data, accountsQ.data, dopRate]);

  // Empty queue → a slim, always-visible bar so the dealer can pull receipts on
  // demand (the cron also fills it monthly). The full panel renders below once
  // there's something to review.
  if (!vm.count) {
    return (
      <div className="mb-4 flex items-center justify-between gap-2 rounded-xl border border-ink-100 bg-surface px-3.5 py-2">
        <div className="text-sm text-ink-500 flex items-center gap-2 min-w-0">
          <Megaphone size={15} className="text-ink-400 shrink-0" />
          <span className="truncate">Recibos de Meta Ads — nada pendiente</span>
        </div>
        <button type="button" onClick={sync} disabled={syncing} className="btn-ghost text-sm whitespace-nowrap disabled:opacity-40">
          {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Sincronizar
        </button>
      </div>
    );
  }

  async function sync() {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke('meta-receipts', { body: { sync: true } });
      if (error) throw error;
      if (data && data.ok === false) throw new Error(data.error || 'No se pudo sincronizar');
      // The function writes the rows server-side (service role), which doesn't
      // trip the app's invalidation bus — refresh the live queries so the new
      // drafts appear without a page reload.
      invalidate();
      if (data?.configured === false) toast(data.error || 'Meta sin conectar', { tone: 'error' });
      else toast(`Sincronizado · ${data?.synced ?? 0} ciclo(s)`, { tone: 'success' });
    } catch (e) {
      toast(userMessageFor(e), { tone: 'error' });
    } finally {
      setSyncing(false);
    }
  }

  async function createMetaSupplier() {
    setBusy('supplier');
    try {
      const acct = guessMarketingAccount(accountsQ.data);
      const id = newId();
      await assignSequenceNumber({
        table: 'suppliers', profileId: scope, start: 1,
        build: (number) => ({
          id, profileId: scope, number, name: 'Meta Platforms', rnc: '', kind: 'exterior',
          retainIsr: false, retainItbis: false, defaultAccountCode: acct?.code || null,
        }),
      });
      toast(acct ? 'Proveedor Meta creado' : 'Proveedor Meta creado — asígnale una cuenta de publicidad', { tone: 'success' });
    } catch (e) {
      toast(userMessageFor(e), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  /** Post a draft as a real gasto + asiento (mirrors Recurrentes' generate). */
  async function post(row) {
    if (!row.draft) return;
    setBusy(row.id);
    try {
      const id = newId();
      const { attachmentName, attachmentType, attachmentUrl, ...expense } = row.draft;
      const built = buildExpenseEntry({ newId, config, expense: { ...expense, id } });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      await assignSequenceNumber({
        table: 'expenses', profileId: scope, start: 1,
        build: (n) => ({
          ...expense, id, profileId: scope, number: n, journalEntryId: built.entry.id,
          attachmentUrl, attachmentName, attachmentType,
        }),
      });
      await db.metaReceipts.update(row.id, { status: 'posted', expenseId: id, updatedAt: Date.now() });
      toast(`Gasto registrado · ${row.periodLabel}`, { tone: 'success' });
    } catch (e) {
      toast(userMessageFor(e), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(row) {
    const ok = await confirm({
      title: 'Descartar recibo', tone: 'danger', confirmLabel: 'Descartar',
      message: `El recibo de Meta de ${row.periodLabel} no se registrará en los libros.`,
    });
    if (!ok) return;
    await db.metaReceipts.update(row.id, { status: 'dismissed', updatedAt: Date.now() });
  }

  return (
    <div className="card overflow-hidden mb-4">
      <div className="px-3.5 py-2.5 flex items-center gap-2.5 border-b border-ink-100">
        <Megaphone size={16} className="text-ink-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-display font-semibold text-ink-900 leading-tight">Recibos de Meta Ads</div>
          <div className="text-xs text-ink-500 tabular-nums">{vm.count} por registrar · {formatDop(vm.totalDop)}</div>
        </div>
        <button type="button" onClick={sync} disabled={syncing} className="btn-ghost text-sm whitespace-nowrap disabled:opacity-40">
          {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Sincronizar
        </button>
      </div>

      {vm.rows.some((r) => r.needsSupplier) && (
        <div className="px-3.5 py-2.5 bg-surface-2 border-b border-ink-100 text-sm text-ink-600 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span>Falta el proveedor <b className="text-ink-800">Meta</b> (exterior) para poder registrar.</span>
          <button type="button" onClick={createMetaSupplier} disabled={busy === 'supplier'} className="btn-primary text-sm ml-auto disabled:opacity-40">
            {busy === 'supplier' ? <Loader2 size={14} className="animate-spin" /> : null} Crear proveedor
          </button>
        </div>
      )}

      <ul className="divide-y divide-ink-100">
        {vm.rows.map((r) => {
          const badge = SOURCE_BADGE[r.source] || SOURCE_BADGE.spend;
          return (
            <li key={r.id} className="px-3.5 py-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink-900 capitalize truncate">{r.periodLabel}</span>
                  <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}>{badge.label}</span>
                </div>
                <div className="text-xs text-ink-400 mt-0.5 flex items-center gap-2.5 flex-wrap">
                  <span className="truncate">Cuenta {r.adAccountId}</span>
                  {r.invoiceUrl && (
                    <a href={r.invoiceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ink-500 hover:text-ink-800 transition-colors">
                      <FileText size={12} /> recibo <ExternalLink size={10} />
                    </a>
                  )}
                </div>
              </div>
              <div className="text-right whitespace-nowrap shrink-0">
                <div className="tabular-nums font-semibold text-ink-900">{r.amountDop != null ? formatDop(r.amountDop) : '—'}</div>
                <div className="text-[11px] text-ink-400 tabular-nums">{r.currency} {r.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button" onClick={() => post(r)}
                  disabled={!r.draft || busy === r.id}
                  title={r.needsAccount ? 'Asigna una cuenta de gasto al proveedor Meta' : (r.error || 'Registrar gasto')}
                  className="btn-primary text-sm disabled:opacity-40 whitespace-nowrap"
                >
                  {busy === r.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Registrar
                </button>
                <button type="button" onClick={() => dismiss(r)} className="btn-icon-danger" aria-label="Descartar">
                  <X size={15} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
