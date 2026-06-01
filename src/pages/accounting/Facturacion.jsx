import { useMemo, useState } from 'react';
import { Shield, FileText, Loader2, Check, Download, Search } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDop, formatDate, formatMoney } from '../../lib/format.js';
import { displayRatesFor } from '../../lib/exchangeRate.js';
import { computeTotals, lineForTotals } from '../../lib/pricing.js';
import { isPricedLine, QUOTE_STATUS_ACCEPTED } from '../../lib/constants.js';
import { downloadCsv } from '../../lib/csv.js';
import {
  resolveSales607, resolveItbisLiquidation, buildSaleEntry,
  resolveAccountingConfig, round2,
} from '../../core/accounting/index.js';
import { lookupRnc, cleanRnc } from '../../lib/rncLookup.js';

function ymd(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
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

  // USD totals + DOP conversion for a quote.
  function bookFor(quote) {
    const rows = (linesByQuote.get(quote.id) || []).filter(isPricedLine).map(lineForTotals);
    const t = computeTotals(rows, quote);
    const rate = displayRatesFor(quote, settings)?.DOP || 0;
    return {
      rate,
      usdTotal: t.grandTotal,
      base: round2(t.taxableBase * rate),
      itbis: round2(t.taxAmt * rate),
      total: round2(t.grandTotal * rate),
      deposit: round2((quote.depositAmount || 0) * rate),
    };
  }

  const deliverables = useMemo(() => {
    if (!loaded) return [];
    return quotesQ.data
      .filter((q) => q.status === QUOTE_STATUS_ACCEPTED && q.deliveredAt && !postedQuoteIds.has(q.id))
      .sort((a, b) => (a.deliveredAt || 0) - (b.deliveredAt || 0));
  }, [quotesQ.data, postedQuoteIds, loaded]);

  const today = useMemo(() => new Date(), []);
  const [tab, setTab] = useState('pending'); // 'pending' | '607' | 'it1'
  const win = useMemo(() => ({
    start: new Date(today.getFullYear(), today.getMonth(), 1).getTime(),
    end: today.getTime(),
  }), [today]);

  const sales607 = useMemo(() => resolveSales607({ salesPostings: postingsQ.data, customersById, ...win }),
    [postingsQ.data, customersById, win]);
  const itbis = useMemo(() => resolveItbisLiquidation({ salesPostings: postingsQ.data, expenses: expensesQ.data, ...win }),
    [postingsQ.data, expensesQ.data, win]);

  const [drafts, setDrafts] = useState({}); // quoteId -> { ncf, ncfType, rnc, msg }
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
    if (!book.rate) { setErr('La cotización no tiene tasa USD→DOP fijada.'); return; }
    setPosting(quote.id);
    try {
      const id = newId();
      const postedAt = quote.deliveredAt || Date.now();
      const customer = quote.customerId ? customersById.get(quote.customerId) : null;
      const rnc = cleanRnc(draft.rnc ?? customer?.rnc ?? '');
      const built = buildSaleEntry({
        newId, config, postedAt,
        sale: {
          id, quoteId: quote.id, customerId: quote.customerId,
          base: book.base, itbis: book.itbis, deposit: book.deposit,
          ncf: draft.ncf || null, memo: `Venta #${quote.number ?? ''}`.trim(),
        },
      });
      await assignSequenceNumber({
        table: 'journalEntries', profileId: scope, start: 1,
        build: (n) => ({ ...built.entry, number: n }),
      });
      await db.journalLines.bulkPut(built.lines);
      await assignSequenceNumber({
        table: 'salesPostings', profileId: scope, start: 1,
        build: (n) => ({
          id, profileId: scope, number: n, quoteId: quote.id, customerId: quote.customerId,
          postedAt, ncf: draft.ncf || '', ncfType: draft.ncfType || '', rnc,
          base: book.base, itbis: book.itbis, total: book.total,
          depositApplied: Math.min(book.deposit, book.total), rate: book.rate, usdTotal: book.usdTotal,
          journalEntryId: built.entry.id,
        }),
      });
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
      className={`text-sm px-3 py-1.5 rounded-lg ${tab === key ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600'}`}>{label}</button>
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
            description="Las cotizaciones aceptadas y entregadas aparecen aquí para facturarse." />
        ) : (
          <div className="space-y-3">
            {deliverables.map((q) => {
              const book = bookFor(q);
              const customer = q.customerId ? customersById.get(q.customerId) : null;
              const draft = drafts[q.id] || {};
              return (
                <div key={q.id} className="card p-4">
                  <div className="flex flex-wrap items-center gap-3 mb-2">
                    <span className="text-xs text-ink-400 tabular-nums">#{q.number ?? '—'}</span>
                    <span className="font-medium">{customer?.name || 'Cliente'}</span>
                    <span className="text-sm text-ink-500">Entregado {formatDate(q.deliveredAt)}</span>
                    <span className="ml-auto text-sm tabular-nums">{formatDop(book.total)} <span className="text-ink-400">({formatMoney(book.usdTotal, 'USD')})</span></span>
                  </div>
                  <div className="text-xs text-ink-500 mb-3 tabular-nums">
                    Base {formatDop(book.base)} · ITBIS {formatDop(book.itbis)}
                    {book.deposit > 0 && <> · Depósito aplicado {formatDop(Math.min(book.deposit, book.total))}</>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex gap-1">
                      <input value={draft.rnc ?? (customer?.rnc || '')} placeholder="RNC / Cédula"
                        onChange={(e) => setDraft(q.id, { rnc: e.target.value })}
                        className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm w-36" />
                      <button type="button" onClick={() => lookupFor(q)}
                        disabled={lookingId === q.id || !cleanRnc(draft.rnc ?? customer?.rnc)}
                        className="btn-ghost text-sm inline-flex items-center px-2.5 disabled:opacity-40" title="Buscar nombre en el registro DGII">
                        {lookingId === q.id ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                      </button>
                    </div>
                    <input value={draft.ncf || ''} placeholder="NCF / e-NCF"
                      onChange={(e) => setDraft(q.id, { ncf: e.target.value })}
                      className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm w-44" />
                    <button type="button" onClick={() => postSale(q)} disabled={posting === q.id}
                      className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
                      {posting === q.id ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Facturar
                    </button>
                    {draft.msg && <span className="text-xs text-ink-500">{draft.msg}</span>}
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
              className="btn-ghost text-sm inline-flex items-center gap-1.5 disabled:opacity-40"><Download size={14} /> Exportar 607 (CSV)</button>
          </div>
          {sales607.count === 0 ? (
            <EmptyState icon={FileText} title="Sin ventas en el mes"
              description="Las ventas facturadas del mes aparecen aquí." />
          ) : (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left py-2 px-3">RNC/Cédula</th>
                    <th className="text-left py-2 px-3">Cliente</th>
                    <th className="text-left py-2 px-3">NCF</th>
                    <th className="text-left py-2 px-3">Fecha</th>
                    <th className="text-right py-2 px-3">Base</th>
                    <th className="text-right py-2 px-3">ITBIS</th>
                    <th className="text-right py-2 px-3">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {sales607.rows.map((r) => (
                    <tr key={r.id} className="border-t border-ink-50">
                      <td className="py-1.5 px-3 tabular-nums">{r.rnc || '—'}</td>
                      <td className="py-1.5 px-3">{r.name || '—'}</td>
                      <td className="py-1.5 px-3 tabular-nums text-ink-500">{r.ncf || '—'}</td>
                      <td className="py-1.5 px-3 text-ink-500">{formatDate(r.date)}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums">{formatDop(r.base)}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums">{formatDop(r.itbis)}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-medium">{formatDop(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-ink-200 font-semibold">
                    <td className="py-2 px-3" colSpan={4}>{sales607.count} ventas</td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatDop(sales607.totals.base)}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatDop(sales607.totals.itbis)}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatDop(sales607.totals.total)}</td>
                  </tr>
                </tfoot>
              </table>
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
    </>
  );
}
