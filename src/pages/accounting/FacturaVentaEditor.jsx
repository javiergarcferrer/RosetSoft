import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Loader2, Check, Trash2 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, invalidate } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import BackLink from '../../components/BackLink.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import { formatDop } from '../../lib/format.js';
import { isoDate, parseISODate } from '../../lib/commissionCycle.js';
import { cleanRnc } from '../../lib/rncLookup.js';
import { assignNextENcf } from '../../lib/ecfSequence.js';
import { postSaleTx } from '../../lib/salePosting.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import {
  resolveAccountingConfig, resolveBillLines, buildSalesBillEntry,
  postableAccounts, classOf, saleEcfType, isValidFiscalId, parseENcf,
} from '../../core/accounting/index.js';

const blankLine = () => ({ id: newId(), description: '', accountCode: '', qty: '1', unitPrice: '', taxIds: ['itbis18'] });
const ITBIS_OPTS = [{ id: 'itbis18', label: 'ITBIS 18%' }, { id: 'itbis16', label: 'ITBIS 16%' }, { id: 'exento', label: 'Exento' }];
const itbisOf = (taxIds) => (taxIds || []).find((id) => /^itbis|^exento/.test(id)) || 'itbis18';

function Field({ label, children }) {
  return (
    <label className="block min-w-0">
      <span className="text-xs text-ink-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

/**
 * Factura de venta por líneas — a DIRECT sales invoice (not tied to a quote):
 * each line credits its OWN ingreso account with its own ITBIS, for services or
 * misc income the furniture quote builder doesn't cover. Posts the sale asiento
 * (buildSalesBillEntry) + a sales_posting with quoteId null through the SAME
 * post_sale RPC the quote flow uses, assigns the e-NCF, and lands in Facturación
 * as 'pending' to transmit. The 607/e-CF read the rolled-up gravado/itbis, so the
 * fiscal pipeline is unchanged. Self-gates on accounting/admin.
 */
export default function FacturaVentaEditor() {
  const { profileId, settings } = useApp();
  const scope = profileId || 'team';
  const navigate = useNavigate();
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const customersQ = useLiveQueryStatus(() => db.customers.where('profileId').equals(scope).toArray(), [scope], []);
  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = customersQ.loaded && accountsQ.loaded;
  const customersById = useMemo(() => new Map(customersQ.data.map((c) => [c.id, c])), [customersQ.data]);

  const [form, setForm] = useState({ customerId: '', date: isoDate(Date.now()), paymentMethod: 'credit', ncf: '' });
  const [lines, setLines] = useState([blankLine()]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const incomeAccounts = useMemo(
    () => postableAccounts(accountsQ.data).filter((a) => classOf(a.code) === 4).sort((a, b) => a.code.localeCompare(b.code)),
    [accountsQ.data],
  );
  const billRes = useMemo(() => resolveBillLines(lines), [lines]);
  const totals = billRes.totals;
  const customer = form.customerId ? customersById.get(form.customerId) : null;
  const rnc = cleanRnc(customer?.rnc || '');
  const ecfType = saleEcfType(!!rnc);

  const addLine = () => setLines((ls) => [...ls, blankLine()]);
  const patchLine = (id, patch) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const delLine = (id) => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.id !== id) : ls.map((l) => (l.id === id ? blankLine() : l))));

  async function save() {
    setErr('');
    const bl = billRes.lines;
    if (bl.length === 0) { setErr('Agrega al menos una línea con cuenta y monto.'); return; }
    if (bl.some((l) => !l.accountCode)) { setErr('Cada línea necesita una cuenta de ingreso.'); return; }
    if (bl.some((l) => !(l.base > 0))) { setErr('Cada línea necesita cantidad y precio mayores que cero.'); return; }
    if (rnc && !isValidFiscalId(rnc)) { setErr('El RNC/cédula del cliente es inválido (9 u 11 dígitos).'); return; }

    setSaving(true);
    try {
      const id = newId();
      const postedAt = parseISODate(form.date);
      // Mirror postSale: assign the e-NCF atomically; a typed NCF is the explicit
      // fallback when no sequence is configured for the type.
      const assigned = await assignNextENcf(scope, ecfType);
      const manualNcf = (form.ncf || '').trim();
      if (!assigned && !manualNcf) {
        setErr(`No hay secuencia e-CF activa para el tipo ${ecfType}. Autoriza una en Secuencias e-CF, o escribe el NCF manualmente.`);
        setSaving(false); return;
      }
      const ncf = assigned ? assigned.eNcf : manualNcf;
      const ecfTypeForNcf = (!assigned && parseENcf(ncf)?.type) || ecfType;
      const built = buildSalesBillEntry({
        newId, config, postedAt,
        sale: {
          id, customerId: form.customerId || null,
          lines: bl.map((l) => ({ accountCode: l.accountCode, base: l.base, itbis: l.itbis })),
          paymentMethod: form.paymentMethod, ncf, memo: 'Factura de venta',
        },
      });
      // One transaction (asiento + lines + posting), numbers assigned server-side.
      // quoteId null → a direct invoice; the unique-per-quote index ignores nulls.
      await postSaleTx({
        entry: built.entry, lines: built.lines,
        posting: {
          id, profileId: scope, quoteId: null, customerId: form.customerId || null,
          postedAt, ncf, rnc, ecfType: ecfTypeForNcf,
          ecfStatus: assigned ? 'pending' : '', ecfExpiresAt: assigned?.expiresAt ?? null,
          base: totals.base, itbis: totals.itbis, total: totals.total,
          depositApplied: 0, rate: 1, usdTotal: totals.total,
        },
      });
      // Persist the RNC back onto the customer for reuse.
      if (customer && rnc && rnc !== cleanRnc(customer.rnc)) await db.customers.update(customer.id, { rnc });
      invalidate();
      navigate('/accounting/facturacion');
    } catch (e) {
      setErr(userMessageFor(e));
      setSaving(false);
    }
  }

  const field = 'input w-full';

  return (
    <AccountingGate title="Facturación">
      <BackLink to="/accounting/facturacion">Volver a facturación</BackLink>
      <PageHeader title="Nueva factura de venta" subtitle="Factura por líneas — cada renglón a su cuenta de ingreso; se asienta y queda lista para transmitir el e-CF" />
      {!loaded ? <ListLoading /> : (
        <div className="card overflow-hidden min-w-0">
          {/* Header + live total */}
          <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-4 border-b border-ink-100 bg-ink-50/40">
            <div className="text-xs text-ink-500">
              Comprobante <span className="font-medium text-ink-700">{ecfType === '31' ? 'Crédito fiscal (E31)' : 'Consumo (E32)'}</span>
              <span className="text-ink-400"> · se asigna al registrar</span>
            </div>
            <div className="text-right">
              <div className="eyebrow-xs text-ink-400">Total</div>
              <div className="font-display text-xl font-semibold tabular-nums text-ink-900">{formatDop(totals.total)}</div>
            </div>
          </div>

          {/* Document fields */}
          <div className="px-4 sm:px-6 py-5 grid sm:grid-cols-2 gap-x-10 gap-y-4">
            <div className="space-y-4 min-w-0">
              <Field label="Cliente">
                <select value={form.customerId} onChange={(e) => setForm((f) => ({ ...f, customerId: e.target.value }))} className={field}>
                  <option value="">— Consumidor final —</option>
                  {customersQ.data.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((c) => <option key={c.id} value={c.id}>{c.name}{c.rnc ? ` · ${c.rnc}` : ''}</option>)}
                </select>
              </Field>
              <Field label="NCF (sólo si no hay secuencia e-CF activa)">
                <input value={form.ncf} onChange={(e) => setForm((f) => ({ ...f, ncf: e.target.value }))} placeholder="Se asigna automáticamente" className={`${field} tabular-nums`} />
              </Field>
            </div>
            <div className="space-y-4 min-w-0">
              <Field label="Fecha">
                <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className={field} />
              </Field>
              <Field label="Forma de pago">
                <select value={form.paymentMethod} onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value }))} className={field}>
                  <option value="credit">Crédito (CxC)</option><option value="bank">Banco</option><option value="cash">Efectivo</option><option value="card">Tarjeta</option>
                </select>
              </Field>
            </div>
          </div>

          {/* Líneas */}
          <div className="px-4 sm:px-6 pb-4 border-t border-ink-100 pt-4">
            <h4 className="font-display text-sm font-medium text-ink-700 mb-2">Líneas de la factura</h4>
            <div className="lg:hidden space-y-2">
              {lines.map((l) => {
                const sub = billRes.lines.find((x) => x.id === l.id)?.base || 0;
                return (
                  <div key={l.id} className="rounded-lg border border-ink-100 bg-ink-50/40 p-2 space-y-2">
                    <input value={l.description} onChange={(e) => patchLine(l.id, { description: e.target.value })} placeholder="Descripción" className="input w-full" />
                    <select value={l.accountCode} onChange={(e) => patchLine(l.id, { accountCode: e.target.value })} className="input w-full">
                      <option value="">— Cuenta de ingreso —</option>
                      {incomeAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                    </select>
                    <div className="grid grid-cols-3 gap-2">
                      <label className="text-[11px] text-ink-400">Cant.<input type="number" min="0" step="1" inputMode="decimal" value={l.qty} onChange={(e) => patchLine(l.id, { qty: e.target.value })} className="input w-full text-right tabular-nums mt-0.5" /></label>
                      <label className="text-[11px] text-ink-400">P. unit.<input type="number" min="0" step="0.01" inputMode="decimal" value={l.unitPrice} onChange={(e) => patchLine(l.id, { unitPrice: e.target.value })} className="input w-full text-right tabular-nums mt-0.5" /></label>
                      <label className="text-[11px] text-ink-400">ITBIS<select value={itbisOf(l.taxIds)} onChange={(e) => patchLine(l.id, { taxIds: [e.target.value] })} className="input w-full mt-0.5">{ITBIS_OPTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-ink-600 tabular-nums">Importe {formatDop(sub)}</span>
                      <button type="button" onClick={() => delLine(l.id)} className="btn-icon-danger" title="Eliminar línea" aria-label="Eliminar línea"><Trash2 size={14} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-sm min-w-[680px]">
                <thead className="text-ink-400 text-[11px] uppercase tracking-wide">
                  <tr>
                    <th className="text-left font-medium pb-1">Descripción</th>
                    <th className="text-left font-medium pb-1">Cuenta de ingreso</th>
                    <th className="text-right font-medium pb-1 w-16">Cant.</th>
                    <th className="text-right font-medium pb-1 w-28 whitespace-nowrap">P. unit.</th>
                    <th className="text-left font-medium pb-1 w-28">ITBIS</th>
                    <th className="text-right font-medium pb-1 w-28">Importe</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const sub = billRes.lines.find((x) => x.id === l.id)?.base || 0;
                    return (
                      <tr key={l.id} className="align-top">
                        <td className="py-0.5 pr-2"><input value={l.description} onChange={(e) => patchLine(l.id, { description: e.target.value })} placeholder="Concepto" className="input w-full" /></td>
                        <td className="py-0.5 pr-2">
                          <select value={l.accountCode} onChange={(e) => patchLine(l.id, { accountCode: e.target.value })} className="input w-full max-w-[16rem]">
                            <option value="">— Cuenta —</option>
                            {incomeAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                          </select>
                        </td>
                        <td className="py-0.5"><input type="number" min="0" step="1" inputMode="decimal" value={l.qty} onChange={(e) => patchLine(l.id, { qty: e.target.value })} className="input w-16 text-right tabular-nums" /></td>
                        <td className="py-0.5"><input type="number" min="0" step="0.01" inputMode="decimal" value={l.unitPrice} onChange={(e) => patchLine(l.id, { unitPrice: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLine(); } }} className="input w-28 text-right tabular-nums" /></td>
                        <td className="py-0.5 pr-1"><select value={itbisOf(l.taxIds)} onChange={(e) => patchLine(l.id, { taxIds: [e.target.value] })} className="input w-full">{ITBIS_OPTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></td>
                        <td className="py-0.5 text-right text-ink-700 tabular-nums whitespace-nowrap pr-1 pt-2.5">{sub > 0 ? formatDop(sub) : '—'}</td>
                        <td className="py-0.5 text-right"><button type="button" onClick={() => delLine(l.id)} className="btn-icon-danger" title="Eliminar línea" aria-label="Eliminar línea"><Trash2 size={14} /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <button type="button" onClick={addLine} className="btn-ghost text-xs gap-1 mt-1 px-2"><Plus size={12} /> Línea <span className="text-ink-300 normal-case hidden sm:inline">(o Enter en P. unit.)</span></button>
          </div>

          {/* Totales */}
          <div className="px-4 sm:px-6 py-5 border-t border-ink-100 flex justify-end">
            <div className="w-full sm:max-w-xs space-y-1.5 text-sm">
              <div className="flex justify-between gap-4"><span className="text-ink-500">Gravado</span><span className="tabular-nums">{formatDop(totals.base)}</span></div>
              <div className="flex justify-between gap-4"><span className="text-ink-500">ITBIS</span><span className="tabular-nums">{formatDop(totals.itbis)}</span></div>
              <div className="flex justify-between gap-4 pt-1.5 border-t border-ink-100 font-semibold text-ink-900"><span>Total</span><span className="tabular-nums">{formatDop(totals.total)}</span></div>
            </div>
          </div>

          {/* Action bar */}
          <div className="px-4 sm:px-6 py-3 border-t border-ink-100 bg-ink-50/40 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-ink-500">Al registrar se asienta la venta y se asigna el e-NCF; transmite el e-CF desde Facturación.</div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => navigate('/accounting/facturacion')} disabled={saving} className="btn-secondary">Cancelar</button>
              <button type="button" onClick={save} disabled={saving} className="btn-primary">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Registrar venta
              </button>
            </div>
          </div>
          {err && <p className="text-sm text-rose-600 px-4 sm:px-6 pb-3">{err}</p>}
        </div>
      )}
    </AccountingGate>
  );
}
