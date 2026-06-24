import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FileText, Loader2, Check, Download, Search, Send, Printer, RefreshCw, Boxes, FileMinus, FileDown } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, invalidate } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import TabPills from '../../components/accounting/TabPills.jsx';
import RowCards from '../../components/RowCards.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import { formatDop, formatDate, formatMoney } from '../../lib/format.js';
import { displayRatesFor } from '../../lib/exchangeRate.js';
import { readyToInvoice, invoiceReadyAt } from '../../lib/quoteMilestones.js';
import { downloadCsv, downloadText } from '../../lib/csv.js';
import PrintPdfModal from '../../components/PrintPdfModal.jsx';
import Modal from '../../components/Modal.jsx';
import { quoteToSale } from '../../core/bridge/index.js';
import {
  resolveSales607, resolveItbisLiquidation, buildSaleEntry, buildCreditNoteEntry, resolveCreditNoteDraft,
  resolveAccountingConfig, buildEcfPayload, saleEcfType, saleTipoPago, saleDueDate, isValidFiscalId,
  parseENcf, dgii607Txt, dgiiPeriod, dgiiTxtFilename, resolveInvoiceDoc,
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
    key: 'ncf', label: 'NCF',
    thClass: 'whitespace-nowrap', tdClass: 'tabular-nums text-ink-500 whitespace-nowrap',
    cell: ({ r }) => r.creditNote
      ? <span title={`Nota de crédito · modifica ${r.modifiesNcf}`}>{r.ncf} <span className="text-rose-500">↩ {r.modifiesNcf || ''}</span></span>
      : (r.ncf || '—'),
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
];

const SALES607_DEFAULT = {
  name: true, ncf: true, date: true, base: true, itbis: true, total: true,
};
const SALES607_COLS_KEY = 'rs.facturacion.cols.v1';

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
    setBulk({ done, total: pending.length, failed });
    for (const p of pending) {
      const r = await transmitOne(p);
      done += 1;
      if (!r.ok) { failed += 1; if (!firstErr) firstErr = `${p.ncf}: ${r.error}`; }
      setBulk({ done, total: pending.length, failed });
    }
    invalidate();
    setBulk(null);
    setErr(failed
      ? `Transmitidos ${done - failed}/${pending.length}. ${failed} con error — ${firstErr}`
      : `✓ ${pending.length} e-CF transmitidos a la DGII.`);
  }

  // Ask the DGII what became of a transmitted e-CF (trackId → estado). The
  // send is async on their side: 'sent' only means received, not accepted.
  async function checkStatus(rowId) {
    const p = postingById.get(rowId);
    if (!p?.trackId) return;
    setErr('');
    setChecking(rowId);
    try {
      const data = await checkEcfStatus({ trackId: p.trackId, profileId: scope });
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
      setErr(userMessageFor(e));
    } finally {
      setChecking(null);
    }
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
  const [tab, setTab] = useState(['607', 'it1'].includes(params.get('tab')) ? params.get('tab') : 'pending'); // 'pending' | '607' | 'it1'
  const win = useMemo(() => ({
    start: new Date(today.getFullYear(), today.getMonth(), 1).getTime(),
    end: today.getTime(),
  }), [today]);

  const [q607, setQ607] = useState('');
  const sales607 = useMemo(() => resolveSales607({ salesPostings: postingsQ.data, customersById, ...win }),
    [postingsQ.data, customersById, win]);
  // The on-screen 607 honors the search box; the CSV/TXT exports must stay the
  // FULL period (a filtered fiscal file would underreport), so they read
  // `sales607` above.
  const sales607View = useMemo(() => resolveSales607({ salesPostings: postingsQ.data, customersById, query: q607, ...win }),
    [postingsQ.data, customersById, q607, win]);
  const itbis = useMemo(() => resolveItbisLiquidation({
    salesPostings: postingsQ.data, expenses: expensesQ.data,
    purchases: purchasesQ.data, imports: importsQ.data, expedientes: expedientesQ.data, ...win,
  }), [postingsQ.data, expensesQ.data, purchasesQ.data, importsQ.data, expedientesQ.data, win]);

  // e-NCFs assigned but never transmitted — the count the 607 tab badges so
  // signed-but-unsent invoices can't sit invisible.
  const pendingEcfCount = useMemo(
    () => postingsQ.data.filter((p) => p.ecfStatus === 'pending').length,
    [postingsQ.data],
  );

  const [drafts, setDrafts] = useState({}); // quoteId -> { ncf, rnc, msg }
  const [posting, setPosting] = useState(null);
  const [lookingId, setLookingId] = useState(null);
  const [err, setErr] = useState('');

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
  } = useColumnWidths(cols607, 'rs.facturacion.widths.v1');

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
          <span className="text-xs text-rose-600 whitespace-nowrap">Rechazado</span>
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
      <PageHeader title="Facturación" subtitle="Ventas al entregar · 607 · liquidación de ITBIS (IT-1)" />

      <TabPills tabs={[
        { key: 'pending', label: `Por facturar${deliverables.length ? ` (${deliverables.length})` : ''}` },
        { key: '607', label: `607${pendingEcfCount ? ` · ${pendingEcfCount} por transmitir` : ''}` },
        { key: 'it1', label: 'IT-1 (ITBIS)' },
      ]} active={tab} onChange={setTab} />
      {err && <p className={`text-sm mb-3 ${err.startsWith('✓') ? 'text-emerald-700' : 'text-rose-600'}`}>{err}</p>}

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
                    <span className="text-sm tabular-nums whitespace-nowrap sm:ml-auto font-semibold text-ink-900">{formatDop(book.total)} <span className="text-ink-400 font-normal">({formatMoney(book.usdTotal, 'USD')})</span></span>
                  </div>
                  <div className="text-xs text-ink-500 mb-3 tabular-nums break-words">
                    Base {formatDop(book.base)} · ITBIS {formatDop(book.itbis)}
                    {book.deposit > 0 && <> · Depósito aplicado {formatDop(Math.min(book.deposit, book.total))}</>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex gap-1 w-full sm:w-auto">
                      <input value={draft.rnc ?? (customer?.rnc || '')} placeholder="RNC / Cédula"
                        onChange={(e) => setDraft(q.id, { rnc: e.target.value })}
                        className="input flex-1 min-w-0 sm:flex-none sm:w-36" />
                      <button type="button" onClick={() => lookupFor(q)}
                        disabled={lookingId === q.id || !cleanRnc(draft.rnc ?? customer?.rnc)}
                        className="btn-icon shrink-0" title="Buscar nombre en el registro DGII" aria-label="Buscar nombre en el registro DGII">
                        {lookingId === q.id ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                      </button>
                    </div>
                    <input value={draft.ncf || ''} placeholder="NCF (auto si hay secuencia)"
                      onChange={(e) => setDraft(q.id, { ncf: e.target.value })}
                      className="input w-full sm:w-52" />
                    <button type="button" onClick={() => postSale(q)} disabled={posting === q.id}
                      className="btn-primary w-full sm:w-auto justify-center">
                      {posting === q.id ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Facturar
                    </button>
                    {draft.msg && <span className="text-xs text-ink-500 break-words">{draft.msg}</span>}
                  </div>
                  {/* Stock-sourced lines (inventoryItemId stamped at quoting
                      time) → offer the kardex salida prefilled; the sale's
                      stock move stays a human act in Inventario. */}
                  {(() => {
                    const stocked = (linesByQuote.get(q.id) || []).filter((l) => l.inventoryItemId);
                    if (!stocked.length) return null;
                    const first = stocked[0];
                    return (
                      <Link
                        to={`/inventario/existencias?item=${first.inventoryItemId}&qty=${Number(first.qty) || 1}`}
                        className="btn-ghost text-xs mt-2"
                        title="Registrar la salida de almacén de los artículos vendidos de stock"
                      >
                        <Boxes size={12} aria-hidden /> Salida de inventario
                        {stocked.length > 1 ? ` (${stocked.length} artículos)` : ''}
                      </Link>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        )
      ) : tab === '607' ? (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="relative w-full sm:w-auto">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-300" />
              <input value={q607} onChange={(e) => setQ607(e.target.value)}
                placeholder="Buscar cliente, RNC, NCF…" className="input py-1.5 pl-8 text-sm w-full sm:w-56" />
            </div>
            <div className="flex flex-wrap gap-2 sm:ml-auto">
              {pendingEcfCount > 0 ? (
                <button type="button" onClick={transmitAllPending} disabled={!!bulk}
                  className="btn-primary disabled:opacity-60" title="Firmar y transmitir todos los e-CF pendientes a la DGII">
                  {bulk ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  {bulk ? `Transmitiendo ${bulk.done}/${bulk.total}…` : `Transmitir todos (${pendingEcfCount})`}
                </button>
              ) : null}
              <button type="button" onClick={export607} disabled={sales607.count === 0}
                className="btn-ghost"><Download size={14} /> Exportar 607 (CSV)</button>
              <button type="button" onClick={export607Txt} disabled={sales607.count === 0}
                className="btn-ghost"><Download size={14} /> TXT DGII (607)</button>
            </div>
          </div>
          {sales607View.count === 0 ? (
            <EmptyState icon={FileText} title={q607 ? 'Sin coincidencias' : 'Sin ventas en el mes'}
              description={q607 ? 'Ninguna venta del período coincide con la búsqueda.' : 'Las ventas facturadas del mes aparecen aquí.'} />
          ) : (
            <>
            <RowCards
              rows={sales607View.rows.map((r) => ({
                key: r.id,
                title: r.name || '—',
                right: r.creditNote ? formatDop(-r.total) : formatDop(r.total),
                sub: <span className="tabular-nums">{r.rnc ? `${r.rnc} · ` : ''}{r.ncf || '—'}{r.creditNote && r.modifiesNcf ? ` ↩ ${r.modifiesNcf}` : ''}</span>,
                kv: [
                  ['Fecha', formatDate(r.date)],
                  ['Base', formatDop(r.creditNote ? -r.base : r.base)],
                  ['ITBIS', formatDop(r.creditNote ? -r.itbis : r.itbis)],
                ],
                actions: ecfActions(r),
              }))}
              footer={[
                ['Ventas', sales607View.count],
                ['Base', formatDop(sales607View.totals.base)],
                ['ITBIS', formatDop(sales607View.totals.itbis)],
                ['Total', formatDop(sales607View.totals.total)],
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
                      {sales607View.rows.map((r) => {
                        const ctx = { r };
                        return (
                          <tr key={r.id}>
                            {cols607.map((col) => (
                              <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                            ))}
                            <td>{ecfActions(r)}</td>
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
                        const footCtx = { totals: sales607View.totals };
                        const labelSpan = cols607.findIndex((c) => c.foot);
                        const leadSpan = labelSpan === -1 ? cols607.length : labelSpan;
                        const totalCols = labelSpan === -1 ? [] : cols607.slice(labelSpan);
                        return (
                          <tr className="border-t border-ink-200 font-semibold">
                            <td className="whitespace-nowrap" colSpan={leadSpan}>{sales607View.count} ventas</td>
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
            </>
          )}
        </>
      ) : (
        <div className="card p-5 max-w-md">
          <h2 className="eyebrow font-semibold text-ink-600 mb-3">Liquidación de ITBIS — mes actual</h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span>Débito fiscal (ITBIS ventas)</span><span className="tabular-nums">{formatDop(itbis.debitoFiscal)}</span></div>
            <div className="flex justify-between"><span>Crédito fiscal (ITBIS compras)</span><span className="tabular-nums">−{formatDop(itbis.creditoFiscal)}</span></div>
            <div className="flex justify-between text-xs text-ink-500 pl-3"><span>Local (606)</span><span className="tabular-nums">{formatDop(itbis.creditoLocal)}</span></div>
            <div className="flex justify-between text-xs text-ink-500 pl-3"><span>Importación (DUA)</span><span className="tabular-nums">{formatDop(itbis.creditoImportacion)}</span></div>
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
