import { useMemo, useState } from 'react';
import {
  Search, FileCheck, Shield, Download, Loader2, AlertCircle,
} from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDate, formatMoney } from '../../lib/format.js';
import { computeTotals, lineForTotals } from '../../lib/pricing.js';

/**
 * Accounting view of every accepted cotización. Read-only: Contabilidad
 * downloads the same PDF the sales team generates so they have the
 * accepted document on file. No edits, no status changes.
 *
 * The deposit pill ("Con depósito" / "Pendiente de depósito") is the
 * column Contabilidad cares about most — it's the trigger for issuing
 * the invoice in Odoo.
 */
export default function AcceptedQuotes() {
  const { profileId, profiles, currentProfile, settings } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';

  const quotesQ = useLiveQueryStatus(
    () => db.quotes.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const customersQ = useLiveQueryStatus(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const linesQ = useLiveQueryStatus(() => db.quoteLines.toArray(), [], []);

  const [q, setQ] = useState('');

  const customerById = useMemo(() => {
    const m = new Map();
    for (const c of customersQ.data) m.set(c.id, c);
    return m;
  }, [customersQ.data]);

  const profileById = useMemo(() => {
    const m = new Map();
    for (const p of profiles) m.set(p.id, p);
    return m;
  }, [profiles]);

  const linesByQuote = useMemo(() => {
    const m = new Map();
    for (const ln of linesQ.data) {
      if (!m.has(ln.quoteId)) m.set(ln.quoteId, []);
      m.get(ln.quoteId).push(ln);
    }
    return m;
  }, [linesQ.data]);

  const totalByQuoteId = useMemo(() => {
    const m = new Map();
    for (const qu of quotesQ.data) {
      const rows = (linesByQuote.get(qu.id) || [])
        .filter((l) => l.kind !== 'section')
        .map(lineForTotals);
      m.set(qu.id, computeTotals(rows, qu).grandTotal);
    }
    return m;
  }, [quotesQ.data, linesByQuote]);

  const accepted = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return quotesQ.data
      .filter((qu) => qu.status === 'accepted')
      .filter((qu) => {
        if (!needle) return true;
        const cust = customerById.get(qu.customerId);
        return (
          (qu.number || '').toString().includes(needle) ||
          (cust?.name || '').toLowerCase().includes(needle) ||
          (cust?.company || '').toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => (b.acceptedAt || 0) - (a.acceptedAt || 0));
  }, [quotesQ.data, customerById, q]);

  const loaded = quotesQ.loaded && customersQ.loaded && linesQ.loaded;

  if (!allowed) {
    return (
      <>
        <PageHeader title="Cotizaciones aceptadas" subtitle=" " />
        <EmptyState
          icon={Shield}
          title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Cotizaciones aceptadas"
        subtitle={loaded
          ? `${accepted.length} ${accepted.length === 1 ? 'cotización aceptada' : 'cotizaciones aceptadas'}`
          : ' '}
      />

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            className="input pl-9"
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por número o cliente…"
          />
        </div>
      </div>

      {!loaded ? (
        <div className="card overflow-hidden"><ListLoading rows={5} /></div>
      ) : accepted.length === 0 ? (
        <EmptyState
          icon={FileCheck}
          title="Sin cotizaciones aceptadas"
          description="Cuando una cotización pase a estado “Aceptada” aparecerá aquí."
        />
      ) : (
        <>
          {/* Mobile: cards */}
          <div className="md:hidden space-y-2">
            {accepted.map((qu) => (
              <AcceptedCard
                key={qu.id}
                qu={qu}
                customer={customerById.get(qu.customerId)}
                creator={profileById.get(qu.createdByUserId)}
                total={totalByQuoteId.get(qu.id) || 0}
                lines={linesByQuote.get(qu.id) || []}
                settings={settings}
              />
            ))}
          </div>

          {/* Desktop: table */}
          <div className="hidden md:block card overflow-hidden">
            <table className="table">
              <thead>
                <tr>
                  <th>Número</th>
                  <th>Cliente</th>
                  <th className="hidden lg:table-cell">Aceptada</th>
                  <th>Depósito</th>
                  <th className="hidden xl:table-cell">Vendedor</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">PDF</th>
                </tr>
              </thead>
              <tbody>
                {accepted.map((qu) => (
                  <AcceptedRow
                    key={qu.id}
                    qu={qu}
                    customer={customerById.get(qu.customerId)}
                    creator={profileById.get(qu.createdByUserId)}
                    total={totalByQuoteId.get(qu.id) || 0}
                    lines={linesByQuote.get(qu.id) || []}
                    settings={settings}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Per-row PDF download. Mirrors QuoteBuilder.exportPdf() exactly: dynamic
// import of the PDF module, build customer/lines/totals from local state,
// then downloadBlob() the result with a Cotizacion-<number>.pdf filename.
//
// Each row owns its own busy + error state so the dealer can fire several
// downloads in parallel without one row's spinner blocking another's.
// ---------------------------------------------------------------------------
function usePdfDownload({ quote, customer, lines, settings }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function run() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const totals = computeTotals(
        lines.filter((l) => l.kind !== 'section').map(lineForTotals),
        quote,
      );
      const { generateQuotePdf, downloadBlob } = await import('../../pdf/quotePdf.js');
      const blob = await generateQuotePdf({ quote, settings, lines, totals, customer });
      await downloadBlob(blob, `Cotizacion-${quote.number || 'borrador'}.pdf`);
    } catch (err) {
      console.error('[AcceptedQuotes] PDF download failed:', err);
      setError(err?.message || 'No se pudo generar el PDF.');
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, run, clearError: () => setError(null) };
}

function PdfButton({ pdf }) {
  return (
    <button
      type="button"
      onClick={pdf.run}
      disabled={pdf.busy}
      className="btn-ghost text-xs disabled:opacity-60 disabled:cursor-wait"
      aria-label="Descargar PDF"
    >
      {pdf.busy
        ? <><Loader2 size={12} className="animate-spin" /> PDF</>
        : <><Download size={12} /> PDF</>}
    </button>
  );
}

function DepositPill({ at }) {
  if (at) {
    return <span className="status-pill status-pill-accepted">Con depósito</span>;
  }
  return <span className="status-pill status-pill-sent">Pendiente de depósito</span>;
}

function AcceptedRow({ qu, customer, creator, total, lines, settings }) {
  const pdf = usePdfDownload({ quote: qu, customer, lines, settings });
  return (
    <tr>
      <td className="font-medium whitespace-nowrap">#{qu.number || '—'}</td>
      <td className="text-ink-700 truncate max-w-[200px]" title={customer?.company || customer?.name || ''}>
        {customer?.company || customer?.name || '—'}
      </td>
      <td className="hidden lg:table-cell text-ink-500 whitespace-nowrap">{formatDate(qu.acceptedAt)}</td>
      <td><DepositPill at={qu.depositReceivedAt} /></td>
      <td className="hidden xl:table-cell text-ink-500 truncate max-w-[140px]">
        {creatorDisplay(creator) || '—'}
      </td>
      <td className="text-right font-medium whitespace-nowrap">
        {formatMoney(total, qu.currencyCode || 'USD', qu.rates || { USD: 1 })}
      </td>
      <td className="text-right w-20">
        <PdfButton pdf={pdf} />
        {pdf.error && (
          <div role="alert" className="text-[10px] text-red-700 mt-1 max-w-[180px] inline-flex items-start gap-1">
            <AlertCircle size={10} className="mt-0.5 flex-shrink-0" />
            <span className="truncate" title={pdf.error}>{pdf.error}</span>
          </div>
        )}
      </td>
    </tr>
  );
}

function AcceptedCard({ qu, customer, creator, total, lines, settings }) {
  const pdf = usePdfDownload({ quote: qu, customer, lines, settings });
  return (
    <div className="card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold">#{qu.number || '—'}</div>
          <div className="text-xs text-ink-500 truncate">
            {customer?.company || customer?.name || 'Sin cliente'}
          </div>
          {creatorDisplay(creator) && (
            <div className="text-[11px] text-ink-500 truncate">
              Vendedor · {creatorDisplay(creator)}
            </div>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-sm font-medium">
            {formatMoney(total, qu.currencyCode || 'USD', qu.rates || { USD: 1 })}
          </div>
          <div className="text-[10px] text-ink-500">{formatDate(qu.acceptedAt)}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2 pt-2 border-t border-ink-100">
        <DepositPill at={qu.depositReceivedAt} />
        <div className="flex-1" />
        <PdfButton pdf={pdf} />
      </div>
      {pdf.error && (
        <div role="alert" className="mt-2 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 flex items-start gap-1">
          <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
          <span className="flex-1">{pdf.error}</span>
          <button type="button" onClick={pdf.clearError} className="underline">Cerrar</button>
        </div>
      )}
    </div>
  );
}

function creatorDisplay(creator) {
  if (!creator) return '';
  if (creator.name && creator.name.trim()) return creator.name.trim();
  if (creator.email) return creator.email.split('@')[0];
  return '';
}
