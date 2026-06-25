import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { FileText, Loader2, Check, Download, Search, Send, Printer, RefreshCw, Boxes, FileMinus, FileDown } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, invalidate, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import TabPills from '../../components/accounting/TabPills.jsx';
import KpiBand from '../../components/accounting/KpiBand.jsx';
import { invoiceLinesForQuote } from '../../components/accounting/QuoteLinesDetail.jsx';
import { ActionChips } from '../../components/accounting/ActionCenter.jsx';
import InvoiceDrawer from '../../components/accounting/InvoiceDrawer.jsx';
import RowCards from '../../components/RowCards.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import { formatDop, formatDate, formatMoney } from '../../lib/format.js';
import { displayRatesFor, effectiveDopRate, readExchangeRate } from '../../lib/exchangeRate.js';
import { readyToInvoice, invoiceReadyAt } from '../../lib/quoteMilestones.js';
import { downloadCsv, downloadText } from '../../lib/csv.js';
import PrintPdfModal from '../../components/PrintPdfModal.jsx';
import Modal from '../../components/Modal.jsx';
import { quoteToSale } from '../../core/bridge/index.js';
import {
  resolveSales607, resolveItbisLiquidation, buildSaleEntry, buildCreditNoteEntry, resolveCreditNoteDraft,
  resolveAccountingConfig, buildEcfPayload, saleEcfType, saleTipoPago, saleDueDate, isValidFiscalId, consumoRequiresBuyerId,
  parseENcf, dgii607Txt, dgiiPeriod, dgiiTxtFilename, resolveInvoiceDoc,
  resolveAccountingCockpit, resolveReceivables, resolveInvoiceRegister, invoiceRowTotals, buildPaymentEntry,
} from '../../core/accounting/index.js';
import { lookupRnc, cleanRnc } from '../../lib/rncLookup.js';
import { assignNextENcf } from '../../lib/ecfSequence.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { sendEcf, signEcf, checkEcfStatus } from '../../lib/ecfSend.js';
import { postSaleTx } from '../../lib/salePosting.js';
import { userMessageFor } from '../../lib/errorMessages.js';

function ymd(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Desktop 607 table columns (Shopify-orders-style customizable list). ONE
 * ordered definition drives the header, the data rows, the footer totals AND
 * the Columns menu. `rnc` is the fixed identity anchor (`canHide: false`). The
 * e-CF actions column (status + Transmitir/Imprimir) closes over page handlers,
 * so it stays a FIXED trailing cell OUTSIDE this array. Each `cell`/`foot` is a
 * pure render off its `ctx` bag; `foot` marks a numeric total column so the
 * footer can place it (columns without `foot` merge into the "N ventas" span).
 */
// e-CF status → the leading dot color in the NCF cell (pending pulses).
const ECF_DOT = { accepted: 'bg-emerald-500', sent: 'bg-emerald-500', pending: 'bg-amber-500', rejected: 'bg-rose-500' };
// Payment status → the estado pill [label, skin].
const STATUS_PILL = {
  paid: ['Pagada', 'bg-emerald-100 text-emerald-700'],
  open: ['Por cobrar', 'bg-blue-100 text-blue-700'],
  partial: ['Parcial', 'bg-brand-100 text-brand-700'],
  overdue: ['Vencida', 'bg-rose-100 text-rose-700'],
  note: ['Nota', 'bg-ink-100 text-ink-600'],
  porfacturar: ['Por facturar', 'bg-amber-100 text-amber-800'],
  voided: ['Anulada', 'bg-ink-100 text-ink-400 line-through'],
};

const SALES607_COLUMNS = [
  {
    key: 'rnc', label: 'RNC/Cédula', canHide: false,
    thClass: 'whitespace-nowrap', tdClass: 'tabular-nums whitespace-nowrap',
    cell: ({ r }) => r.rnc || '—',
  },
  {
    key: 'name', label: 'Cliente',
    tdClass: 'min-w-[120px]',
    cell: ({ r }) => r.name || '—',
  },
  {
    key: 'ncf', label: 'e-CF · NCF',
    thClass: 'whitespace-nowrap', tdClass: 'tabular-nums text-ink-500 whitespace-nowrap',
    cell: ({ r }) => (
      <span className="inline-flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ECF_DOT[r.ecfStatus] || 'bg-ink-300'} ${r.ecfStatus === 'pending' ? 'animate-pulse' : ''}`} aria-hidden />
        {r.creditNote
          ? <span title={`Nota de crédito · modifica ${r.modifiesNcf}`}>{r.ncf} <span className="text-rose-500">↩ {r.modifiesNcf || ''}</span></span>
          : (r.ncf || '—')}
      </span>
    ),
  },
  {
    key: 'tipo', label: 'Tipo',
    thClass: 'whitespace-nowrap', tdClass: 'whitespace-nowrap',
    cell: ({ r }) => r.ecfType ? <span className="badge text-[10px] tabular-nums">e-CF {r.ecfType}</span> : <span className="text-ink-300">—</span>,
  },
  {
    key: 'date', label: 'Fecha',
    thClass: 'whitespace-nowrap', tdClass: 'text-ink-500 whitespace-nowrap',
    cell: ({ r }) => formatDate(r.date),
  },
  {
    key: 'base', label: 'Base',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => r.creditNote ? <span className="text-rose-600">{formatDop(-r.base)}</span> : formatDop(r.base),
    foot: ({ totals }) => formatDop(totals.base),
  },
  {
    key: 'itbis', label: 'ITBIS',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => r.creditNote ? <span className="text-rose-600">{formatDop(-r.itbis)}</span> : formatDop(r.itbis),
    foot: ({ totals }) => formatDop(totals.itbis),
  },
  {
    key: 'total', label: 'Total',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums font-medium whitespace-nowrap',
    cell: ({ r }) => r.creditNote ? <span className="text-rose-600">{formatDop(-r.total)}</span> : formatDop(r.total),
    foot: ({ totals }) => formatDop(totals.total),
  },
  {
    key: 'balance', label: 'Balance',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => r.open > 0.01 ? <span className={r.overdue ? 'text-rose-600 font-medium' : 'text-ink-700'}>{formatDop(r.open)}</span> : <span className="text-ink-300">—</span>,
    foot: ({ totals }) => formatDop(totals.open),
  },
  {
    key: 'vence', label: 'Vence',
    thClass: 'whitespace-nowrap', tdClass: 'whitespace-nowrap text-ink-500',
    cell: ({ r }) => (r.status === 'paid' || r.creditNote || !r.dueAt)
      ? <span className="text-ink-300">—</span>
      : <span className={r.overdue ? 'text-rose-600' : ''}>{formatDate(r.dueAt)}</span>,
  },
  {
    key: 'estado', label: 'Estado',
    thClass: 'whitespace-nowrap', tdClass: 'whitespace-nowrap',
    cell: ({ r }) => { const [label, cls] = STATUS_PILL[r.status] || STATUS_PILL.open; return <span className={`chip ${cls}`}>{label}</span>; },
  },
];

const SALES607_DEFAULT = {
  name: true, ncf: true, tipo: true, date: true, base: true, itbis: true, total: true, balance: true, vence: true, estado: true,
};
const SALES607_COLS_KEY = 'rs.facturacion.cols.v2';

// The "ready to invoice" gate + effective invoice date are SHARED with the
// CRM dashboard's "Por facturar" tile — one rule, lib/quoteMilestones.

/**
 * Facturación — recognize sales at delivery, the 607 (ventas) and the monthly
 * ITBIS liquidation (IT-1). "Por facturar" lists accepted quotes already
 * delivered but not yet invoiced; posting one books the sale asiento (applying
 * the client deposit) and records the NCF. Self-gates on accounting/admin.
 */
export default function Facturacion() {
  const { profileId, settings } = useApp();
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const quotesQ = useLiveQueryStatus(() => db.quotes.where('profileId').equals(scope).toArray(), [scope], []);
  const linesQ = useLiveQueryStatus(() => db.quoteLines.toArray(), [], []);
  const customersQ = useLiveQueryStatus(() => db.customers.where('profileId').equals(scope).toArray(), [scope], []);
  const postingsQ = useLiveQueryStatus(() => db.salesPostings.where('profileId').equals(scope).toArray(), [scope], []);
  const expensesQ = useLiveQueryStatus(() => db.expenses.where('profileId').equals(scope).toArray(), [scope], []);
  const purchasesQ = useLiveQueryStatus(() => db.purchases.where('profileId').equals(scope).toArray(), [scope], []);
  const importsQ = useLiveQueryStatus(() => db.importLiquidations.where('profileId').equals(scope).toArray(), [scope], []);
  const expedientesQ = useLiveQueryStatus(() => db.importExpedientes.where('profileId').equals(scope).toArray(), [scope], []);
  const paymentsQ = useLiveQueryStatus(() => db.payments.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const ecfSeqQ = useLiveQueryStatus(() => db.ecfSequences.where('profileId').equals(scope).toArray(), [scope], []);
  const periodsQ = useLiveQueryStatus(() => db.fiscalPeriods.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = quotesQ.loaded && linesQ.loaded && customersQ.loaded && postingsQ.loaded;

  const customersById = useMemo(() => new Map(customersQ.data.map((c) => [c.id, c])), [customersQ.data]);
  const suppliersById = useMemo(() => new Map(suppliersQ.data.map((s) => [s.id, s])), [suppliersQ.data]);
  // Open receivables (allocations + FIFO already applied) — feeds each factura's
  // balance + estado in the register, and the "Por cobrar" vital.
  const pipelineReceivables = useMemo(
    () => resolveReceivables({ salesPostings: postingsQ.data, payments: paymentsQ.data, customersById }),
    [postingsQ.data, paymentsQ.data, customersById],
  );
  const linesByQuote = useMemo(() => {
    const m = new Map();
    for (const ln of linesQ.data) {
      if (!m.has(ln.quoteId)) m.set(ln.quoteId, []);
      m.get(ln.quoteId).push(ln);
    }
    return m;
  }, [linesQ.data]);
  const postedQuoteIds = useMemo(() => new Set(postingsQ.data.filter((p) => !p.voidedAt).map((p) => p.quoteId).filter(Boolean)), [postingsQ.data]);
  const postingById = useMemo(() => new Map(postingsQ.data.map((p) => [p.id, p])), [postingsQ.data]);
  const quotesById = useMemo(() => new Map(quotesQ.data.map((q) => [q.id, q])), [quotesQ.data]);
  const [transmitting, setTransmitting] = useState(null);
  const [bulk, setBulk] = useState(null); // { done, total, failed } during "Transmitir todos"
  const [generating, setGenerating] = useState(null);
  const [checking, setChecking] = useState(null);
  const [printing, setPrinting] = useState(null);

  // In-app print preview state — the modal rasterizes the PDF and prints via
  // window.print() on our own page, so printing can never become a download.
  const [printDoc, setPrintDoc] = useState(null);   // { blob, title } | null
  const [creditNote, setCreditNote] = useState(null); // { posting, kind:'full'|'partial', amount } | null
  const [issuingNc, setIssuingNc] = useState(false);
  async function printInvoice(rowId) {
    const p = postingById.get(rowId);
    if (!p) return;
    setErr('');
    // A signed e-CF's representación impresa MUST carry the timbre (QR + código
    // de seguridad), which only exists after signing — transmit first. A plain
    // sale (no e-NCF) prints fine without it.
    const isEcf = /^E\d{2}/.test(p.ncf || '');
    if (isEcf && !p.securityCode) {
      setErr(`Genera el XML (o transmite) ${p.ncf} antes de imprimir — el timbre (QR) requiere la firma digital.`);
      return;
    }
    setPrinting(rowId);
    try {
      const customer = p.customerId ? customersById.get(p.customerId) : null;
      const quote = p.quoteId ? quotesById.get(p.quoteId) : null;
      const props = resolveInvoiceDoc({
        posting: p, customer, quote, payments: paymentsQ.data, settings, config,
      });
      const mod = await safeDynamicImport(() => import('../../pdf/accounting/index.js'));
      const blob = await mod.generateInvoicePdf(props);
      setPrintDoc({ blob, title: `Factura ${p.ncf || customer?.name || ''}`.trim() });
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setPrinting(null);
    }
  }

  // Issue a nota de crédito (e-CF 34) against a posted+transmitted sale: validate
  // the credited amount, assign an E34 e-NCF, post the reversing asiento, and
  // persist a posting the 607/IT-1 net out. It then transmits like any e-CF from
  // the row's "Transmitir".
  async function issueCreditNote() {
    const sale = creditNote?.posting;
    if (!sale) return;
    setErr('');
    if (!/^E3[12]/.test(sale.ncf || '')) {
      setErr('Sólo una venta con e-CF (31/32) admite nota de crédito.');
      return;
    }
    setIssuingNc(true);
    try {
      // Base already credited by prior notas against THIS sale → remaining balance.
      const priorCreditedBase = postingsQ.data
        .filter((x) => x.modifiesPostingId === sale.id && /^E34/.test(x.ncf || ''))
        .reduce((s, x) => s + (Number(x.base) || 0), 0);
      // Validate the amounts BEFORE assigning the e-NCF (a bad draft burns no number).
      const draft = resolveCreditNoteDraft({
        sale: { base: sale.base, itbis: sale.itbis, depositApplied: sale.depositApplied },
        kind: creditNote.kind,
        creditedBase: Number(creditNote.amount) || 0,
        itbisRate: config.itbisRate,
        priorCreditedBase,
      });
      const assigned = await assignNextENcf(scope, '34');
      if (!assigned) {
        setErr('No hay secuencia e-CF activa para el tipo 34 (nota de crédito). Autoriza una en Secuencias e-CF.');
        return;
      }
      const id = newId();
      const postedAt = Date.now();
      const ncf = assigned.eNcf;
      const built = buildCreditNoteEntry({
        newId, config, postedAt,
        note: {
          id, quoteId: sale.quoteId, customerId: sale.customerId,
          base: draft.base, itbis: draft.itbis, depositToRestore: draft.depositToRestore,
          ncf, memo: `Nota de crédito ${ncf} · modifica ${sale.ncf}`,
        },
      });
      await postSaleTx({
        entry: built.entry,
        lines: built.lines,
        posting: {
          id, profileId: scope, quoteId: sale.quoteId, customerId: sale.customerId,
          postedAt, ncf, rnc: sale.rnc, ecfType: '34',
          ecfStatus: 'pending', ecfExpiresAt: assigned.expiresAt ?? null,
          base: draft.base, itbis: draft.itbis, total: draft.total, depositApplied: 0,
          modifiesNcf: sale.ncf, modifiesPostingId: sale.id, codigoModificacion: draft.codigoModificacion,
        },
      });
      invalidate();
      setCreditNote(null);
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setIssuingNc(false);
    }
  }

  async function transmit(rowId) {
    const p = postingById.get(rowId);
    if (p) await transmitPosting(p);
  }

  // Signing pre-flight, shared by Generar XML + Transmitir: only a well-formed
  // e-NCF can be signed (a manual NCF would burn a DGII rejection), and signing
  // needs the cert + the emisor RNC. Returns an error message, or '' if ready.
  function ecfPreflight(p) {
    if (!parseENcf(p.ncf)) return `${p.ncf} no es un e-NCF — sólo los comprobantes electrónicos se firman.`;
    if (!settings?.ecfCertUploadedAt) return 'Sube el certificado digital (.p12) en Configuración contable antes de firmar e-CF.';
    if (!cleanRnc(settings?.companyRnc)) return 'Define el RNC del emisor en Configuración contable antes de firmar e-CF.';
    return '';
  }

  // The e-CF payload for one posting — the SAME shape whether we sign to preview
  // or sign to transmit, so the printed/downloaded doc can never disagree with
  // the one sent. A nota de crédito (E34) carries the InformacionReferencia and
  // transmits as contado; a sale carries its TipoPago (+ fecha límite if crédito).
  function buildPostingPayload(p) {
    const customer = p.customerId ? customersById.get(p.customerId) : null;
    const isNota = /^E34/.test(p.ncf || '');
    const original = isNota && p.modifiesPostingId ? postingById.get(p.modifiesPostingId) : null;
    const tipoPago = isNota ? 1 : saleTipoPago(p.depositApplied, p.total);
    return buildEcfPayload({
      ecfType: p.ecfType || saleEcfType(!!p.rnc),
      eNcf: p.ncf,
      sequenceExpiresAt: p.ecfExpiresAt || null,
      emisor: {
        rnc: cleanRnc(settings?.companyRnc), name: settings?.companyName || '',
        address: settings?.companyAddress || '',
      },
      comprador: p.rnc ? { rnc: p.rnc, name: customer?.name } : null,
      items: [{ name: `${isNota ? 'Nota de crédito' : 'Venta'} ${p.ncf}`, qty: 1, unitPrice: p.base, amount: p.base }],
      gravado: p.base, itbis: p.itbis, total: p.total,
      itbisRate: config.itbisRate, fechaEmision: p.postedAt,
      tipoPago,
      fechaLimitePago: tipoPago === 2 ? saleDueDate(p.postedAt) : null,
      referencia: isNota ? {
        ncfModificado: p.modifiesNcf,
        fechaNcfModificado: original?.postedAt ?? null,
        codigoModificacion: p.codigoModificacion ?? 1,
      } : null,
    });
  }

  // Generate the SIGNED e-CF XML WITHOUT transmitting. The signature is produced
  // locally from the .p12, so this works before the DGII link is live — it's the
  // first step of the set de pruebas. Its código de seguridad + fecha de firma
  // are exactly what put the timbre (QR) on the printed factura, so after this
  // the representación impresa shows the QR. The XML downloads for validation.
  async function generateXml(p) {
    if (!p || !p.ncf) return;
    if (p.ecfStatus === 'sent' || p.ecfStatus === 'accepted') return;
    setErr('');
    const pf = ecfPreflight(p);
    if (pf) { setErr(pf); return; }
    setGenerating(p.id);
    try {
      const data = await signEcf({ payload: buildPostingPayload(p), eNcf: p.ncf, profileId: scope });
      await db.salesPostings.update(p.id, {
        securityCode: data.securityCode || '', fechaFirma: data.fechaFirma || '',
      });
      downloadText(`${cleanRnc(settings?.companyRnc)}${p.ncf}.xml`, data.signedXml || '');
      invalidate();
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setGenerating(null);
    }
  }

  // Core transmit — sign+send one e-CF and persist the result; returns
  // {ok, error} with NO global UI state, so the single button AND the bulk run
  // share the exact same path. Never re-sends an e-NCF already at the DGII (that
  // would duplicate one fiscal number) — that's a silent skip.
  async function transmitOne(p) {
    if (p.ecfStatus === 'sent' || p.ecfStatus === 'accepted') return { ok: true };
    const pf = ecfPreflight(p);
    if (pf) return { ok: false, error: pf };
    try {
      const data = await sendEcf({ payload: buildPostingPayload(p), eNcf: p.ncf, profileId: scope });
      await db.salesPostings.update(p.id, {
        trackId: data.trackId || '', securityCode: data.securityCode || '',
        fechaFirma: data.fechaFirma || '', ecfStatus: data.status || 'sent',
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: userMessageFor(e) };
    }
  }

  // Transmit one posting's e-CF to the DGII. Takes the posting OBJECT (not a
  // row id) so postSale can auto-transmit the sale it just booked before the
  // live query refetches; the manual Transmitir button stays the retry path.
  async function transmitPosting(p) {
    if (!p || !p.ncf) return;
    setErr('');
    setTransmitting(p.id);
    const r = await transmitOne(p);
    if (!r.ok) setErr(r.error);
    setTransmitting(null);
  }

  // Transmit EVERY pending e-CF in one run — the set de pruebas (and day-to-day
  // catch-up) means many at once. Sequential on purpose: fiscal sends shouldn't
  // be hammered in parallel, and per-doc errors stay attributable. Live progress
  // + a final tally; one failure never aborts the rest.
  async function transmitAllPending() {
    const pending = postingsQ.data
      .filter((p) => p.ncf && p.ecfStatus === 'pending' && parseENcf(p.ncf))
      .sort((a, b) => (a.postedAt || 0) - (b.postedAt || 0));
    if (!pending.length) return;
    const pf = ecfPreflight(pending[0]); // one cert/RNC pre-check before looping
    if (pf) { setErr(pf); return; }
    setErr('');
    let done = 0, failed = 0, firstErr = '';
    setBulk({ done, total: pending.length, failed, kind: 'tx' });
    for (const p of pending) {
      const r = await transmitOne(p);
      done += 1;
      if (!r.ok) { failed += 1; if (!firstErr) firstErr = `${p.ncf}: ${r.error}`; }
      setBulk({ done, total: pending.length, failed, kind: 'tx' });
    }
    invalidate();
    setBulk(null);
    setErr(failed
      ? `Transmitidos ${done - failed}/${pending.length}. ${failed} con error — ${firstErr}`
      : `✓ ${pending.length} e-CF transmitidos a la DGII.`);
  }

  // Core status check — resolve one transmitted e-CF's DGII estado and persist
  // accepted/rejected. Returns {status:'accepted'|'rejected'|'pending', estado}
  // with no global UI state, so the single button AND the bulk run reuse it.
  async function checkOne(p) {
    if (!p?.trackId) return { status: 'pending' };
    try {
      const data = await checkEcfStatus({ trackId: p.trackId, profileId: scope });
      const estado = String(data.estado || '');
      const norm = estado.toLowerCase();
      if (norm.includes('acept')) { await db.salesPostings.update(p.id, { ecfStatus: 'accepted' }); return { status: 'accepted', estado }; }
      if (norm.includes('rechaz')) { await db.salesPostings.update(p.id, { ecfStatus: 'rejected' }); return { status: 'rejected', estado }; }
      return { status: 'pending', estado };
    } catch (e) {
      return { status: 'pending', error: userMessageFor(e) };
    }
  }

  // Ask the DGII what became of a transmitted e-CF (trackId → estado). The
  // send is async on their side: 'sent' only means received, not accepted.
  async function checkStatus(rowId) {
    const p = postingById.get(rowId);
    if (!p?.trackId) return;
    setErr('');
    setChecking(rowId);
    const r = await checkOne(p);
    if (r.error) setErr(r.error);
    else if (r.status === 'rejected') setErr(`DGII rechazó ${p.ncf}: ${r.estado}`);
    else if (r.status === 'pending') setErr(`DGII — ${p.ncf}: ${r.estado || 'en proceso'}`);
    setChecking(null);
  }

  // Consultar EVERY transmitted ('sent') e-CF at once — the batch complement to
  // "Transmitir todos": after the set de pruebas lands, resolve all the acuses in
  // one pass instead of one click per document. Sequential, with a final tally.
  async function checkAllSent() {
    const sent = postingsQ.data.filter((p) => p.ecfStatus === 'sent' && p.trackId)
      .sort((a, b) => (a.postedAt || 0) - (b.postedAt || 0));
    if (!sent.length) return;
    setErr('');
    let done = 0, accepted = 0, rejected = 0, pend = 0;
    setBulk({ done, total: sent.length, failed: 0, kind: 'check' });
    for (const p of sent) {
      const r = await checkOne(p);
      done += 1;
      if (r.status === 'accepted') accepted += 1;
      else if (r.status === 'rejected') rejected += 1;
      else pend += 1;
      setBulk({ done, total: sent.length, failed: rejected, kind: 'check' });
    }
    invalidate();
    setBulk(null);
    const tail = `${accepted} aceptados, ${rejected} rechazados, ${pend} en proceso`;
    setErr(rejected === 0 ? `✓ Consultados ${sent.length}: ${tail}.` : `Consultados ${sent.length}: ${tail}.`);
  }

  // Auto-refresh DGII status: a transmitted e-CF sits in 'sent' until the DGII
  // resolves it asynchronously — on load, silently re-ask for the oldest few
  // pending trackIds so acceptances/rejections land without anyone clicking
  // Consultar. One shot per visit; failures stay silent (the manual button
  // remains the explicit path).
  const autoChecked = useRef(false);
  useEffect(() => {
    if (autoChecked.current || !postingsQ.loaded) return;
    const pending = postingsQ.data
      .filter((p) => p.ecfStatus === 'sent' && p.trackId)
      .sort((a, b) => (a.postedAt || 0) - (b.postedAt || 0))
      .slice(0, 5);
    if (pending.length === 0) return;
    autoChecked.current = true;
    (async () => {
      for (const p of pending) {
        try {
          const data = await checkEcfStatus({ trackId: p.trackId, profileId: scope });
          const norm = String(data?.estado || '').toLowerCase();
          if (norm.includes('acept')) {
            await db.salesPostings.update(p.id, { ecfStatus: 'accepted' });
          } else if (norm.includes('rechaz')) {
            await db.salesPostings.update(p.id, { ecfStatus: 'rejected' });
          }
        } catch { /* silent — Consultar covers the manual path */ }
      }
    })();
  }, [postingsQ.loaded, postingsQ.data, scope]);

  // USD totals + DOP conversion for a quote — the CRM→accounting money
  // translation is the bridge's job (quoteToSale); the page only supplies the
  // locked rate and reads back the DOP figures it posts.
  function bookFor(quote) {
    const lines = linesByQuote.get(quote.id) || [];
    const rate = displayRatesFor(quote, settings)?.DOP || 0;
    // A company-account (house-stock) quote suppresses ITBIS on screen and in the
    // PDF — the bridge books it the same way (from settings) so the asiento/e-CF
    // match what the dealer saw.
    const { usdTotal, base, itbis, total, deposit } = quoteToSale({ quote, lines, rate, hasFiscalId: false, settings });
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
  const [tab, setTab] = useState(['cobrar', 'pagadas', 'ecf', 'porfacturar', 'anuladas'].includes(params.get('tab')) ? params.get('tab') : 'todas'); // 'todas'|'cobrar'|'pagadas'|'ecf'|'porfacturar'|'anuladas'
  const win = useMemo(() => ({
    start: new Date(today.getFullYear(), today.getMonth(), 1).getTime(),
    end: today.getTime(),
  }), [today]);

  const [q607, setQ607] = useState('');
  const sales607 = useMemo(() => resolveSales607({ salesPostings: postingsQ.data, customersById, ...win }),
    [postingsQ.data, customersById, win]);
  // The CSV/TXT 607 exports stay the FULL month (a filtered fiscal file would
  // underreport), so they read `sales607` above — not the on-screen register.
  const itbis = useMemo(() => resolveItbisLiquidation({
    salesPostings: postingsQ.data, expenses: expensesQ.data,
    purchases: purchasesQ.data, imports: importsQ.data, expedientes: expedientesQ.data, ...win,
  }), [postingsQ.data, expensesQ.data, purchasesQ.data, importsQ.data, expedientesQ.data, win]);

  // Cockpit — the prioritized "needs attention" actions, surfaced where the
  // dealer actually invoices. SAME resolver the Resumen dashboard uses, so the
  // two can never disagree; "as of today", independent of the 607 search box.
  const cockpit = useMemo(() => resolveAccountingCockpit({
    settings, fiscalPeriods: periodsQ.data, quotes: quotesQ.data, salesPostings: postingsQ.data,
    payments: paymentsQ.data, purchases: purchasesQ.data, expenses: expensesQ.data,
    customersById, suppliersById, ecfSequences: ecfSeqQ.data, now: today.getTime(),
  }), [settings, periodsQ.data, quotesQ.data, postingsQ.data, paymentsQ.data, purchasesQ.data, expensesQ.data, customersById, suppliersById, ecfSeqQ.data, today]);
  // Payables belong to the compras side, not the invoicing screen — the strip
  // carries the selling + fiscal pendientes only.
  const facturaActions = useMemo(() => cockpit.actions.filter((a) => a.kind !== 'payable'), [cockpit]);
  const monthLabel = useMemo(() => today.toLocaleDateString('es-DO', { month: 'short' }).replace('.', ''), [today]);
  // Cobros de clientes recibidos en el período — el KPI "Cobrado · mes".
  const cobradoMes = useMemo(() => paymentsQ.data
    .filter((p) => p.direction === 'in' && p.partyType === 'customer' && p.paidAt >= win.start && p.paidAt <= win.end)
    .reduce((s, p) => s + (Number(p.amount) || 0), 0), [paymentsQ.data, win]);

  // The SINGLE invoice register — every factura (not month-scoped: overdue
  // prior-month docs belong here too) with its payment status, balance and e-CF
  // state. This one list backs the pane, filtered by the status pill + search.
  const register = useMemo(() => resolveInvoiceRegister({
    salesPostings: postingsQ.data, receivables: pipelineReceivables, customersById, now: today.getTime(),
  }), [postingsQ.data, pipelineReceivables, customersById, today]);
  // Delivered-but-not-yet-invoiced quotes fold into the SAME table as
  // 'porfacturar' rows — clicking one opens the facturar modal (vs the detail
  // drawer for a posted factura), so the entrega → factura step never leaves
  // this screen.
  const porfacturarRows = useMemo(() => deliverables.map((q) => {
    const c = q.customerId ? customersById.get(q.customerId) : null;
    const book = bookFor(q);
    return {
      id: q.id, kind: 'porfacturar', quote: q,
      name: c?.name || 'Cliente', rnc: c?.rnc || '', ncf: '',
      date: invoiceReadyAt(q), base: book.base, itbis: book.itbis, total: book.total,
      open: 0, status: 'porfacturar', ecfStatus: '', ecfType: '', creditNote: false, needsEcf: false,
    };
  }), [deliverables, customersById, linesByQuote, settings]);
  const registerView = useMemo(() => {
    let rows;
    if (tab === 'porfacturar') rows = porfacturarRows;
    else if (tab === 'cobrar') rows = register.rows.filter((r) => ['open', 'partial', 'overdue'].includes(r.status));
    else if (tab === 'pagadas') rows = register.rows.filter((r) => r.status === 'paid');
    else if (tab === 'ecf') rows = register.rows.filter((r) => r.needsEcf);
    else if (tab === 'anuladas') rows = register.rows.filter((r) => r.status === 'voided');
    else rows = [...porfacturarRows, ...register.rows.filter((r) => r.status !== 'voided')]; // Todas: active only (anuladas have their own filter)
    const query = q607.trim().toLowerCase();
    if (query) rows = rows.filter((r) => [r.name, r.rnc, r.ncf].some((v) => (v || '').toLowerCase().includes(query)));
    // Totals over posted facturas only — a por-facturar isn't a factura yet.
    return { rows, totals: invoiceRowTotals(rows.filter((r) => r.kind !== 'porfacturar')), count: rows.length };
  }, [register, porfacturarRows, tab, q607]);

  // e-NCFs assigned but never transmitted — the count the 607 tab badges so
  // signed-but-unsent invoices can't sit invisible.
  const pendingEcfCount = useMemo(
    () => postingsQ.data.filter((p) => p.ecfStatus === 'pending').length,
    [postingsQ.data],
  );
  const sentEcfCount = useMemo(
    () => postingsQ.data.filter((p) => p.ecfStatus === 'sent' && p.trackId).length,
    [postingsQ.data],
  );

  const [drafts, setDrafts] = useState({}); // quoteId -> { ncf, rnc, msg }
  const [posting, setPosting] = useState(null);
  const [lookingId, setLookingId] = useState(null);
  const [err, setErr] = useState('');
  const [drawerRow, setDrawerRow] = useState(null); // posted factura whose detail briefing is open
  const [facturarQuote, setFacturarQuote] = useState(null); // por-facturar quote whose facturar modal is open
  const navigate = useNavigate();
  const searchRef = useRef(null);
  const focusedRowRef = useRef(null);
  const [focusIdx, setFocusIdx] = useState(0);
  // Reset the keyboard cursor when the visible row set changes.
  useEffect(() => { setFocusIdx(0); }, [tab, q607]);
  // Clear the shared message when the drawer opens/closes so a stale page error
  // never leaks into the fiscal-action footer (the drawer covers the page banner,
  // so fiscalMsg is the only place transmit/imprimir feedback is visible there).
  useEffect(() => { setErr(''); }, [drawerRow]);
  useEffect(() => { focusedRowRef.current?.scrollIntoView({ block: 'nearest' }); }, [focusIdx]);
  // Palantir-style keyboard nav over the register (desktop). Overlays own the
  // keyboard when open; typing in a field is never intercepted (except '/').
  useEffect(() => {
    if (!loaded) return undefined;
    const onKey = (e) => {
      if (drawerRow || facturarQuote || creditNote || printDoc) return;
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      if (e.key === '/' && !typing) { e.preventDefault(); searchRef.current?.focus(); return; }
      if (typing) return;
      const rows = registerView.rows;
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, rows.length - 1)); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setFocusIdx((i) => Math.max(0, i - 1)); }
      else if (e.key === 'Enter') { const r = rows[focusIdx]; if (r) { if (r.kind === 'porfacturar') setFacturarQuote(r.quote); else setDrawerRow(r); } }
      else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); navigate('/accounting/facturacion/nueva'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loaded, drawerRow, facturarQuote, creditNote, printDoc, registerView, focusIdx, navigate]);

  // Column visibility (Shopify "edit columns") for the 607 table — persisted
  // per browser. The e-CF actions column stays a fixed trailing cell.
  const {
    visible: visible607, setVisible: setVisible607, reset: reset607, cols: cols607,
  } = useColumns(SALES607_COLUMNS, SALES607_DEFAULT, SALES607_COLS_KEY);
  // Drag-to-resize widths (persisted) for the 607 columns. The e-CF actions
  // column stays a fixed trailing cell — no handle.
  const {
    tableRef: tableRef607, tableStyle: tableStyle607, thProps: thProps607,
    ResizeHandle: ResizeHandle607, reset: resetWidths607,
  } = useColumnWidths(cols607, 'rs.facturacion.widths.v2');

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
      setDraft(quote.id, { msg: userMessageFor(e) });
    } finally {
      setLookingId(null);
    }
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
    // A consumo (32) of RD$250,000+ MUST identify the buyer — block here, BEFORE
    // assignNextENcf, or we burn an E32 that buildEcfPayload will refuse to
    // transmit (a permanent, un-fillable fiscal-number gap).
    if (!rnc && consumoRequiresBuyerId(book.total)) {
      setErr('Una factura de RD$250,000 o más requiere el RNC/cédula del comprador (se emite como crédito fiscal 31). Agrégalo y vuelve a facturar.');
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
      // On the manual-NCF fallback, trust the typed e-NCF's own type prefix over
      // the RNC-derived guess: the stored ecfType drives the e-CF payload's
      // TipoeCF and the QR consulta path on transmit, so it must never disagree
      // with the number actually issued (a 31 payload on an E32 number is a DGII
      // rejection). A legacy non-e NCF (parseENcf → null) keeps the guess and is
      // never transmitted anyway.
      const ecfTypeForNcf = (!assigned && parseENcf(ncf)?.type) || ecfType;
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
      await postSaleTx({
        entry: built.entry,
        lines: built.lines,
        posting: {
          id, profileId: scope, quoteId: quote.id, customerId: quote.customerId,
          postedAt, ncf, rnc, ecfType: ecfTypeForNcf,
          ecfStatus: assigned ? 'pending' : '',
          ecfExpiresAt: assigned?.expiresAt ?? null,
          base: book.base, itbis: book.itbis, total: book.total,
          depositApplied: Math.min(book.deposit, book.total), rate: book.rate, usdTotal: book.usdTotal,
        },
      });
      invalidate();
      // Persist the RNC back onto the customer so it's reused next time.
      if (customer && rnc && rnc !== cleanRnc(customer.rnc)) {
        await db.customers.update(customer.id, { rnc });
      }
      setDrafts((d) => { const n = { ...d }; delete n[quote.id]; return n; });
      // Auto-transmit the freshly assigned e-NCF when cert + emisor RNC are
      // configured — no second manual step on the happy path. A failure stays
      // 'pending' and surfaces in the 607 badge; Transmitir retries it with
      // the SAME e-NCF (the state machine never reassigns).
      if (assigned && settings?.ecfCertUploadedAt && cleanRnc(settings?.companyRnc)) {
        transmitPosting({
          id, customerId: quote.customerId, ncf, rnc, ecfType,
          ecfExpiresAt: assigned?.expiresAt ?? null, postedAt,
          base: book.base, itbis: book.itbis, total: book.total,
          depositApplied: Math.min(book.deposit, book.total),
        }).catch(() => { /* surfaced via setErr inside; badge keeps the count */ });
      }
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setPosting(null);
    }
  }

  // Registrar cobro straight from the invoice briefing — posts the cobro asiento
  // (Debit Banco/Caja / Credit CxC via buildPaymentEntry) + the numbered payment
  // row allocated to THIS factura, the SAME path Banca uses, so the receivable
  // clears without ever leaving Facturación.
  async function collectInvoice(p, { amount, method, date }) {
    const amt = Number(amount) || 0;
    if (!p || amt <= 0) return { ok: false, error: 'El monto debe ser mayor que cero.' };
    try {
      const id = newId();
      const postedAt = date ? new Date(date).getTime() : Date.now();
      const reference = `Cobro ${p.ncf || ''}`.trim();
      const built = buildPaymentEntry({
        newId, config, postedAt,
        payment: {
          id, direction: 'in', partyType: 'customer', partyId: p.customerId,
          amount: amt, method, reference,
          commission: 0, commissionItbis: 0, itbisRetained: 0, isrRetained: 0,
        },
      });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      await assignSequenceNumber({
        table: 'payments', profileId: scope, start: 1,
        build: (n) => ({
          id, profileId: scope, number: n, direction: 'in', partyType: 'customer', partyId: p.customerId,
          paidAt: postedAt, amount: amt, method, reference,
          commission: 0, commissionItbis: 0, itbisRetained: 0, isrRetained: 0,
          allocations: [{ docId: p.id, amount: amt }], journalEntryId: built.entry.id,
        }),
      });
      invalidate();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: userMessageFor(e) };
    }
  }

  // Anular una factura NO transmitida — reversa el asiento (el inverso exacto de
  // buildSaleEntry, vía buildCreditNoteEntry) y marca el posting como anulado. El
  // e-NCF queda como un hueco en la secuencia (la DGII lo acepta). Un e-CF YA
  // transmitido (sent/accepted) sólo se cancela con nota de crédito. Si estaba
  // ligada a una cotización, ésta vuelve a "Por facturar".
  async function voidInvoice(p, reason) {
    if (!p) return { ok: false, error: 'Factura no encontrada.' };
    if (p.voidedAt) return { ok: false, error: 'La factura ya está anulada.' };
    if (p.ecfStatus === 'sent' || p.ecfStatus === 'accepted') {
      return { ok: false, error: 'Un e-CF ya transmitido a la DGII sólo se cancela con una nota de crédito.' };
    }
    if (/^E34/.test(p.ncf || '')) {
      return { ok: false, error: 'Una nota de crédito no se anula por aquí.' };
    }
    try {
      const postedAt = Date.now();
      const built = buildCreditNoteEntry({
        newId, config, postedAt,
        note: {
          id: p.id, quoteId: p.quoteId, customerId: p.customerId,
          base: p.base, itbis: p.itbis, depositToRestore: p.depositApplied || 0,
          ncf: null, memo: `Anulación ${p.ncf || `venta #${p.number ?? ''}`}`.trim(),
        },
      });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      await db.salesPostings.update(p.id, { voidedAt: postedAt, voidedReason: reason || '' });
      invalidate();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: userMessageFor(e) };
    }
  }

  function export607() {
    const rows = [
      ['RNC/Cédula', 'Nombre', 'NCF', 'Fecha', 'Base', 'ITBIS', 'Total'],
      ...sales607.rows.map((r) => [r.rnc, r.name, r.ncf, ymd(r.date), r.base, r.itbis, r.total]),
    ];
    downloadCsv(`607_${ymd(win.start)}_${ymd(win.end)}.csv`, rows);
  }

  // The official fixed-format TXT the DGII portal actually ingests (the CSV is
  // the human-readable copy). Needs the emisor RNC for the header line.
  function export607Txt() {
    setErr('');
    if (!settings?.companyRnc) {
      setErr('Define el RNC del emisor en Configuración contable para generar el TXT DGII.');
      return;
    }
    const period = dgiiPeriod(win.end);
    const txt = dgii607Txt({ rows: sales607.rows, payments: paymentsQ.data, rncEmisor: settings?.companyRnc, period });
    downloadText(dgiiTxtFilename('607', settings?.companyRnc, period), txt);
  }

  // e-CF status + actions for one 607 row — shared by the desktop cell and
  // the mobile card so the two variants can't drift.
  function ecfActions(r) {
    const p = postingById.get(r.id);
    if (p?.voidedAt) return <span className="text-xs text-ink-400 whitespace-nowrap">Anulada</span>;
    const status = p?.ecfStatus || '';
    const isEcf = /^E\d{2}/.test(p?.ncf || r.ncf || '');
    return (
      <div className="flex items-center gap-3">
        {status === 'accepted' ? (
          <span className="text-xs text-emerald-700 whitespace-nowrap">Aceptado</span>
        ) : status === 'sent' ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-xs text-emerald-700 whitespace-nowrap">Transmitido</span>
            {p?.trackId && (
              <button type="button" onClick={() => checkStatus(r.id)} disabled={checking === r.id}
                title="Consultar estado en la DGII"
                className="btn-ghost text-xs whitespace-nowrap">
                {checking === r.id ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Consultar
              </button>
            )}
          </span>
        ) : status === 'rejected' ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-xs text-rose-600 whitespace-nowrap">Rechazado</span>
            <button type="button" onClick={() => transmit(r.id)} disabled={transmitting === r.id}
              title="Reintentar la transmisión a la DGII (mismo e-NCF)"
              className="btn-ghost text-xs whitespace-nowrap">
              {transmitting === r.id ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Reintentar
            </button>
          </span>
        ) : !isEcf ? (
          <span className="text-xs text-ink-400">—</span>
        ) : (
          <span className="inline-flex items-center gap-2">
            <button type="button" onClick={() => generateXml(p)} disabled={generating === r.id}
              title="Firmar y descargar el XML (sin transmitir) — habilita el QR en la factura"
              className="btn-ghost text-xs whitespace-nowrap">
              {generating === r.id ? <Loader2 size={12} className="animate-spin" /> : <FileDown size={12} />} Generar XML
            </button>
            <button type="button" onClick={() => transmit(r.id)} disabled={transmitting === r.id}
              className="btn-ghost text-xs whitespace-nowrap">
              {transmitting === r.id ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Transmitir
            </button>
          </span>
        )}
        <button type="button" onClick={() => printInvoice(r.id)} disabled={printing === r.id}
          title="Imprimir factura" className="btn-ghost text-xs whitespace-nowrap">
          {printing === r.id ? <Loader2 size={13} className="animate-spin" /> : <Printer size={13} />} Imprimir
        </button>
        {(status === 'sent' || status === 'accepted') && !r.creditNote ? (
          <button type="button" onClick={() => {
            // Once a sale has any nota, a full anulación is refused — open straight
            // into a partial correction for the remaining balance.
            const prior = postingsQ.data.some((x) => x.modifiesPostingId === p.id && /^E34/.test(x.ncf || ''));
            setCreditNote({ posting: p, kind: prior ? 'partial' : 'full', amount: '' });
          }}
            title="Emitir nota de crédito" className="btn-ghost text-xs whitespace-nowrap">
            <FileMinus size={12} /> N. crédito
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <AccountingGate title="Facturación">
      <PageHeader title="Facturación" subtitle="Comprobantes fiscales electrónicos · 607 · cobros"
        actions={
          <>
            {loaded && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-ink-200 bg-surface px-3 py-1.5 text-xs shadow-xs"
                title={readExchangeRate(settings).updatedAt ? `Banco Popular · venta · actualizada ${formatDate(readExchangeRate(settings).updatedAt)}` : 'Banco Popular · venta'}>
                <span className="text-ink-400">USD→DOP</span>
                <span className="font-medium tabular-nums text-ink-800">{effectiveDopRate(settings).toFixed(2)}</span>
              </span>
            )}
            {loaded && (
              <Link to="/accounting/impuestos"
                className="inline-flex items-center gap-1.5 rounded-full border border-ink-200 bg-surface px-3 py-1.5 text-xs shadow-xs hover:border-ink-300"
                title="Liquidación de ITBIS — IT-1 (resumen DGII)">
                <span className="text-ink-400">IT-1</span>
                <span className="font-medium tabular-nums text-ink-800">{formatDop(itbis.aPagar > 0 ? itbis.aPagar : itbis.aFavor)}</span>
              </Link>
            )}
            <Link to="/accounting/facturacion/nueva" className="btn-primary"><FileText size={15} /> Nueva factura</Link>
          </>
        } />

      {loaded && (
        <ActionChips actions={facturaActions} onSelect={(a) => {
          // Two cockpit actions resolve on THIS page — handle them in place
          // (switch tab) instead of a no-op navigation back to /facturacion.
          if (a.kind === 'ecf') { setTab('ecf'); return true; }
          if (a.kind === 'invoice') { setTab('porfacturar'); return true; }
          return false;
        }} />
      )}
      {loaded && (
        <KpiBand items={[
          { label: `Facturado · ${monthLabel}`, value: formatDop(sales607.totals.total) },
          { label: `Cobrado · ${monthLabel}`, value: formatDop(cobradoMes), tone: 'pos' },
          { label: 'Por cobrar', value: formatDop(pipelineReceivables.totals.balance),
            tone: pipelineReceivables.totals.d90 > 0 ? 'neg' : undefined,
            hint: pipelineReceivables.totals.d90 > 0 ? `${formatDop(pipelineReceivables.totals.d90)} vencido +90 d` : undefined },
          { label: itbis.aPagar > 0 ? 'ITBIS a pagar' : 'ITBIS a favor', value: formatDop(itbis.aPagar > 0 ? itbis.aPagar : itbis.aFavor) },
        ]} />
      )}

      <TabPills tabs={[
        { key: 'todas', label: `Todas${(register.counts.todas + deliverables.length) ? ` (${register.counts.todas + deliverables.length})` : ''}` },
        { key: 'cobrar', label: `Por cobrar${register.counts.cobrar ? ` (${register.counts.cobrar})` : ''}` },
        { key: 'pagadas', label: `Pagadas${register.counts.pagadas ? ` (${register.counts.pagadas})` : ''}` },
        { key: 'ecf', label: `e-CF pendientes${register.counts.ecf ? ` (${register.counts.ecf})` : ''}` },
        { key: 'porfacturar', label: `Por facturar${deliverables.length ? ` (${deliverables.length})` : ''}` },
        { key: 'anuladas', label: `Anuladas${register.counts.anuladas ? ` (${register.counts.anuladas})` : ''}` },
      ]} active={tab} onChange={setTab} />
      {err && <p className={`text-sm mb-3 ${err.startsWith('✓') ? 'text-emerald-700' : 'text-rose-600'}`}>{err}</p>}

      {!loaded ? <ListLoading /> : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="relative w-full sm:w-auto">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-300" />
              <input ref={searchRef} value={q607} onChange={(e) => setQ607(e.target.value)}
                placeholder="Buscar cliente, RNC, NCF…   /" className="input py-1.5 pl-8 text-sm w-full sm:w-56" />
            </div>
            <div className="flex flex-wrap gap-2 sm:ml-auto">
              {pendingEcfCount > 0 ? (
                <button type="button" onClick={transmitAllPending} disabled={!!bulk}
                  className="btn-primary disabled:opacity-60" title="Firmar y transmitir todos los e-CF pendientes a la DGII">
                  {bulk?.kind === 'tx' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  {bulk?.kind === 'tx' ? `Transmitiendo ${bulk.done}/${bulk.total}…` : `Transmitir todos (${pendingEcfCount})`}
                </button>
              ) : null}
              {sentEcfCount > 0 ? (
                <button type="button" onClick={checkAllSent} disabled={!!bulk}
                  className="btn-ghost disabled:opacity-60" title="Consultar en la DGII el estado de todos los e-CF transmitidos">
                  {bulk?.kind === 'check' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  {bulk?.kind === 'check' ? `Consultando ${bulk.done}/${bulk.total}…` : `Consultar todos (${sentEcfCount})`}
                </button>
              ) : null}
              <button type="button" onClick={export607} disabled={sales607.count === 0}
                className="btn-ghost"><Download size={14} /> Exportar 607 (CSV)</button>
              <button type="button" onClick={export607Txt} disabled={sales607.count === 0}
                className="btn-ghost"><Download size={14} /> TXT DGII (607)</button>
            </div>
          </div>
          {registerView.count === 0 ? (
            <EmptyState icon={FileText} title={q607 ? 'Sin coincidencias' : 'Sin facturas'}
              description={q607 ? 'Ninguna factura coincide con la búsqueda.' : 'Las facturas emitidas aparecen aquí. Crea una con “Nueva factura”, o factura una entrega desde “Por facturar”.'} />
          ) : (
            <>
            <RowCards
              rows={registerView.rows.map((r) => ({
                key: r.id,
                title: r.name || '—',
                right: r.creditNote ? formatDop(-r.total) : formatDop(r.total),
                sub: <span className="tabular-nums">{r.rnc ? `${r.rnc} · ` : ''}{r.ncf || '—'}{r.creditNote && r.modifiesNcf ? ` ↩ ${r.modifiesNcf}` : ''}</span>,
                kv: [
                  ['Fecha', formatDate(r.date)],
                  ['Estado', (STATUS_PILL[r.status] || STATUS_PILL.open)[0]],
                  ['Base', formatDop(r.creditNote ? -r.base : r.base)],
                  ['Balance', r.open > 0.01 ? formatDop(r.open) : '—'],
                ],
                onClick: () => r.kind === 'porfacturar' ? setFacturarQuote(r.quote) : setDrawerRow(r),
              }))}
              footer={[
                ['Facturas', registerView.count],
                ['Base', formatDop(registerView.totals.base)],
                ['ITBIS', formatDop(registerView.totals.itbis)],
                ['Total', formatDop(registerView.totals.total)],
                ['Balance', formatDop(registerView.totals.open)],
              ]}
            />
            <div className="hidden md:block">
              <div className="flex justify-end mb-2">
                <ColumnsMenu columns={SALES607_COLUMNS} visible={visible607} onChange={setVisible607} onReset={() => { reset607(); resetWidths607(); }} />
              </div>
              <div className="card overflow-hidden">
                <div className="overflow-x-auto">
                  <table ref={tableRef607} style={tableStyle607} className="table">
                    <thead>
                      <tr>
                        {cols607.map((col) => (
                          <th key={col.key} className={col.thClass || ''} {...thProps607(col.key)}>
                            {col.label}
                            {ResizeHandle607(col.key)}
                          </th>
                        ))}
                        <th className="whitespace-nowrap">e-CF</th>
                      </tr>
                    </thead>
                    <tbody>
                      {registerView.rows.map((r, i) => {
                        const ctx = { r };
                        const pf = r.kind === 'porfacturar';
                        const focused = i === focusIdx;
                        return (
                          <tr key={r.id} ref={focused ? focusedRowRef : null}
                            className={`cursor-pointer ${focused ? 'bg-brand-50' : ''}`}
                            onMouseEnter={() => setFocusIdx(i)}
                            onClick={() => pf ? setFacturarQuote(r.quote) : setDrawerRow(r)}>
                            {cols607.map((col) => (
                              <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                            ))}
                            <td onClick={(e) => e.stopPropagation()}>
                              {pf
                                ? <button type="button" onClick={() => setFacturarQuote(r.quote)} className="btn-primary text-xs whitespace-nowrap"><Check size={13} /> Facturar</button>
                                : ecfActions(r)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      {(() => {
                        // The label cell ("N ventas") spans every leading column
                        // up to the first visible total column; each total column
                        // then renders its own `foot`, and the fixed e-CF column
                        // closes with an empty cell.
                        const footCtx = { totals: registerView.totals };
                        const labelSpan = cols607.findIndex((c) => c.foot);
                        const leadSpan = labelSpan === -1 ? cols607.length : labelSpan;
                        const totalCols = labelSpan === -1 ? [] : cols607.slice(labelSpan);
                        return (
                          <tr className="border-t border-ink-200 font-semibold">
                            <td className="whitespace-nowrap" colSpan={leadSpan}>{registerView.count} facturas</td>
                            {totalCols.map((col) => (
                              <td key={col.key} className={col.foot ? (col.tdClass || '') : ''}>
                                {col.foot ? col.foot(footCtx) : null}
                              </td>
                            ))}
                            <td></td>
                          </tr>
                        );
                      })()}
                    </tfoot>
                  </table>
                </div>
              </div>
            </div>
            <div className="hidden md:flex items-center gap-x-4 gap-y-1 flex-wrap mt-2 px-1 text-[11px] text-ink-400">
              <span><kbd className="kbd">J</kbd> <kbd className="kbd">K</kbd> navegar</span>
              <span><kbd className="kbd">↵</kbd> abrir</span>
              <span><kbd className="kbd">/</kbd> buscar</span>
              <span><kbd className="kbd">N</kbd> nueva factura</span>
              <span><kbd className="kbd">Esc</kbd> cerrar</span>
            </div>
            </>
          )}
        </>
      )}
      {facturarQuote && (() => {
        const q = facturarQuote;
        const book = bookFor(q);
        const customer = q.customerId ? customersById.get(q.customerId) : null;
        const draft = drafts[q.id] || {};
        const stocked = (linesByQuote.get(q.id) || []).filter((l) => l.inventoryItemId);
        return (
          <Modal open onClose={() => { if (posting !== q.id) { setErr(''); setFacturarQuote(null); } }}
            title={`Facturar — ${customer?.name || 'Cliente'}`} size="md" footer={
            <>
              <button onClick={() => { setErr(''); setFacturarQuote(null); }} disabled={posting === q.id} className="btn-ghost">Cancelar</button>
              <button onClick={() => postSale(q)} disabled={posting === q.id} className="btn-primary disabled:opacity-40 inline-flex items-center gap-1.5">
                {posting === q.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Facturar
              </button>
            </>
          }>
            <div className="mb-3">
              <div className="font-display text-xl font-semibold tabular-nums text-ink-900">{formatDop(book.total)} <span className="text-sm text-ink-400 font-normal">({formatMoney(book.usdTotal, 'USD')})</span></div>
              <div className="text-xs text-ink-500 mt-1 tabular-nums">Base {formatDop(book.base)} · ITBIS {formatDop(book.itbis)}{book.deposit > 0 && <> · Depósito aplicado {formatDop(Math.min(book.deposit, book.total))}</>}</div>
              <div className="text-xs text-ink-400 mt-0.5">{q.deliveredAt ? `Entregado ${formatDate(q.deliveredAt)}` : `Depósito ${formatDate(q.depositReceivedAt)}`} · cotización #{q.number ?? '—'}</div>
            </div>
            <div className="space-y-2">
              <div className="flex gap-1">
                <input value={draft.rnc ?? (customer?.rnc || '')} placeholder="RNC / Cédula"
                  onChange={(e) => setDraft(q.id, { rnc: e.target.value })} className="input flex-1" />
                <button type="button" onClick={() => lookupFor(q)} disabled={lookingId === q.id || !cleanRnc(draft.rnc ?? customer?.rnc)}
                  className="btn-icon shrink-0" title="Buscar nombre en el registro DGII" aria-label="Buscar nombre en el registro DGII">
                  {lookingId === q.id ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                </button>
              </div>
              <input value={draft.ncf || ''} placeholder="NCF (auto si hay secuencia)"
                onChange={(e) => setDraft(q.id, { ncf: e.target.value })} className="input w-full" />
              {draft.msg && <p className="text-xs text-ink-500 break-words">{draft.msg}</p>}
              {stocked.length > 0 && (
                <Link to={`/inventario/existencias?item=${stocked[0].inventoryItemId}&qty=${Number(stocked[0].qty) || 1}`} className="btn-ghost text-xs">
                  <Boxes size={12} aria-hidden /> Salida de inventario{stocked.length > 1 ? ` (${stocked.length} artículos)` : ''}
                </Link>
              )}
              {err && <p className="text-sm text-rose-600">{err}</p>}
            </div>
          </Modal>
        );
      })()}
      {drawerRow && (() => {
        const p = postingById.get(drawerRow.id);
        const customer = p?.customerId ? customersById.get(p.customerId) : null;
        const pmts = paymentsQ.data.filter((pay) => (pay.allocations || []).some((a) => a.docId === drawerRow.id));
        const quote = p?.quoteId ? quotesById.get(p.quoteId) : null;
        const invLines = quote ? invoiceLinesForQuote(quote, linesByQuote.get(quote.id) || []) : null;
        return (
          <InvoiceDrawer
            row={drawerRow} posting={p} customer={customer} payments={pmts}
            itbisRate={config.itbisRate}
            invLines={invLines} invCurrency={quote?.currencyCode || 'USD'} invRates={quote ? displayRatesFor(quote, settings) : undefined}
            fiscalActions={ecfActions(drawerRow)}
            fiscalMsg={err}
            onCollect={(args) => collectInvoice(p, args)}
            onVoid={(reason) => voidInvoice(p, reason)}
            onClose={() => setDrawerRow(null)}
          />
        );
      })()}
      {printDoc && (
        <PrintPdfModal blob={printDoc.blob} title={printDoc.title} onClose={() => setPrintDoc(null)} />
      )}
      {creditNote && (() => {
        const sale = creditNote.posting;
        const prior = postingsQ.data
          .filter((x) => x.modifiesPostingId === sale.id && /^E34/.test(x.ncf || ''))
          .reduce((s, x) => s + (Number(x.base) || 0), 0);
        const remainingBase = Math.max(0, (sale.base || 0) - prior);
        return (
          <Modal open onClose={() => { if (!issuingNc) { setErr(''); setCreditNote(null); } }} title="Nota de crédito" size="sm" footer={
            <>
              <button onClick={() => { setErr(''); setCreditNote(null); }} disabled={issuingNc} className="btn-ghost">Cancelar</button>
              <button onClick={issueCreditNote} disabled={issuingNc} className="btn-primary disabled:opacity-40 inline-flex items-center gap-1.5">
                {issuingNc ? <Loader2 size={14} className="animate-spin" /> : <FileMinus size={14} />} Emitir nota
              </button>
            </>
          }>
            <p className="text-sm text-ink-600">
              Acredita la venta <span className="font-medium tabular-nums">{sale.ncf}</span> por <span className="tabular-nums">{formatDop(sale.total)}</span>.
              {prior > 0 ? <> Ya acreditada <span className="tabular-nums">{formatDop(prior)}</span> de base; saldo <span className="tabular-nums">{formatDop(remainingBase)}</span>.</> : null}
            </p>
            <div className="mt-4 space-y-2.5">
              <label className={`flex items-start gap-2.5 ${prior > 0 ? 'opacity-40' : 'cursor-pointer'}`}>
                <input type="radio" name="nc-kind" className="mt-1" disabled={prior > 0} checked={creditNote.kind === 'full'}
                  onChange={() => setCreditNote({ ...creditNote, kind: 'full' })} />
                <span className="text-sm text-ink-700"><span className="font-medium">Anulación total</span> — acredita toda la venta y restaura el depósito aplicado.</span>
              </label>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="radio" name="nc-kind" className="mt-1" checked={creditNote.kind === 'partial'}
                  onChange={() => setCreditNote({ ...creditNote, kind: 'partial' })} />
                <span className="text-sm text-ink-700"><span className="font-medium">Corrección de monto</span> — acredita un monto parcial (base, sin ITBIS).</span>
              </label>
            </div>
            {creditNote.kind === 'partial' ? (
              <div className="mt-3">
                <div className="label">Monto a acreditar (base, sin ITBIS)</div>
                <input type="number" min="0" step="0.01" className="input" value={creditNote.amount}
                  onChange={(e) => setCreditNote({ ...creditNote, amount: e.target.value })}
                  placeholder={remainingBase.toFixed(2)} autoFocus />
                <p className="mt-1.5 text-xs text-ink-400">El ITBIS ({config.itbisRate}%) se calcula automáticamente.</p>
              </div>
            ) : null}
            {err ? <p className="mt-3 text-sm text-rose-600">{err}</p> : null}
          </Modal>
        );
      })()}
    </AccountingGate>
  );
}
