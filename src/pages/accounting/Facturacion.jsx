import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Shield, FileText, Loader2, Check, Download, Search, Send, Printer, RefreshCw } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, invalidate } from '../../db/database.js';
import { toRow } from '../../db/rowMapping.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDop, formatDate, formatMoney } from '../../lib/format.js';
import { displayRatesFor } from '../../lib/exchangeRate.js';
import { QUOTE_STATUS_ACCEPTED } from '../../lib/constants.js';
import { downloadCsv } from '../../lib/csv.js';
import PrintPdfModal from '../../components/PrintPdfModal.jsx';
import { quoteToSale } from '../../core/bridge/index.js';
import {
  resolveSales607, resolveItbisLiquidation, buildSaleEntry,
  resolveAccountingConfig, buildEcfPayload, saleEcfType, isValidFiscalId,
  ecfQrUrl, formatEcfDate,
} from '../../core/accounting/index.js';
import { lookupRnc, cleanRnc } from '../../lib/rncLookup.js';
import { assignNextENcf } from '../../lib/ecfSequence.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { supabase } from '../../db/supabaseClient.js';

function ymd(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// A floor sale ("venta de piso") isn't tied to an import order — it's sold off
// the floor, so there's no delivery cycle: the moment money changes hands (the
// deposit) it's ready to bill.
function isFloorSale(q) {
  return !q.orderId;
}

// Ready to invoice = accepted, and either delivered (any order type) or — for a
// floor sale — its deposit has been received. (Special/import orders still wait
// for delivery.)
function readyToInvoice(q) {
  if (q.status !== QUOTE_STATUS_ACCEPTED) return false;
  if (q.deliveredAt) return true;
  return isFloorSale(q) && !!q.depositReceivedAt;
}

// The effective invoice date — delivery if known, else the deposit, else accept.
function invoiceReadyAt(q) {
  return q.deliveredAt || q.depositReceivedAt || q.acceptedAt || Date.now();
}

/**
 * Facturación — recognize sales at delivery, the 607 (ventas) and the monthly
 * ITBIS liquidation (IT-1). "Por facturar" lists accepted quotes already
 * delivered but not yet invoiced; posting one books the sale asiento (applying
 * the client deposit) and records the NCF. Self-gates on accounting/admin.
 */
export default function Facturacion() {
  const { profileId, currentProfile, settings } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const quotesQ = useLiveQueryStatus(() => db.quotes.where('profileId').equals(scope).toArray(), [scope], []);
  const linesQ = useLiveQueryStatus(() => db.quoteLines.toArray(), [], []);
  const customersQ = useLiveQueryStatus(() => db.customers.where('profileId').equals(scope).toArray(), [scope], []);
  const postingsQ = useLiveQueryStatus(() => db.salesPostings.where('profileId').equals(scope).toArray(), [scope], []);
  const expensesQ = useLiveQueryStatus(() => db.expenses.where('profileId').equals(scope).toArray(), [scope], []);
  const purchasesQ = useLiveQueryStatus(() => db.purchases.where('profileId').equals(scope).toArray(), [scope], []);
  const importsQ = useLiveQueryStatus(() => db.importLiquidations.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = quotesQ.loaded && linesQ.loaded && customersQ.loaded && postingsQ.loaded;

  const customersById = useMemo(() => new Map(customersQ.data.map((c) => [c.id, c])), [customersQ.data]);
  const linesByQuote = useMemo(() => {
    const m = new Map();
    for (const ln of linesQ.data) {
      if (!m.has(ln.quoteId)) m.set(ln.quoteId, []);
      m.get(ln.quoteId).push(ln);
    }
    return m;
  }, [linesQ.data]);
  const postedQuoteIds = useMemo(() => new Set(postingsQ.data.map((p) => p.quoteId).filter(Boolean)), [postingsQ.data]);
  const postingById = useMemo(() => new Map(postingsQ.data.map((p) => [p.id, p])), [postingsQ.data]);
  const [transmitting, setTransmitting] = useState(null);
  const [checking, setChecking] = useState(null);
  const [printing, setPrinting] = useState(null);

  // In-app print preview state — the modal rasterizes the PDF and prints via
  // window.print() on our own page, so printing can never become a download.
  const [printDoc, setPrintDoc] = useState(null);   // { blob, title } | null
  async function printInvoice(rowId) {
    const p = postingById.get(rowId);
    if (!p || !p.ncf) return;
    setErr('');
    setPrinting(rowId);
    try {
      const customer = p.customerId ? customersById.get(p.customerId) : null;
      const isEcf = /^E\d{2}/.test(p.ncf);
      const qrUrl = (isEcf && p.securityCode) ? ecfQrUrl({
        environment: settings?.ecfEnvironment || 'cert', ecfType: p.ecfType || '31',
        rncEmisor: cleanRnc(settings?.companyRnc), rncComprador: p.rnc, eNcf: p.ncf,
        total: p.total, fechaEmision: formatEcfDate(p.postedAt),
        fechaFirma: p.fechaFirma || '', securityCode: p.securityCode,
      }) : '';
      const mod = await safeDynamicImport(() => import('../../pdf/accounting/index.js'));
      const blob = await mod.generateInvoicePdf({
        emisor: {
          name: settings?.companyName || '', rnc: cleanRnc(settings?.companyRnc),
          address: settings?.companyAddress, phone: settings?.companyPhone, email: settings?.companyEmail,
        },
        comprador: { name: customer?.name, rnc: p.rnc },
        ecfType: p.ecfType || '31', eNcf: p.ncf, fechaEmision: p.postedAt,
        items: [{ name: `Venta ${p.ncf}`, qty: 1, unitPrice: p.base, amount: p.base }],
        gravado: p.base, itbis: p.itbis, total: p.total, itbisRate: config.itbisRate,
        securityCode: p.securityCode, qrUrl,
      });
      setPrintDoc({ blob, title: `Factura ${p.ncf}` });
    } catch (e) {
      setErr(e?.message || 'No se pudo generar la factura.');
    } finally {
      setPrinting(null);
    }
  }

  async function transmit(rowId) {
    const p = postingById.get(rowId);
    if (!p || !p.ncf) return;
    setErr('');
    setTransmitting(rowId);
    try {
      const customer = p.customerId ? customersById.get(p.customerId) : null;
      const payload = buildEcfPayload({
        ecfType: p.ecfType || saleEcfType(!!p.rnc),
        eNcf: p.ncf,
        sequenceExpiresAt: p.ecfExpiresAt || null,
        emisor: {
          rnc: cleanRnc(settings?.companyRnc), name: settings?.companyName || '',
          address: settings?.companyAddress || '',
        },
        comprador: p.rnc ? { rnc: p.rnc, name: customer?.name } : null,
        items: [{ name: `Venta ${p.ncf}`, qty: 1, unitPrice: p.base, amount: p.base }],
        gravado: p.base, itbis: p.itbis, total: p.total,
        itbisRate: config.itbisRate, fechaEmision: p.postedAt,
        // Contado if the deposit covered the sale; crédito if a balance remains.
        tipoPago: (p.depositApplied || 0) >= p.total ? 1 : 2,
      });
      const { data, error } = await supabase.functions.invoke('ecf-send', {
        body: { payload, eNcf: p.ncf, profileId: scope },
      });
      if (error || !data?.ok) throw new Error(data?.error || error?.message || 'Error transmitiendo el e-CF.');
      await db.salesPostings.update(p.id, {
        trackId: data.trackId || '', securityCode: data.securityCode || '',
        fechaFirma: data.fechaFirma || '', ecfStatus: data.status || 'sent',
      });
    } catch (e) {
      setErr(e?.message || 'Error transmitiendo el e-CF.');
    } finally {
      setTransmitting(null);
    }
  }

  // Ask the DGII what became of a transmitted e-CF (trackId → estado). The
  // send is async on their side: 'sent' only means received, not accepted.
  async function checkStatus(rowId) {
    const p = postingById.get(rowId);
    if (!p?.trackId) return;
    setErr('');
    setChecking(rowId);
    try {
      const { data, error } = await supabase.functions.invoke('ecf-send', {
        body: { op: 'status', trackId: p.trackId, profileId: scope },
      });
      if (error || !data?.ok) throw new Error(data?.error || error?.message || 'Error consultando el estado.');
      const estado = String(data.estado || '');
      const norm = estado.toLowerCase();
      if (norm.includes('acept')) {
        await db.salesPostings.update(p.id, { ecfStatus: 'accepted' });
      } else if (norm.includes('rechaz')) {
        await db.salesPostings.update(p.id, { ecfStatus: 'rejected' });
        setErr(`DGII rechazó ${p.ncf}: ${estado}`);
      } else {
        setErr(`DGII — ${p.ncf}: ${estado || 'en proceso'}`);
      }
    } catch (e) {
      setErr(e?.message || 'Error consultando el estado.');
    } finally {
      setChecking(null);
    }
  }

  // USD totals + DOP conversion for a quote — the CRM→accounting money
  // translation is the bridge's job (quoteToSale); the page only supplies the
  // locked rate and reads back the DOP figures it posts.
  function bookFor(quote) {
    const lines = linesByQuote.get(quote.id) || [];
    const rate = displayRatesFor(quote, settings)?.DOP || 0;
    const { usdTotal, base, itbis, total, deposit } = quoteToSale({ quote, lines, rate, hasFiscalId: false });
    return { rate, usdTotal, base, itbis, total, deposit };
  }

  const deliverables = useMemo(() => {
    if (!loaded) return [];
    return quotesQ.data
      .filter((q) => readyToInvoice(q) && !postedQuoteIds.has(q.id))
      .sort((a, b) => invoiceReadyAt(a) - invoiceReadyAt(b));
  }, [quotesQ.data, postedQuoteIds, loaded]);

  const today = useMemo(() => new Date(), []);
  const [params] = useSearchParams();
  const [tab, setTab] = useState(['607', 'it1'].includes(params.get('tab')) ? params.get('tab') : 'pending'); // 'pending' | '607' | 'it1'
  const win = useMemo(() => ({
    start: new Date(today.getFullYear(), today.getMonth(), 1).getTime(),
    end: today.getTime(),
  }), [today]);

  const sales607 = useMemo(() => resolveSales607({ salesPostings: postingsQ.data, customersById, ...win }),
    [postingsQ.data, customersById, win]);
  const itbis = useMemo(() => resolveItbisLiquidation({
    salesPostings: postingsQ.data, expenses: expensesQ.data,
    purchases: purchasesQ.data, imports: importsQ.data, ...win,
  }), [postingsQ.data, expensesQ.data, purchasesQ.data, importsQ.data, win]);

  const [drafts, setDrafts] = useState({}); // quoteId -> { ncf, rnc, msg }
  const [posting, setPosting] = useState(null);
  const [lookingId, setLookingId] = useState(null);
  const [err, setErr] = useState('');

  const setDraft = (id, patch) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  async function lookupFor(quote) {
    const customer = quote.customerId ? customersById.get(quote.customerId) : null;
    const cur = drafts[quote.id]?.rnc ?? customer?.rnc ?? '';
    setLookingId(quote.id);
    try {
      const r = await lookupRnc(cur);
      if (r.found) setDraft(quote.id, { rnc: r.rnc, msg: `✓ ${r.name}` });
      else setDraft(quote.id, { msg: r.message || 'No encontrado.' });
    } catch (e) {
      setDraft(quote.id, { msg: e?.message || 'Error consultando.' });
    } finally {
      setLookingId(null);
    }
  }

  if (!allowed) {
    return (
      <>
        <PageHeader title="Facturación" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  async function postSale(quote) {
    setErr('');
    const draft = drafts[quote.id] || {};
    const book = bookFor(quote);
    // Validate EVERYTHING before assigning the e-NCF — a failure past that
    // point burns a sequence number (a gap: fiscally fine, but avoidable).
    if (!book.rate) { setErr('La cotización no tiene tasa USD→DOP fijada.'); return; }
    if (book.total <= 0) { setErr('La venta no tiene monto a facturar.'); return; }
    const customer = quote.customerId ? customersById.get(quote.customerId) : null;
    const rnc = cleanRnc(draft.rnc ?? customer?.rnc ?? '');
    if (rnc && !isValidFiscalId(rnc)) {
      setErr('RNC/cédula inválido: debe tener 9 dígitos (RNC) u 11 (cédula).');
      return;
    }
    setPosting(quote.id);
    try {
      const id = newId();
      const postedAt = invoiceReadyAt(quote);
      // e-CF: 31 (crédito fiscal) when the buyer has a fiscal id, else 32
      // (consumo). The e-NCF comes from the atomic assign_next_encf RPC; if no
      // sequence is configured, a manually-typed NCF is the explicit fallback.
      const ecfType = saleEcfType(!!rnc);
      const assigned = await assignNextENcf(scope, ecfType);
      const manualNcf = (draft.ncf || '').trim();
      if (!assigned && !manualNcf) {
        setErr(`No hay secuencia e-CF activa para el tipo ${ecfType}. Autoriza una en Secuencias e-CF, o escribe el NCF manualmente.`);
        return;
      }
      const ncf = assigned ? assigned.eNcf : manualNcf;
      const built = buildSaleEntry({
        newId, config, postedAt,
        sale: {
          id, quoteId: quote.id, customerId: quote.customerId,
          base: book.base, itbis: book.itbis, deposit: book.deposit,
          ncf, memo: `Venta #${quote.number ?? ''}`.trim(),
        },
      });
      // One transaction: asiento + lines + posting land together (numbers
      // assigned server-side) or not at all — no half-posted sale to re-book.
      const { error } = await supabase.rpc('post_sale', {
        p_entry: toRow(built.entry),
        p_lines: built.lines.map(toRow),
        p_posting: toRow({
          id, profileId: scope, quoteId: quote.id, customerId: quote.customerId,
          postedAt, ncf, rnc, ecfType,
          ecfStatus: assigned ? 'pending' : '',
          ecfExpiresAt: assigned?.expiresAt ?? null,
          base: book.base, itbis: book.itbis, total: book.total,
          depositApplied: Math.min(book.deposit, book.total), rate: book.rate, usdTotal: book.usdTotal,
        }),
      });
      if (error) throw new Error(error.message || 'No se pudo registrar la venta.');
      invalidate();
      // Persist the RNC back onto the customer so it's reused next time.
      if (customer && rnc && rnc !== cleanRnc(customer.rnc)) {
        await db.customers.update(customer.id, { rnc });
      }
      setDrafts((d) => { const n = { ...d }; delete n[quote.id]; return n; });
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setPosting(null);
    }
  }

  function export607() {
    const rows = [
      ['RNC/Cédula', 'Nombre', 'NCF', 'Fecha', 'Base', 'ITBIS', 'Total'],
      ...sales607.rows.map((r) => [r.rnc, r.name, r.ncf, ymd(r.date), r.base, r.itbis, r.total]),
    ];
    downloadCsv(`607_${ymd(win.start)}_${ymd(win.end)}.csv`, rows);
  }

  const tabBtn = (key, label) => (
    <button type="button" onClick={() => setTab(key)}
      className={`btn ${tab === key ? 'tab-pill-active' : 'tab-pill'}`}>{label}</button>
  );

  return (
    <>
      <PageHeader title="Facturación" subtitle="Ventas al entregar · 607 · liquidación de ITBIS (IT-1)" />

      <div className="flex flex-wrap gap-2 mb-4">
        {tabBtn('pending', `Por facturar${deliverables.length ? ` (${deliverables.length})` : ''}`)}
        {tabBtn('607', '607')}
        {tabBtn('it1', 'IT-1 (ITBIS)')}
      </div>
      {err && <p className="text-sm text-rose-600 mb-3">{err}</p>}

      {!loaded ? <ListLoading /> : tab === 'pending' ? (
        deliverables.length === 0 ? (
          <EmptyState icon={FileText} title="Nada por facturar"
            description="Las ventas listas para facturar —entregadas, o de piso con depósito recibido— aparecen aquí." />
        ) : (
          <div className="space-y-3">
            {deliverables.map((q) => {
              const book = bookFor(q);
              const customer = q.customerId ? customersById.get(q.customerId) : null;
              const draft = drafts[q.id] || {};
              return (
                <div key={q.id} className="card p-4 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span className="text-xs text-ink-400 tabular-nums">#{q.number ?? '—'}</span>
                    <span className="font-medium truncate">{customer?.name || 'Cliente'}</span>
                    <span className="text-sm text-ink-500 whitespace-nowrap">
                      {q.deliveredAt ? `Entregado ${formatDate(q.deliveredAt)}` : `Depósito ${formatDate(q.depositReceivedAt)}`}
                    </span>
                    <span className="text-sm tabular-nums whitespace-nowrap sm:ml-auto">{formatDop(book.total)} <span className="text-ink-400">({formatMoney(book.usdTotal, 'USD')})</span></span>
                  </div>
                  <div className="text-xs text-ink-500 mb-3 tabular-nums break-words">
                    Base {formatDop(book.base)} · ITBIS {formatDop(book.itbis)}
                    {book.deposit > 0 && <> · Depósito aplicado {formatDop(Math.min(book.deposit, book.total))}</>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex gap-1">
                      <input value={draft.rnc ?? (customer?.rnc || '')} placeholder="RNC / Cédula"
                        onChange={(e) => setDraft(q.id, { rnc: e.target.value })}
                        className="input w-36" />
                      <button type="button" onClick={() => lookupFor(q)}
                        disabled={lookingId === q.id || !cleanRnc(draft.rnc ?? customer?.rnc)}
                        className="btn-icon shrink-0" title="Buscar nombre en el registro DGII">
                        {lookingId === q.id ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                      </button>
                    </div>
                    <input value={draft.ncf || ''} placeholder="NCF (auto si hay secuencia)"
                      onChange={(e) => setDraft(q.id, { ncf: e.target.value })}
                      className="input w-full sm:w-52" />
                    <button type="button" onClick={() => postSale(q)} disabled={posting === q.id}
                      className="btn-primary">
                      {posting === q.id ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Facturar
                    </button>
                    {draft.msg && <span className="text-xs text-ink-500 break-words">{draft.msg}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : tab === '607' ? (
        <>
          <div className="flex justify-end mb-3">
            <button type="button" onClick={export607} disabled={sales607.count === 0}
              className="btn-ghost"><Download size={14} /> Exportar 607 (CSV)</button>
          </div>
          {sales607.count === 0 ? (
            <EmptyState icon={FileText} title="Sin ventas en el mes"
              description="Las ventas facturadas del mes aparecen aquí." />
          ) : (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="whitespace-nowrap">RNC/Cédula</th>
                      <th>Cliente</th>
                      <th className="whitespace-nowrap">NCF</th>
                      <th className="whitespace-nowrap">Fecha</th>
                      <th className="text-right whitespace-nowrap">Base</th>
                      <th className="text-right whitespace-nowrap">ITBIS</th>
                      <th className="text-right whitespace-nowrap">Total</th>
                      <th className="whitespace-nowrap">e-CF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sales607.rows.map((r) => {
                      const p = postingById.get(r.id);
                      const status = p?.ecfStatus || '';
                      const isEcf = /^E\d{2}/.test(p?.ncf || r.ncf || '');
                      return (
                      <tr key={r.id}>
                        <td className="tabular-nums whitespace-nowrap">{r.rnc || '—'}</td>
                        <td className="min-w-[120px]">{r.name || '—'}</td>
                        <td className="tabular-nums text-ink-500 whitespace-nowrap">{r.ncf || '—'}</td>
                        <td className="text-ink-500 whitespace-nowrap">{formatDate(r.date)}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(r.base)}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(r.itbis)}</td>
                        <td className="text-right tabular-nums font-medium whitespace-nowrap">{formatDop(r.total)}</td>
                        <td>
                          <div className="flex items-center gap-3">
                            {status === 'accepted' ? (
                              <span className="text-xs text-emerald-700 whitespace-nowrap">Aceptado</span>
                            ) : status === 'sent' ? (
                              <span className="inline-flex items-center gap-1.5">
                                <span className="text-xs text-emerald-700 whitespace-nowrap">Transmitido</span>
                                {p?.trackId && (
                                  <button type="button" onClick={() => checkStatus(r.id)} disabled={checking === r.id}
                                    title="Consultar estado en la DGII"
                                    className="btn-icon text-ink-400">
                                    {checking === r.id ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                                  </button>
                                )}
                              </span>
                            ) : status === 'rejected' ? (
                              <span className="text-xs text-rose-600 whitespace-nowrap">Rechazado</span>
                            ) : !isEcf ? (
                              <span className="text-xs text-ink-400">—</span>
                            ) : (
                              <button type="button" onClick={() => transmit(r.id)} disabled={transmitting === r.id}
                                className="btn-ghost text-xs whitespace-nowrap">
                                {transmitting === r.id ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Transmitir
                              </button>
                            )}
                            <button type="button" onClick={() => printInvoice(r.id)} disabled={printing === r.id}
                              title="Imprimir factura" className="btn-icon text-ink-400">
                              {printing === r.id ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
                            </button>
                          </div>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-ink-200 font-semibold">
                      <td className="whitespace-nowrap" colSpan={4}>{sales607.count} ventas</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(sales607.totals.base)}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(sales607.totals.itbis)}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(sales607.totals.total)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="card p-5 max-w-md">
          <h2 className="eyebrow font-semibold text-ink-600 mb-3">Liquidación de ITBIS — mes actual</h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span>Débito fiscal (ITBIS ventas)</span><span className="tabular-nums">{formatDop(itbis.debitoFiscal)}</span></div>
            <div className="flex justify-between"><span>Crédito fiscal (ITBIS compras)</span><span className="tabular-nums">−{formatDop(itbis.creditoFiscal)}</span></div>
            <div className="flex justify-between pt-2 mt-1 border-t border-ink-200 font-bold">
              <span>{itbis.aPagar > 0 ? 'ITBIS a pagar' : 'Saldo a favor'}</span>
              <span className="tabular-nums">{formatDop(itbis.aPagar > 0 ? itbis.aPagar : itbis.aFavor)}</span>
            </div>
          </div>
        </div>
      )}
      {printDoc && (
        <PrintPdfModal blob={printDoc.blob} title={printDoc.title} onClose={() => setPrintDoc(null)} />
      )}
    </>
  );
}
