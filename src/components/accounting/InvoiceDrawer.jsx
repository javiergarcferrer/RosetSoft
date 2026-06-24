import { useState, useEffect } from 'react';
import { Loader2, ArrowDownCircle, Ban } from 'lucide-react';
import { formatDop, formatDate } from '../../lib/format.js';

/**
 * InvoiceDrawer — the "click a factura, the briefing comes up in place" panel.
 * A QuickBooks-style detail surface so the invoice→cobro→e-CF task never leaves
 * the Facturación screen: the desglose, the sale's asiento, the cobros history,
 * an inline Registrar cobro, and the fiscal actions (passed in from the page so
 * the drawer and the row stay one source of truth).
 *
 * Pure presentational + local form state: the page owns the data (posting,
 * customer, payments) and the effects (onCollect posts the cobro, fiscalActions
 * is the row's e-CF action cluster).
 */
const METHODS = [['transfer', 'Transferencia'], ['bank', 'Banco'], ['cash', 'Efectivo']];
const TIPO_LABEL = {
  '31': 'Crédito Fiscal · e-CF 31', '32': 'Consumo · e-CF 32',
  '33': 'Nota de débito · e-CF 33', '34': 'Nota de crédito · e-CF 34',
  '44': 'Régimen especial · e-CF 44', '45': 'Gubernamental · e-CF 45',
  '46': 'Exportación · e-CF 46',
};
const ECF_SKIN = {
  accepted: { dot: 'bg-emerald-500', label: 'Aceptado', cls: 'text-emerald-700' },
  sent: { dot: 'bg-emerald-500', label: 'Transmitido', cls: 'text-emerald-700' },
  pending: { dot: 'bg-amber-500', label: 'e-CF pendiente', cls: 'text-amber-700' },
  rejected: { dot: 'bg-rose-500', label: 'Rechazado', cls: 'text-rose-600' },
};

function todayInput() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function Row({ label, value, strong, big, rule, tone }) {
  const toneCls = tone === 'emerald' ? 'text-emerald-700' : tone === 'brand' ? 'text-brand-700' : 'text-ink-900';
  return (
    <div className={`flex items-baseline justify-between gap-3 py-1.5 ${rule ? 'border-b border-ink-100' : ''}`}>
      <span className={`text-sm ${strong ? 'text-ink-900 font-medium' : 'text-ink-500'}`}>{label}</span>
      <span className={`tabular-nums ${big ? 'text-lg font-semibold' : 'text-sm'} ${strong ? 'font-semibold' : ''} ${toneCls}`}>{value}</span>
    </div>
  );
}

export default function InvoiceDrawer({ row, posting, customer, payments, itbisRate, fiscalActions, onCollect, onVoid, onClose }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('transfer');
  const [date, setDate] = useState(todayInput());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [onClose]);

  if (!posting) return null;
  const isNote = !!row.creditNote || /^E34/.test(posting.ncf || '');
  const voided = !!posting.voidedAt;
  const base = Number(posting.base) || 0;
  const itbis = Number(posting.itbis) || 0;
  const total = Number(posting.total) || 0;
  const depositApplied = Number(posting.depositApplied) || 0;
  const allocFor = (p) => (p.allocations || []).filter((a) => a.docId === posting.id).reduce((x, a) => x + (Number(a.amount) || 0), 0);
  const cobrado = (payments || []).reduce((s, p) => s + allocFor(p), 0);
  const balance = Math.max(0, total - depositApplied - cobrado);
  const ecf = voided
    ? { dot: 'bg-ink-300', label: 'Anulada', cls: 'text-ink-400' }
    : (ECF_SKIN[posting.ecfStatus] || { dot: 'bg-ink-300', label: 'Sin transmitir', cls: 'text-ink-400' });
  const tipoLabel = TIPO_LABEL[posting.ecfType] || (posting.ncf || '');
  // A not-yet-transmitted e-CF can be voided in place (sequence gap); an issued
  // one (sent/accepted) is cancelled/corrected only via a nota de crédito.
  const canVoid = !isNote && !voided && posting.ecfStatus !== 'sent' && posting.ecfStatus !== 'accepted';
  const issued = posting.ecfStatus === 'sent' || posting.ecfStatus === 'accepted';

  // The sale's asiento, derived from the posting exactly as lib/accounting/sale
  // books it (deposit clears the liability, the rest bills the receivable, base
  // credits revenue, ITBIS credits the tax). Shown for sales, not notas.
  const asiento = isNote ? [] : [
    depositApplied > 0 && { acc: 'Cobros anticipados', d: depositApplied, c: 0 },
    (total - depositApplied) > 0.005 && { acc: 'Cuentas por cobrar', d: total - depositApplied, c: 0 },
    { acc: 'Ventas locales', d: 0, c: base },
    itbis > 0 && { acc: 'ITBIS por pagar', d: 0, c: itbis },
  ].filter(Boolean);

  const sortedPayments = (payments || []).slice().sort((a, b) => (a.paidAt || 0) - (b.paidAt || 0));
  const methodLabel = (m) => (METHODS.find(([k]) => k === m)?.[1]) || (m === 'card' ? 'Tarjeta' : m || '—');

  async function submitCobro() {
    setErr('');
    const amt = Number(amount) || balance;
    if (amt <= 0) { setErr('El monto debe ser mayor que cero.'); return; }
    if (amt - balance > 0.005) { setErr(`El cobro excede el balance (${formatDop(balance)}).`); return; }
    setSaving(true);
    const r = await onCollect({ amount: amt, method, date });
    setSaving(false);
    if (!r?.ok) { setErr(r?.error || 'No se pudo registrar el cobro.'); return; }
    setAmount('');
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink-900/40" onClick={onClose} aria-hidden />
      <aside className="fixed top-0 right-0 bottom-0 z-50 w-full max-w-[460px] bg-surface border-l border-ink-200 shadow-2xl flex flex-col"
        role="dialog" aria-modal="true" aria-label={`Factura ${posting.ncf || ''}`}>
        <div className="px-5 py-4 border-b border-ink-100">
          <div className="flex items-center justify-between mb-3">
            <span className={`inline-flex items-center gap-2 text-xs font-medium ${ecf.cls}`}>
              <span className={`w-2 h-2 rounded-full ${ecf.dot}`} aria-hidden />
              <span className="tabular-nums text-ink-700">{posting.ncf || '—'}</span>
              <span>{ecf.label}</span>
            </span>
            <button type="button" onClick={onClose} className="btn-ghost text-xs" aria-label="Cerrar">
              Cerrar <span className="kbd ml-1">Esc</span>
            </button>
          </div>
          <h2 className="font-display text-lg font-semibold text-ink-900 truncate">{customer?.name || 'Cliente'}</h2>
          <div className="text-xs text-ink-500 mt-0.5">{tipoLabel}{posting.rnc ? ` · RNC ${posting.rnc}` : ''}</div>
          <div className="flex items-baseline gap-3 mt-3">
            <span className="font-display text-2xl font-semibold tabular-nums text-ink-900">{formatDop(isNote ? -total : total)}</span>
            {!voided && !isNote && balance <= 0 && <span className="chip bg-emerald-100 text-emerald-700">Liquidada</span>}
            {!voided && !isNote && balance > 0 && <span className="chip bg-amber-100 text-amber-800">Balance {formatDop(balance)}</span>}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {voided && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              Factura anulada el {formatDate(posting.voidedAt)}{posting.voidedReason ? ` · ${posting.voidedReason}` : ''}. El asiento fue revertido y el e-NCF quedó anulado.
            </div>
          )}
          <div>
            <div className="eyebrow-xs text-ink-400 mb-1.5">Desglose</div>
            <Row label="Base imponible" value={formatDop(base)} rule />
            <Row label={`ITBIS (${itbisRate ?? 18}%)`} value={formatDop(itbis)} rule />
            <Row label="Total facturado" value={formatDop(total)} strong rule />
            {depositApplied > 0 && <Row label="Depósito aplicado" value={`− ${formatDop(depositApplied)}`} tone="emerald" rule />}
            {cobrado > 0 && <Row label="Cobrado" value={`− ${formatDop(cobrado)}`} tone="emerald" rule />}
            {!isNote && <Row label="Balance pendiente" value={formatDop(balance)} strong big tone={balance > 0 ? 'brand' : 'emerald'} />}
          </div>

          {!isNote && !voided && balance > 0 && (
            <div className="surface-subtle p-3.5">
              <div className="eyebrow-xs text-ink-500 mb-2 inline-flex items-center gap-1.5"><ArrowDownCircle size={13} aria-hidden /> Registrar cobro</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[11px] text-ink-500 col-span-2 sm:col-span-1">Monto
                  <input type="number" min="0" step="0.01" inputMode="decimal" value={amount} placeholder={balance.toFixed(2)}
                    onChange={(e) => setAmount(e.target.value)} className="input mt-1 text-right tabular-nums" />
                </label>
                <label className="text-[11px] text-ink-500">Método
                  <select value={method} onChange={(e) => setMethod(e.target.value)} className="input mt-1">
                    {METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </label>
                <label className="text-[11px] text-ink-500 col-span-2 sm:col-span-1">Fecha
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input mt-1" />
                </label>
              </div>
              <button type="button" onClick={submitCobro} disabled={saving} className="btn-primary w-full justify-center mt-2.5">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <ArrowDownCircle size={15} />} Registrar cobro
              </button>
              {err && <p className="text-xs text-rose-600 mt-2">{err}</p>}
            </div>
          )}

          <div>
            <div className="eyebrow-xs text-ink-400 mb-1.5">Historial de cobros</div>
            {depositApplied <= 0 && sortedPayments.length === 0 ? (
              <p className="text-sm text-ink-400">Sin cobros registrados.</p>
            ) : (
              <ul className="space-y-2">
                {depositApplied > 0 && (
                  <li className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-ink-600">Depósito aplicado</span>
                    <span className="tabular-nums text-emerald-700">+ {formatDop(depositApplied)}</span>
                  </li>
                )}
                {sortedPayments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-ink-600">{methodLabel(p.method)} · {formatDate(p.paidAt)}</span>
                    <span className="tabular-nums text-emerald-700">+ {formatDop(allocFor(p))}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {asiento.length > 0 && (
            <div>
              <div className="eyebrow-xs text-ink-400 mb-1.5">Asiento contable</div>
              <div className="border border-ink-100 rounded-xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-ink-50 text-ink-500">
                      <th className="text-left font-medium px-3 py-1.5">Cuenta</th>
                      <th className="text-right font-medium px-3 py-1.5">Débito</th>
                      <th className="text-right font-medium px-3 py-1.5">Crédito</th>
                    </tr>
                  </thead>
                  <tbody>
                    {asiento.map((a, i) => (
                      <tr key={i} className="border-t border-ink-50">
                        <td className="px-3 py-1.5 text-ink-700">{a.acc}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-ink-900">{a.d ? formatDop(a.d) : '—'}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-ink-900">{a.c ? formatDop(a.c) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-ink-50 border-t border-ink-200 font-semibold">
                      <td className="px-3 py-1.5 text-ink-600">Balanceado</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatDop(total)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatDop(total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {(canVoid || issued) && (
            <div>
              <div className="eyebrow-xs text-ink-400 mb-1.5">Cancelar / corregir</div>
              {issued && (
                <p className="text-xs text-ink-500">Este e-CF ya está en la DGII. Para cancelarlo o corregirlo, emite una <span className="font-medium text-ink-700">nota de crédito</span> (Anulación total o Corrección) desde las acciones de abajo.</p>
              )}
              {canVoid && !voidOpen && (
                <button type="button" onClick={() => setVoidOpen(true)} className="btn-ghost text-xs text-rose-600">
                  <Ban size={13} aria-hidden /> Anular factura
                </button>
              )}
              {canVoid && voidOpen && (
                <div className="surface-subtle p-3">
                  <p className="text-xs text-ink-500 mb-2">Revierte el asiento y marca el e-NCF como anulado (queda un hueco en la secuencia — no se transmite nada a la DGII). Si viene de una cotización, vuelve a “Por facturar”.</p>
                  <textarea value={voidReason} onChange={(e) => setVoidReason(e.target.value)} rows={2} placeholder="Motivo (opcional)…" className="input w-full mb-2" />
                  <div className="flex gap-2">
                    <button type="button" disabled={voiding}
                      onClick={async () => { setErr(''); setVoiding(true); const r = await onVoid?.(voidReason); setVoiding(false); if (r?.ok) onClose(); else setErr(r?.error || 'No se pudo anular.'); }}
                      className="btn-danger text-xs">
                      {voiding ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} aria-hidden />} Confirmar anulación
                    </button>
                    <button type="button" onClick={() => { setVoidOpen(false); setErr(''); }} disabled={voiding} className="btn-ghost text-xs">Cancelar</button>
                  </div>
                  {err && <p className="text-xs text-rose-600 mt-2">{err}</p>}
                </div>
              )}
            </div>
          )}
        </div>

        {fiscalActions && (
          <div className="px-5 py-3 border-t border-ink-100 flex flex-wrap items-center gap-2">
            {fiscalActions}
          </div>
        )}
      </aside>
    </>
  );
}
