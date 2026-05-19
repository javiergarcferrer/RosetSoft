import { useMemo, useState } from 'react';
import {
  Shield, Wallet, FileCheck, Users as UsersIcon, Download, Search,
  Loader2, AlertCircle, Calendar,
} from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import StatCard from '../../components/StatCard.jsx';
import { formatDate, formatMoney } from '../../lib/format.js';
import {
  computeTotals, applyLineAdjustments, lineForTotals, isCompoundLine,
} from '../../lib/pricing.js';
import { downloadCsv } from '../../lib/csv.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { isPricedLine, QUOTE_STATUS_ACCEPTED } from '../../lib/constants.js';
import {
  cycleEnding, isoDate, parseISODate, formatCycle, clampPct,
} from '../../lib/commissionCycle.js';

/**
 * Contabilidad — single-pane accounting workspace.
 *
 * Replaces the earlier four-page split (Resumen / Aceptadas /
 * Comisiones / Odoo). An accountant needs to see every accepted
 * cotización of the cycle as a table with all the fields that drive
 * their work — quote number, customer, vendedor, base imponible,
 * ITBIS, grand total, deposit status, commission owed — and trigger
 * their three exports from the same screen. Splitting that across
 * four tabs forced them to jump back and forth; this is one scroll.
 *
 * Sections, top to bottom:
 *   1. Header with the three Odoo CSV export buttons (clientes,
 *      facturas, comisiones-del-ciclo).
 *   2. Cycle picker (ciclo actual / anterior / personalizado).
 *   3. KPI strip — total facturado, comisiones por pagar, count of
 *      vendedores who earned in the cycle.
 *   4. Main table — every accepted quote whose acceptedAt OR
 *      depositReceivedAt falls inside the cycle window. Columns are
 *      ordered the way an accountant reads them: identity →
 *      attribution → money → status → action (PDF).
 *   5. Per-vendedor commission rollup. Compact table that aggregates
 *      the same per-quote commission entries from section 4, so the
 *      accountant sees "pay María RD$X, pay Carlos RD$Y" at a glance.
 *
 * Read-only throughout. The PDF download per row reuses the same
 * `generateQuotePdf` the sales team uses; the CSV exports use the
 * `downloadCsv` helper that produces UTF-8 BOM CSV that Excel and
 * Odoo's standard CSV import both parse correctly.
 */
export default function AccountingWorkspace() {
  const { profileId, profiles, currentProfile, settings } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';

  // Cycle state — same shape as admin/Commissions so the math agrees.
  const [mode, setMode] = useState('current'); // 'current' | 'previous' | 'custom'
  const today = useMemo(() => new Date(), []);
  const cycles = useMemo(() => ({
    curr: cycleEnding(today, 0),
    prev: cycleEnding(today, -1),
  }), [today]);
  const [customStart, setCustomStart] = useState(() => isoDate(cycles.curr.start));
  const [customEnd, setCustomEnd]     = useState(() => isoDate(cycles.curr.end));

  const cycle = useMemo(() => {
    if (mode === 'current')  return cycles.curr;
    if (mode === 'previous') return cycles.prev;
    return {
      start: parseISODate(customStart),
      end:   parseISODate(customEnd, /* endOfDay */ true),
    };
  }, [mode, cycles, customStart, customEnd]);

  // Queries — always run, never short-circuit on the role gate (the
  // hook count would change between renders and React would explode).
  const quotesQ    = useLiveQueryStatus(
    () => db.quotes.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const customersQ = useLiveQueryStatus(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const linesQ     = useLiveQueryStatus(() => db.quoteLines.toArray(), [], []);

  const loaded = quotesQ.loaded && customersQ.loaded && linesQ.loaded;

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

  function totalsFor(q) {
    const rows = (linesByQuote.get(q.id) || [])
      .filter(isPricedLine)
      .map(lineForTotals);
    return computeTotals(rows, q);
  }

  // Cycle-scoped derivation. An entry per accepted quote whose
  // acceptedAt OR depositReceivedAt lands inside the window — wider
  // than the admin Commissions report (which is deposit-only) so the
  // accountant sees every cotización they may have to invoice this
  // cycle, even if the deposit hasn't landed yet.
  const derived = useMemo(() => {
    const entries = [];
    let totalBilled = 0;
    let totalCommission = 0;
    const vendedorRoll = new Map();

    for (const q of quotesQ.data) {
      if (q.status !== QUOTE_STATUS_ACCEPTED) continue;
      const acceptedIn = q.acceptedAt && q.acceptedAt >= cycle.start && q.acceptedAt <= cycle.end;
      const depositIn  = q.depositReceivedAt && q.depositReceivedAt >= cycle.start && q.depositReceivedAt <= cycle.end;
      if (!acceptedIn && !depositIn) continue;

      const customer = q.customerId ? customerById.get(q.customerId) : null;
      const creator  = q.createdByUserId ? profileById.get(q.createdByUserId) : null;
      const t = totalsFor(q);
      const pct = clampPct(creator?.commissionPct);
      // Commission is *earned* only once the deposit has been received
      // (same rule as the admin payout report). Until then we still
      // surface the would-be amount in italic so the accountant knows
      // what's coming, but it doesn't roll into the cycle total.
      const potentialCommission = t.taxableBase * (pct / 100);
      const earnedCommission = depositIn ? potentialCommission : 0;

      entries.push({
        quote: q,
        customer,
        creator,
        base: t.taxableBase,
        // computeTotals exposes the tax amount as `taxAmt` (the
        // generic field name; ITBIS is just the DR-specific label).
        // The previous `t.itbis` read undefined and the column
        // rendered "—" even though base + itbis = grandTotal added
        // up correctly upstream.
        itbis: t.taxAmt,
        grandTotal: t.grandTotal,
        commissionPct: pct,
        potentialCommission,
        earnedCommission,
        acceptedIn,
        depositIn,
      });
      totalBilled += t.grandTotal;
      totalCommission += earnedCommission;

      if (creator && earnedCommission > 0) {
        if (!vendedorRoll.has(creator.id)) {
          vendedorRoll.set(creator.id, { user: creator, pct, count: 0, base: 0, commission: 0 });
        }
        const row = vendedorRoll.get(creator.id);
        row.count += 1;
        row.base += t.taxableBase;
        row.commission += earnedCommission;
      }
    }

    entries.sort((a, b) => (b.quote.acceptedAt || 0) - (a.quote.acceptedAt || 0));
    const vendedorRows = [...vendedorRoll.values()]
      .sort((a, b) => b.commission - a.commission);

    return {
      entries,
      vendedorRows,
      totalBilled,
      totalCommission,
      vendedoresWithCommission: vendedorRows.length,
    };
  }, [quotesQ.data, cycle, customerById, profileById, linesByQuote]);

  // Search filter applied on top of the cycle-scoped entries.
  const [q, setQ] = useState('');
  const filteredEntries = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return derived.entries;
    return derived.entries.filter((e) => {
      const num = String(e.quote.number || '');
      const cust = (e.customer?.company || e.customer?.name || '').toLowerCase();
      const vend = (e.creator?.name || e.creator?.email || '').toLowerCase();
      return num.includes(needle) || cust.includes(needle) || vend.includes(needle);
    });
  }, [derived.entries, q]);

  // Export busy state — one key at a time, three buttons.
  const [exportBusy, setExportBusy] = useState(null);
  function withBusy(key, fn) {
    return async () => {
      if (exportBusy) return;
      setExportBusy(key);
      try { await fn(); } finally { setExportBusy(null); }
    };
  }
  const todayIso = isoDate(Date.now());

  async function exportCustomers() {
    const header = ['name', 'email', 'phone', 'street', 'city', 'vat', 'comment'];
    const rows = [header];
    for (const c of customersQ.data) {
      rows.push([
        c.company || c.name || '',
        c.email || '',
        c.phone || '',
        c.address || '',
        c.city || '',
        c.taxId || '',
        c.notes || '',
      ]);
    }
    downloadCsv(`odoo-clientes-${todayIso}.csv`, rows);
  }

  async function exportInvoices() {
    // Every accepted quote, regardless of cycle — accountants book
    // invoices as they're accepted, and Odoo dedupes on quote_number,
    // so a full export is safe to re-run any time.
    const header = [
      'partner_name', 'invoice_date', 'quote_number', 'product_name',
      'qty', 'price_unit', 'price_subtotal', 'currency', 'status',
    ];
    const rows = [header];
    for (const qu of quotesQ.data) {
      if (qu.status !== QUOTE_STATUS_ACCEPTED) continue;
      const customer = qu.customerId ? customerById.get(qu.customerId) : null;
      const partnerName = customer ? (customer.company || customer.name || '') : '';
      const invoiceDate = qu.acceptedAt ? isoDate(qu.acceptedAt) : '';
      const currency = qu.currencyCode || 'USD';
      const itemLines = (linesByQuote.get(qu.id) || [])
        .filter(isPricedLine)
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      for (const l of itemLines) {
        if (isCompoundLine(l)) {
          // Compound → one CSV row per priced component so Odoo books
          // each as its own invoice line, line-level adjustments
          // applied uniformly.
          const familyName = (l.name || '').trim();
          for (const c of l.components || []) {
            const unit = applyLineAdjustments(c.unitPrice, l.lineMarginPct, l.lineDiscountPct);
            const cqty = Number(c.qty) || 0;
            const subtotal = unit * cqty;
            const componentName = [c.name, c.reference, c.dimensions]
              .map((s) => (s || '').trim()).filter(Boolean).join(' · ');
            const productName = familyName ? `${familyName} — ${componentName}` : componentName;
            rows.push([
              partnerName, invoiceDate, qu.number != null ? String(qu.number) : '',
              productName, cqty, unit.toFixed(2), subtotal.toFixed(2), currency, qu.status,
            ]);
          }
        } else {
          const unit = applyLineAdjustments(l.unitPrice, l.lineMarginPct, l.lineDiscountPct);
          const lqty = Number(l.qty) || 0;
          const subtotal = unit * lqty;
          const productName = [l.name, l.reference, l.dimensions]
            .map((s) => (s || '').trim()).filter(Boolean).join(' · ');
          rows.push([
            partnerName, invoiceDate, qu.number != null ? String(qu.number) : '',
            productName, lqty, unit.toFixed(2), subtotal.toFixed(2), currency, qu.status,
          ]);
        }
      }
    }
    downloadCsv(`odoo-facturas-${todayIso}.csv`, rows);
  }

  async function exportCommissions() {
    const cycleStartIso = isoDate(cycle.start);
    const cycleEndIso   = isoDate(cycle.end);
    const header = [
      'cycle_start', 'cycle_end', 'employee_name', 'employee_email',
      'quote_number', 'customer', 'deposit_date',
      'base_imponible_usd', 'grand_total_usd', 'commission_pct', 'commission_amount_usd',
    ];
    const rows = [header];
    for (const e of derived.entries) {
      // Only deposit-in-cycle entries actually owe commission — same
      // rule as the admin payout report.
      if (!e.depositIn || !e.creator) continue;
      rows.push([
        cycleStartIso, cycleEndIso,
        e.creator.name || '',
        e.creator.email || '',
        e.quote.number != null ? String(e.quote.number) : '',
        e.customer ? (e.customer.company || e.customer.name || '') : '',
        isoDate(e.quote.depositReceivedAt),
        e.base.toFixed(2),
        e.grandTotal.toFixed(2),
        e.commissionPct,
        e.earnedCommission.toFixed(2),
      ]);
    }
    downloadCsv(`comisiones-${cycleStartIso}-a-${cycleEndIso}.csv`, rows);
  }

  if (!allowed) {
    return (
      <>
        <PageHeader title="Contabilidad" subtitle=" " />
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
        title="Contabilidad"
        subtitle={`Ciclo ${formatCycle(cycle)}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <ExportButton
              icon={UsersIcon}
              label="Clientes"
              busy={exportBusy === 'customers'}
              disabled={!loaded || customersQ.data.length === 0}
              onClick={withBusy('customers', exportCustomers)}
            />
            <ExportButton
              icon={FileCheck}
              label="Facturas"
              busy={exportBusy === 'invoices'}
              disabled={!loaded}
              onClick={withBusy('invoices', exportInvoices)}
            />
            <ExportButton
              icon={Wallet}
              label="Comisiones"
              busy={exportBusy === 'commissions'}
              disabled={!loaded}
              onClick={withBusy('commissions', exportCommissions)}
            />
          </div>
        }
      />

      {/* Cycle picker */}
      <div className="card card-pad mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <CyclePill
            label="Ciclo actual"
            sub={formatCycle(cycles.curr)}
            active={mode === 'current'}
            onClick={() => setMode('current')}
          />
          <CyclePill
            label="Ciclo anterior"
            sub={formatCycle(cycles.prev)}
            active={mode === 'previous'}
            onClick={() => setMode('previous')}
          />
          <CyclePill
            label="Personalizado"
            sub={mode === 'custom'
              ? formatCycle({ start: parseISODate(customStart), end: parseISODate(customEnd, true) })
              : 'Rango manual'}
            active={mode === 'custom'}
            onClick={() => setMode('custom')}
          />
        </div>
        {mode === 'custom' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 mt-3 border-t border-ink-100">
            <div>
              <div className="label">Desde</div>
              <input
                type="date"
                className="input"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
              />
            </div>
            <div>
              <div className="label">Hasta</div>
              <input
                type="date"
                className="input"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <StatCard
          tone="brand"
          icon={FileCheck}
          label="Total facturado"
          value={loaded ? formatMoney(derived.totalBilled, 'USD', { USD: 1 }) : '—'}
          hint={loaded
            ? `${derived.entries.length} ${derived.entries.length === 1 ? 'cotización en el ciclo' : 'cotizaciones en el ciclo'}`
            : 'Cargando…'}
        />
        <StatCard
          tone="emerald"
          icon={Wallet}
          label="Comisiones por pagar"
          value={loaded ? formatMoney(derived.totalCommission, 'USD', { USD: 1 }) : '—'}
          hint={loaded
            ? 'Sobre las cotizaciones con depósito recibido'
            : 'Cargando…'}
        />
        <StatCard
          tone="ink"
          icon={UsersIcon}
          label="Vendedores con comisión"
          value={loaded ? String(derived.vendedoresWithCommission) : '—'}
          hint={loaded
            ? (derived.vendedoresWithCommission === 1 ? 'vendedor a pagar' : 'vendedores a pagar')
            : 'Cargando…'}
        />
      </div>

      {/* Search */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-3">
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
            placeholder="Buscar por número, cliente o vendedor…"
          />
        </div>
      </div>

      {/* Main table — every accepted quote in the cycle */}
      <section className="card overflow-hidden mb-6">
        <header className="card-header">
          <h2>Cotizaciones del ciclo</h2>
          <span className="badge">{filteredEntries.length}</span>
        </header>
        {!loaded ? (
          <ListLoading rows={5} />
        ) : filteredEntries.length === 0 ? (
          <EmptyState
            icon={FileCheck}
            title={derived.entries.length === 0
              ? 'Sin cotizaciones aceptadas en este ciclo'
              : 'Sin coincidencias'}
            description={derived.entries.length === 0
              ? 'Cambia el ciclo o espera a que se acepten cotizaciones del periodo.'
              : 'Ajusta la búsqueda o limpia el campo.'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Aceptada</th>
                  <th>Cliente</th>
                  <th>Vendedor</th>
                  <th className="text-right whitespace-nowrap">Base imponible</th>
                  <th className="text-right whitespace-nowrap">ITBIS</th>
                  <th className="text-right whitespace-nowrap">Total</th>
                  <th>Depósito</th>
                  <th className="text-right whitespace-nowrap">Comisión</th>
                  <th className="text-right">PDF</th>
                </tr>
              </thead>
              <tbody>
                {filteredEntries.map((e) => (
                  <EntryRow
                    key={e.quote.id}
                    entry={e}
                    lines={linesByQuote.get(e.quote.id) || []}
                    settings={settings}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Per-vendedor commission rollup — the "who do I pay how much" view */}
      {loaded && derived.vendedorRows.length > 0 && (
        <section className="card overflow-hidden">
          <header className="card-header">
            <h2>Comisiones por vendedor</h2>
            <span className="badge">{derived.vendedorRows.length}</span>
          </header>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Vendedor</th>
                  <th className="text-right whitespace-nowrap"># ventas</th>
                  <th className="text-right whitespace-nowrap">Base imponible</th>
                  <th className="text-right whitespace-nowrap">%</th>
                  <th className="text-right whitespace-nowrap">Comisión</th>
                </tr>
              </thead>
              <tbody>
                {derived.vendedorRows.map((row) => (
                  <tr key={row.user.id}>
                    <td className="font-medium">
                      {row.user.name || row.user.email || '—'}
                      {row.user.email && row.user.name && (
                        <div className="text-[11px] text-ink-500">{row.user.email}</div>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{row.count}</td>
                    <td className="text-right tabular-nums whitespace-nowrap">
                      {formatMoney(row.base, 'USD', { USD: 1 })}
                    </td>
                    <td className="text-right tabular-nums">{row.pct}%</td>
                    <td className="text-right tabular-nums whitespace-nowrap font-medium text-emerald-700">
                      {formatMoney(row.commission, 'USD', { USD: 1 })}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-ink-50">
                  <td colSpan={4} className="text-right text-xs font-semibold uppercase tracking-wide text-ink-600">
                    Total a pagar
                  </td>
                  <td className="text-right tabular-nums whitespace-nowrap font-semibold text-emerald-700">
                    {formatMoney(derived.totalCommission, 'USD', { USD: 1 })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Row + helpers                                                             */
/* -------------------------------------------------------------------------- */

function EntryRow({ entry, lines, settings }) {
  const { quote, customer, creator, base, itbis, grandTotal,
          commissionPct, potentialCommission, earnedCommission, depositIn } = entry;
  const pdf = usePdfDownload({ quote, customer, lines, settings });
  const currency = quote.currencyCode || 'USD';
  const rates = quote.rates || { USD: 1 };
  return (
    <tr>
      <td className="font-medium whitespace-nowrap">#{quote.number || '—'}</td>
      <td className="text-ink-500 whitespace-nowrap">{formatDate(quote.acceptedAt)}</td>
      <td className="text-ink-700 truncate max-w-[220px]" title={customer?.company || customer?.name || ''}>
        {customer?.company || customer?.name || '—'}
      </td>
      <td className="text-ink-700 truncate max-w-[160px]" title={creatorDisplay(creator)}>
        {creatorDisplay(creator) || '—'}
      </td>
      <td className="text-right tabular-nums whitespace-nowrap">{formatMoney(base, currency, rates)}</td>
      <td className="text-right tabular-nums whitespace-nowrap text-ink-500">{formatMoney(itbis, currency, rates)}</td>
      <td className="text-right tabular-nums whitespace-nowrap font-medium">{formatMoney(grandTotal, currency, rates)}</td>
      <td><DepositPill at={quote.depositReceivedAt} /></td>
      <td className="text-right tabular-nums whitespace-nowrap">
        {depositIn ? (
          <span className="font-medium text-emerald-700">
            {formatMoney(earnedCommission, 'USD', { USD: 1 })}
          </span>
        ) : (
          <span className="italic text-ink-400" title="Aún sin depósito — comisión proyectada">
            {formatMoney(potentialCommission, 'USD', { USD: 1 })}
          </span>
        )}
        {commissionPct > 0 && (
          <div className="text-[10px] text-ink-400">{commissionPct}%</div>
        )}
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

function ExportButton({ icon: Icon, label, busy, disabled, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className="btn-ghost text-sm disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {busy
        ? <><Loader2 size={14} className="animate-spin" /> {label}</>
        : <><Download size={14} /> {label}</>}
    </button>
  );
}

function CyclePill({ label, sub, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-md border px-3 py-2 transition ${
        active
          ? 'border-ink-700 bg-ink-700 text-white'
          : 'border-ink-200 hover:border-ink-400 bg-white'
      }`}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Calendar size={12} className={active ? 'text-ink-300' : 'text-ink-500'} />
        {label}
      </div>
      <div className={`text-[10px] mt-0.5 ${active ? 'text-ink-300' : 'text-ink-500'}`}>{sub}</div>
    </button>
  );
}

function DepositPill({ at }) {
  if (at) {
    return <span className="status-pill status-pill-accepted whitespace-nowrap">{formatDate(at)}</span>;
  }
  return <span className="status-pill status-pill-sent whitespace-nowrap">Pendiente</span>;
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

function usePdfDownload({ quote, customer, lines, settings }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function run() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const totals = computeTotals(
        lines.filter(isPricedLine).map(lineForTotals),
        quote,
      );
      // safeDynamicImport recovers from a stale-chunk reference (the
      // user's tab has the previous deploy's index.html cached, the
      // hashed quotePdf-<oldHash>.js no longer exists on the server,
      // and a raw `import()` would reject with the cryptic MIME-type
      // / "failed to fetch dynamically imported module" error). The
      // helper reloads once via sessionStorage so the dealer's
      // second tap succeeds.
      const { generateQuotePdf, downloadBlob } = await safeDynamicImport(
        () => import('../../pdf/quotePdf.js'),
      );
      const blob = await generateQuotePdf({ quote, settings, lines, totals, customer });
      await downloadBlob(blob, `Cotizacion-${quote.number || 'borrador'}.pdf`);
    } catch (err) {
      console.error('[Contabilidad] PDF download failed:', err);
      setError(err?.message || 'No se pudo generar el PDF.');
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function creatorDisplay(creator) {
  if (!creator) return '';
  if (creator.name && creator.name.trim()) return creator.name.trim();
  if (creator.email) return creator.email.split('@')[0];
  return '';
}
