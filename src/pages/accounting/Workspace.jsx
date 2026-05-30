import { useMemo, useState } from 'react';
import {
  Shield, Wallet, FileCheck, Users as UsersIcon, Download,
  Loader2, Calendar, ChevronDown, Briefcase, Check,
} from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import ListSearchHeader from '../../components/search/ListSearchHeader.jsx';
import { formatDate, formatMoney } from '../../lib/format.js';
import { displayRatesFor } from '../../lib/exchangeRate.js';
import {
  computeTotals, applyLineAdjustments, lineForTotals, isCompoundLine,
} from '../../lib/pricing.js';
import { downloadCsv } from '../../lib/csv.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { isPricedLine, QUOTE_STATUS_ACCEPTED } from '../../lib/constants.js';
import {
  cycleEnding, isoDate, parseISODate, formatCycle, clampPct,
} from '../../lib/commissionCycle.js';
import {
  effectiveCommissionPct, commissionAmount, commissionBreakdown, decoratorBilling,
  commissionOwedAt, reportedCommission,
} from '../../lib/commissions.js';

/**
 * Contabilidad — single-pane accounting workspace, organized around the
 * SALE. The accountant works one cycle at a time and, for each sale, needs
 * two things together: what to key into Odoo, and what commissions the sale
 * owes (and to whom). So every sale is one expandable card holding both —
 * no jumping between a "facturas" view and a separate "comisiones" view.
 *
 * Sections, top to bottom:
 *   1. Header with the Odoo CSV export buttons (clientes, facturas,
 *      comisiones del vendedor, comisiones de profesionales).
 *   2. Cycle picker (ciclo actual / anterior / personalizado).
 *   3. Search / filter header (search + deposit tabs + vendedor + sort).
 *   4. Ventas del ciclo — one expandable card per accepted quote whose
 *      acceptedAt OR depositReceivedAt falls in the window. Collapsed:
 *      #, cliente, vendedor, total, commission status. Expanded: the Odoo
 *      invoice detail (per-product lines + totals + per-quote CSV) followed
 *      by BOTH commissions owed on the sale — vendedor and, if assigned,
 *      profesional (with its invoicing mode: comisión vs trade discount).
 *      Each commission is tickable paid once earned (deposit for the seller;
 *      for the professional, deposit on a floor order / balance on a special).
 *   5–6. Resumen por vendedor / por profesional — the same per-sale numbers
 *      grouped, split paid vs pendiente, so payouts can be batched.
 *
 * Writes: the per-sale "marcar pagada" toggles set sellerCommissionPaidAt /
 * commissionPaidAt on the quote (RLS is single-tenant team-write, so the
 * accounting role is authorized). The per-sale PDF reuses the sales team's
 * `generateQuotePdf`; CSV exports use `downloadCsv` (UTF-8 BOM, Odoo-safe).
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
  const professionalsQ = useLiveQueryStatus(
    () => db.professionals.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );

  const loaded = quotesQ.loaded && customersQ.loaded && linesQ.loaded && professionalsQ.loaded;

  const customerById = useMemo(() => {
    const m = new Map();
    for (const c of customersQ.data) m.set(c.id, c);
    return m;
  }, [customersQ.data]);

  const professionalById = useMemo(() => {
    const m = new Map();
    for (const p of professionalsQ.data) m.set(p.id, p);
    return m;
  }, [professionalsQ.data]);

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

  // Cycle-scoped derivation — ONE entry per accepted quote ("sale") whose
  // acceptedAt OR depositReceivedAt lands inside the window. Each entry
  // carries everything the accountant needs in one place: the figures to
  // book in Odoo AND both commission streams owed on the sale —
  //   • the SELLER (vendedor) cut: their profile commission_pct on the base
  //     imponible, earned once the deposit lands.
  //   • the PROFESSIONAL (decorator/architect) cut: their %, owed per
  //     commissionOwedAt (balance on special orders, deposit on floor sales)
  //     and only when the modality is 'commission' (a 'trade_discount' is
  //     settled through the invoice, no payout).
  // Each cut is marked paid independently (sellerCommissionPaidAt /
  // commissionPaidAt). The two rollups below aggregate the same per-sale
  // numbers so the accountant can batch payouts.
  const derived = useMemo(() => {
    const entries = [];
    const vendedorRoll = new Map();
    const profRoll = new Map();

    for (const q of quotesQ.data) {
      if (q.status !== QUOTE_STATUS_ACCEPTED) continue;
      const acceptedIn = q.acceptedAt && q.acceptedAt >= cycle.start && q.acceptedAt <= cycle.end;
      const depositIn  = q.depositReceivedAt && q.depositReceivedAt >= cycle.start && q.depositReceivedAt <= cycle.end;
      if (!acceptedIn && !depositIn) continue;

      const customer = q.customerId ? customerById.get(q.customerId) : null;
      const creator  = q.createdByUserId ? profileById.get(q.createdByUserId) : null;
      const professional = q.professionalId ? professionalById.get(q.professionalId) : null;
      const t = totalsFor(q);

      // ── Seller (vendedor) commission ──────────────────────────────────
      const pct = clampPct(creator?.commissionPct);
      const potentialCommission = t.taxableBase * (pct / 100);
      // Once PAID, the figure freezes to the amount snapshotted at payout
      // (sellerCommissionPaidAmount) so editing the seller's profile rate
      // later can't restate it; unpaid stays live. `earnedCommission` keeps
      // its cycle gate (deposit-in-window) but now carries the frozen-if-paid
      // value, so the rollup + CSV report what was paid.
      const sellerReported = reportedCommission(
        q.sellerCommissionPaidAt, q.sellerCommissionPaidAmount, potentialCommission,
      );
      const earnedCommission = depositIn ? sellerReported : 0;
      const sellerPayable = Boolean(q.depositReceivedAt);
      const sellerPaid = Boolean(q.sellerCommissionPaidAt);

      // ── Professional (decorator/architect) settlement ─────────────────
      const mode = professional ? decoratorBilling(q) : null;
      const trade = mode === 'trade_discount';
      const proPct = professional ? effectiveCommissionPct(q) : 0;
      const proAmount = professional ? commissionAmount(t, proPct) : 0;
      // Frozen at payout (commissionPaidAmount) so a later order_type toggle /
      // base-rate change can't restate a paid commission; unpaid stays live.
      const proReported = reportedCommission(q.commissionPaidAt, q.commissionPaidAmount, proAmount);
      // Trade discount: bill the DECORATOR at their % off (no commission).
      const decoratorPct = trade ? proPct : 0;
      const tradeDiscount = trade ? proAmount : 0;
      // Commission modality only: owed per commissionOwedAt.
      const proOwedAt = mode === 'commission' ? commissionOwedAt(q) : null;
      const proOwed = proOwedAt != null;
      const proPayable = proOwed;                       // can be ticked paid
      const proPaid = Boolean(q.commissionPaidAt);

      entries.push({
        quote: q,
        customer,
        creator,
        professional,
        mode,
        trade,
        decoratorPct,
        tradeDiscount,
        base: t.taxableBase,
        // computeTotals exposes the tax amount as `taxAmt`; ITBIS is just
        // the DR-specific label for the same figure.
        itbis: t.taxAmt,
        grandTotal: t.grandTotal,
        totals: t,
        acceptedIn,
        depositIn,
        // seller cut
        commissionPct: pct,
        potentialCommission,        // live — passed to the toggle as the snapshot
        sellerReported,             // frozen-if-paid — what we display/report
        earnedCommission,
        sellerPayable,
        sellerPaid,
        // professional cut
        proPct,
        proAmount,                  // live — passed to the toggle as the snapshot
        proReported,                // frozen-if-paid — what we display/report
        proOwedAt,
        proOwed,
        proPayable,
        proPaid,
      });

      if (creator && earnedCommission > 0) {
        if (!vendedorRoll.has(creator.id)) {
          vendedorRoll.set(creator.id, {
            user: creator, pct, count: 0, base: 0, commission: 0, paid: 0, pending: 0,
          });
        }
        const row = vendedorRoll.get(creator.id);
        row.count += 1;
        row.base += t.taxableBase;
        row.commission += earnedCommission;
        if (sellerPaid) row.paid += earnedCommission; else row.pending += earnedCommission;
      }

      if (professional && mode === 'commission' && proOwed) {
        if (!profRoll.has(professional.id)) {
          profRoll.set(professional.id, {
            professional, count: 0, commission: 0, paid: 0, pending: 0,
          });
        }
        const row = profRoll.get(professional.id);
        row.count += 1;
        row.commission += proReported;
        if (proPaid) row.paid += proReported; else row.pending += proReported;
      }
    }

    entries.sort((a, b) => (b.quote.acceptedAt || 0) - (a.quote.acceptedAt || 0));
    const vendedorRows = [...vendedorRoll.values()].sort((a, b) => b.pending - a.pending);
    const profRows = [...profRoll.values()].sort((a, b) => b.pending - a.pending);

    return { entries, vendedorRows, profRows };
  }, [quotesQ.data, cycle, customerById, profileById, professionalById, linesByQuote]);

  // Mark / unmark a commission as paid (seller or professional, per quote).
  // These are the only writes Contabilidad makes — RLS is single-tenant
  // "team can write", so the accounting role is authorized. The live query
  // refreshes the derived numbers; `savingPaid` (keyed `seller:<id>` /
  // `pro:<id>`) just disables the control mid-write.
  const [savingPaid, setSavingPaid] = useState(null);
  async function setPaid(key, quoteId, patch) {
    setSavingPaid(key);
    try {
      await db.quotes.update(quoteId, patch);
    } finally {
      setSavingPaid((cur) => (cur === key ? null : cur));
    }
  }
  // Marking paid also SNAPSHOTS the amount (the live figure at click time) so
  // it can't be restated later by a rate/order-type change; unmarking clears
  // both the timestamp and the snapshot.
  const setSellerPaid = (quoteId, paid, amount) =>
    setPaid(`seller:${quoteId}`, quoteId, {
      sellerCommissionPaidAt: paid ? Date.now() : null,
      sellerCommissionPaidAmount: paid ? amount : null,
    });
  const setProPaid = (quoteId, paid, amount) =>
    setPaid(`pro:${quoteId}`, quoteId, {
      commissionPaidAt: paid ? Date.now() : null,
      commissionPaidAmount: paid ? amount : null,
    });

  // Search-header query state, applied on top of the cycle-scoped entries.
  // The cycle picker above stays the page's PRIMARY window; the deposit
  // tab is an additive dimension within it. Secondary `filters` hold
  // {creator: <profileId>}; sort defaults to acceptedAt-desc.
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all'); // 'all' | 'recibido' | 'pendiente'
  const [filters, setFilters] = useState({}); // { creator: <profileId> }
  const [sort, setSort] = useState({ key: 'accepted', dir: 'desc' });

  // Deposit tabs — a Recibido / Pendiente dimension off depositReceivedAt,
  // counted across the whole cycle's entries (independent of the search
  // needle / vendedor filter, so each tab reads "how many would I see").
  const tabs = useMemo(() => {
    let recibido = 0;
    for (const e of derived.entries) {
      if (e.quote.depositReceivedAt) recibido += 1;
    }
    return [
      { key: 'all', label: 'Todas', count: derived.entries.length },
      { key: 'recibido', label: 'Recibido', count: recibido },
      { key: 'pendiente', label: 'Pendiente', count: derived.entries.length - recibido },
    ];
  }, [derived.entries]);

  // Secondary filter: vendedor (the quote's creator). Options are the
  // distinct creators actually present in the cycle's entries, so the
  // dropdown never lists someone with nothing in the window.
  const creatorFilter = useMemo(() => {
    const seen = new Map();
    for (const e of derived.entries) {
      const id = e.creator?.id;
      if (!id || seen.has(id)) continue;
      const label = creatorDisplay(e.creator);
      if (label) seen.set(id, label);
    }
    const options = [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return {
      key: 'creator',
      label: 'Vendedor',
      type: 'select',
      placeholder: 'Todos',
      options,
    };
  }, [derived.entries]);

  const sortOptions = [
    { key: 'accepted', label: 'Aceptada' },
    { key: 'total', label: 'Total' },
    { key: 'commission', label: 'Comisión' },
    { key: 'customer', label: 'Cliente A–Z' },
  ];

  const filteredEntries = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const creator = filters.creator;
    const rows = derived.entries
      .filter((e) => {
        if (tab === 'recibido') return Boolean(e.quote.depositReceivedAt);
        if (tab === 'pendiente') return !e.quote.depositReceivedAt;
        return true;
      })
      .filter((e) => (creator ? e.creator?.id === creator : true))
      .filter((e) => {
        if (!needle) return true;
        const num = String(e.quote.number || '');
        const cust = (e.customer?.company || e.customer?.name || '').toLowerCase();
        const vend = (e.creator?.name || e.creator?.email || '').toLowerCase();
        return num.includes(needle) || cust.includes(needle) || vend.includes(needle);
      });

    // Sort. derived.entries already comes acceptedAt-desc; re-sorting here
    // keeps the direction toggle honest. Direction multiplier flips asc/desc;
    // 'customer' uses localeCompare for A–Z.
    const mul = sort.dir === 'asc' ? 1 : -1;
    const sorted = [...rows].sort((a, b) => {
      if (sort.key === 'total') {
        return (a.grandTotal - b.grandTotal) * mul;
      }
      if (sort.key === 'commission') {
        const ac = a.depositIn ? a.earnedCommission : a.potentialCommission;
        const bc = b.depositIn ? b.earnedCommission : b.potentialCommission;
        return (ac - bc) * mul;
      }
      if (sort.key === 'customer') {
        const an = (a.customer?.company || a.customer?.name || '').toLowerCase();
        const bn = (b.customer?.company || b.customer?.name || '').toLowerCase();
        return an.localeCompare(bn) * mul;
      }
      // accepted
      return ((a.quote.acceptedAt || 0) - (b.quote.acceptedAt || 0)) * mul;
    });
    return sorted;
  }, [derived.entries, q, tab, filters, sort]);

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
    // so a full export is safe to re-run any time. The per-line math is
    // shared with the per-row dropdown and the per-quote CSV via
    // invoiceLinesForQuote so the three surfaces can't drift.
    const rows = [ODOO_INVOICE_HEADER];
    for (const qu of quotesQ.data) {
      if (qu.status !== QUOTE_STATUS_ACCEPTED) continue;
      const customer = qu.customerId ? customerById.get(qu.customerId) : null;
      for (const il of invoiceLinesForQuote(qu, linesByQuote.get(qu.id) || [])) {
        rows.push(invoiceCsvRow(qu, customer, il));
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
      'estado', 'pagada_fecha',
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
        e.sellerPaid ? 'pagada' : 'pendiente',
        e.sellerPaid ? isoDate(e.quote.sellerCommissionPaidAt) : '',
      ]);
    }
    downloadCsv(`comisiones-${cycleStartIso}-a-${cycleEndIso}.csv`, rows);
  }

  async function exportProCommissions() {
    const cycleStartIso = isoDate(cycle.start);
    const cycleEndIso   = isoDate(cycle.end);
    const header = [
      'cycle_start', 'cycle_end', 'profesional', 'empresa', 'email',
      'quote_number', 'customer', 'devengada_via', 'devengada_fecha',
      'base_imponible_usd', 'commission_pct', 'commission_amount_usd',
      'estado', 'pagada_fecha',
    ];
    const rows = [header];
    for (const e of derived.entries) {
      // Only commission-modality entries that are actually owed have a payout.
      if (!e.professional || e.mode !== 'commission' || !e.proOwed) continue;
      rows.push([
        cycleStartIso, cycleEndIso,
        e.professional.name || '',
        e.professional.company || '',
        e.professional.email || '',
        e.quote.number != null ? String(e.quote.number) : '',
        e.customer ? (e.customer.company || e.customer.name || '') : '',
        e.quote.orderType === 'special' ? 'balance' : 'deposito',
        isoDate(e.proOwedAt),
        e.base.toFixed(2),
        e.proPct,
        e.proReported.toFixed(2),
        e.proPaid ? 'pagada' : 'pendiente',
        e.proPaid ? isoDate(e.quote.commissionPaidAt) : '',
      ]);
    }
    downloadCsv(`comisiones-profesionales-${cycleStartIso}-a-${cycleEndIso}.csv`, rows);
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
            <ExportButton
              icon={Briefcase}
              label="Com. profesionales"
              busy={exportBusy === 'pro-commissions'}
              disabled={!loaded || !derived.entries.some((e) => e.professional && e.mode === 'commission' && e.proOwed)}
              onClick={withBusy('pro-commissions', exportProCommissions)}
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

      {/* Search / filter header — search + deposit tabs + vendedor filter +
          sort. The cycle picker above stays the primary dimension; this
          refines within the selected window. */}
      <ListSearchHeader
        searchValue={q}
        onSearchChange={setQ}
        searchPlaceholder="Buscar por número, cliente o vendedor…"
        tabs={tabs}
        activeTab={tab}
        onTabChange={setTab}
        filters={[creatorFilter]}
        activeFilters={filters}
        onFiltersChange={setFilters}
        sortOptions={sortOptions}
        sort={sort}
        onSortChange={setSort}
        resultCount={filteredEntries.length}
        resultNoun={['venta', 'ventas']}
      />

      {/* Ventas del ciclo — one expandable card per sale. Collapsed: the
          identity + total + commission status the accountant scans.
          Expanded: the Odoo invoice detail (ref + per-product lines +
          totals) followed by BOTH commissions owed on the sale (vendedor +
          profesional, with the professional's invoicing mode), each
          tickable as paid once it's earned. */}
      <section className="card overflow-hidden mb-6">
        <header className="card-header">
          <h2>Ventas del ciclo</h2>
          <span className="badge">{filteredEntries.length}</span>
        </header>
        {!loaded ? (
          <ListLoading rows={5} />
        ) : filteredEntries.length === 0 ? (
          <EmptyState
            icon={FileCheck}
            title={derived.entries.length === 0
              ? 'Sin ventas aceptadas en este ciclo'
              : 'Sin coincidencias'}
            description={derived.entries.length === 0
              ? 'Cambia el ciclo o espera a que se acepten cotizaciones del periodo.'
              : 'Ajusta la búsqueda o limpia el campo.'}
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {filteredEntries.map((e) => (
              <SaleCard
                key={e.quote.id}
                entry={e}
                lines={linesByQuote.get(e.quote.id) || []}
                settings={settings}
                savingPaid={savingPaid}
                onSellerPaid={setSellerPaid}
                onProPaid={setProPaid}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Payout rollups — batch "who do I pay how much" for the cycle.
          Same per-sale numbers as the cards above, grouped, with paid vs
          pending split so the accountant can settle each in one go. */}
      {loaded && derived.vendedorRows.length > 0 && (
        <SummaryTable
          title="Resumen por vendedor"
          icon={UsersIcon}
          rows={derived.vendedorRows}
          keyOf={(r) => r.user.id}
          nameOf={(r) => r.user.name || r.user.email || '—'}
          subOf={(r) => (r.user.email && r.user.name ? r.user.email : null)}
        />
      )}
      {loaded && derived.profRows.length > 0 && (
        <SummaryTable
          title="Resumen por profesional"
          icon={Briefcase}
          rows={derived.profRows}
          keyOf={(r) => r.professional.id}
          nameOf={(r) => r.professional.name || '—'}
          subOf={(r) => r.professional.company || null}
        />
      )}
    </>
  );
}

/**
 * One sale (accepted quote) as the accountant reads it. Collapsed: quote #,
 * customer, vendedor + date, the grand total and a one-glance commission
 * status. Expanded: the Odoo invoice detail (lines + totals + CSV) and then
 * BOTH commissions owed on the sale — vendedor and, if assigned, the
 * profesional (with the invoicing mode), each tickable as paid once earned.
 */
function SaleCard({ entry, lines, settings, savingPaid, onSellerPaid, onProPaid }) {
  const {
    quote, customer, creator, professional, mode, decoratorPct, base, grandTotal, totals,
    commissionPct, potentialCommission, sellerReported, sellerPayable, sellerPaid,
    proPct, proAmount, proReported, proPayable, proPaid,
  } = entry;
  const [open, setOpen] = useState(false);
  const pdf = usePdfDownload({ quote, customer, lines, settings });
  const currency = quote.currencyCode || 'USD';
  const rates = displayRatesFor(quote, settings);
  const invLines = useMemo(() => invoiceLinesForQuote(quote, lines), [quote, lines]);
  const customerName = customer?.company || customer?.name || '—';

  // Commission figures always book in USD (the price-list currency), so the
  // detail strings render with a fixed USD rate regardless of the quote's
  // display currency.
  const fmtUsd = (v) => formatMoney(v, 'USD', { USD: 1 });
  // Professional settlement detail. Both modalities draw the client discount
  // out of the decorator's amount, so when a discount is present the equation
  // shows every term (the post-discount base × % would NOT equal the net):
  //   • commission:     Base(pre-discount) · % = gross − desc = net
  //   • trade discount: −% = gross − desc. cliente = net trade discount
  // Without a discount gross === net, so the compact form stays. All terms
  // come from the one lib breakdown (gross/discount/net), so the printed
  // numbers always reconcile and mirror the builder's CommissionCard. Once
  // PAID the commission line collapses to the frozen amount that was actually
  // paid (proReported) — a live breakdown would re-derive and could drift from
  // the snapshot, so we show the figure of record instead.
  const proCommission = commissionBreakdown(totals, proPct);
  const proDetail = mode === 'trade_discount'
    ? proCommission.discount > 0
      ? `Facturar al decorador −${decoratorPct}% = ${fmtUsd(proCommission.gross)} − desc. cliente ${fmtUsd(proCommission.discount)} = ${fmtUsd(proAmount)} (sin comisión)`
      : `Facturar al decorador −${decoratorPct}% (sin comisión)`
    : proPaid
      ? `Pagada · ${fmtUsd(proReported)}`
      : proCommission.discount > 0
        ? `Base ${fmtUsd(base + proCommission.discount)} · ${proPct}% = ${fmtUsd(proCommission.gross)} − desc. ${fmtUsd(proCommission.discount)} = ${fmtUsd(proAmount)}`
        : `Base ${fmtUsd(base)} · ${proPct}% = ${fmtUsd(proAmount)}`;

  const anyPayable = sellerPayable || proPayable;
  const anyPending = (sellerPayable && !sellerPaid) || (proPayable && !proPaid);
  const chip = !anyPayable
    ? { cls: 'text-ink-400', text: 'Comisión tras depósito' }
    : anyPending
      ? { cls: 'text-amber-700', text: 'Comisión pendiente' }
      : { cls: 'text-emerald-700', text: 'Comisiones pagadas' };

  return (
    <li className="bg-white">
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-3 flex-1 min-w-0 text-left"
          aria-expanded={open}
        >
          <ChevronDown
            size={16}
            className={`flex-shrink-0 text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium whitespace-nowrap">#{quote.number || '—'}</span>
              <span className="text-ink-700 truncate">{customerName}</span>
            </div>
            <div className="text-[11px] text-ink-500 truncate">
              {creatorDisplay(creator) || 'Sin vendedor'} · {formatDate(quote.acceptedAt)}
            </div>
          </div>
          <div className="flex-shrink-0 text-right">
            <div className="tabular-nums font-medium whitespace-nowrap">
              {formatMoney(grandTotal, currency, rates)}
            </div>
            <span className={`text-[10px] font-semibold ${chip.cls}`}>{chip.text}</span>
          </div>
        </button>
        <PdfButton pdf={pdf} />
      </div>

      {open && (
        <div className="px-4 pb-4 sm:pl-10 space-y-4 bg-ink-50/40">
          <QuoteAccountingDetail
            invLines={invLines}
            totals={totals}
            currency={currency}
            rates={rates}
            onExportCsv={() => downloadQuoteInvoiceCsv(quote, customer, lines)}
          />

          <div className="space-y-2">
            <h3 className="eyebrow font-semibold tracking-wide text-ink-600">
              Comisiones de esta venta
            </h3>

            <CommissionLine
              role="Vendedor"
              who={creatorDisplay(creator) || '—'}
              detail={sellerPaid
                ? `Pagada · ${fmtUsd(sellerReported)}`
                : `Base ${fmtUsd(base)} · ${commissionPct}% = ${fmtUsd(potentialCommission)}`}
              action={sellerPayable ? (
                <PaidToggle
                  paid={sellerPaid}
                  busy={savingPaid === `seller:${quote.id}`}
                  onToggle={(n) => onSellerPaid(quote.id, n, potentialCommission)}
                />
              ) : (
                <span className="text-[11px] text-ink-400 italic whitespace-nowrap">Tras depósito</span>
              )}
            />

            {professional && (
              <CommissionLine
                role="Profesional"
                who={professional.name || '—'}
                badge={mode === 'trade_discount' ? 'Trade discount' : 'Comisión'}
                detail={proDetail}
                action={mode === 'trade_discount' ? null : (proPayable ? (
                  <PaidToggle
                    paid={proPaid}
                    busy={savingPaid === `pro:${quote.id}`}
                    onToggle={(n) => onProPaid(quote.id, n, proAmount)}
                  />
                ) : (
                  <span className="text-[11px] text-ink-400 italic whitespace-nowrap">
                    Tras {quote.orderType === 'special' ? 'balance' : 'depósito'}
                  </span>
                ))}
              />
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** One commission row inside a sale card (vendedor or profesional). */
function CommissionLine({ role, who, badge, detail, action }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-ink-100 bg-white px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">{role}</span>
          <span className="text-sm text-ink-800 truncate">{who}</span>
          {badge && (
            <span className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded ${
              badge === 'Trade discount' ? 'bg-amber-100 text-amber-800' : 'bg-ink-100 text-ink-600'
            }`}>
              {badge}
            </span>
          )}
        </div>
        <div className="text-[11px] text-ink-500 truncate">{detail}</div>
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}

/** Payout rollup card — name, # ventas, comisión, pagado, pendiente. */
function SummaryTable({ title, icon: Icon, rows, keyOf, nameOf, subOf }) {
  const pendingTotal = rows.reduce((s, r) => s + r.pending, 0);
  return (
    <section className="card overflow-hidden mt-6">
      <header className="card-header">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={15} className="text-ink-500" />}
          <h2>{title}</h2>
        </div>
        <span className="badge">{rows.length}</span>
      </header>
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th className="text-right whitespace-nowrap"># ventas</th>
              <th className="text-right whitespace-nowrap">Comisión</th>
              <th className="text-right whitespace-nowrap">Pagado</th>
              <th className="text-right whitespace-nowrap">Pendiente</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const sub = subOf(r);
              return (
                <tr key={keyOf(r)}>
                  <td className="font-medium">
                    {nameOf(r)}
                    {sub && <div className="text-[11px] text-ink-500">{sub}</div>}
                  </td>
                  <td className="text-right tabular-nums">{r.count}</td>
                  <td className="text-right tabular-nums whitespace-nowrap">
                    {formatMoney(r.commission, 'USD', { USD: 1 })}
                  </td>
                  <td className="text-right tabular-nums whitespace-nowrap text-emerald-700">
                    {formatMoney(r.paid, 'USD', { USD: 1 })}
                  </td>
                  <td className="text-right tabular-nums whitespace-nowrap font-medium text-amber-700">
                    {formatMoney(r.pending, 'USD', { USD: 1 })}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-ink-50">
              <td colSpan={4} className="text-right text-xs font-semibold uppercase tracking-wide text-ink-600">
                Pendiente total
              </td>
              <td className="text-right tabular-nums whitespace-nowrap font-semibold text-amber-700">
                {formatMoney(pendingTotal, 'USD', { USD: 1 })}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

/**
 * Pending ↔ paid toggle for a single commission (seller or professional).
 * Paid shows a green confirmed chip (click to revert); pending shows a
 * neutral "Marcar pagada" button.
 */
function PaidToggle({ paid, busy, onToggle }) {
  if (paid) {
    return (
      <button
        type="button"
        onClick={() => onToggle(false)}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 disabled:cursor-wait"
        title="Pagada — clic para revertir a pendiente"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Pagada
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onToggle(true)}
      disabled={busy}
      className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-white px-2 py-1 text-xs font-medium text-ink-700 hover:border-ink-400 disabled:opacity-50 disabled:cursor-wait"
      title="Marcar comisión como pagada"
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : null}Marcar pagada
    </button>
  );
}

/**
 * Expanded per-quote accounting detail: the invoice lines exactly as
 * they'll book in Odoo (one row per product / per compound component)
 * plus the totals breakdown, and a one-click per-quote Odoo CSV. Gives
 * the accountant everything to key the invoice without opening the PDF.
 */
function QuoteAccountingDetail({ invLines, totals, currency, rates, onExportCsv }) {
  const fmt = (v) => formatMoney(v, currency, rates);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="eyebrow font-semibold tracking-wide text-ink-600">
          Detalle para facturar
        </h3>
        <button type="button" onClick={onExportCsv} className="btn-ghost text-xs">
          <Download size={12} /> CSV Odoo
        </button>
      </div>

      <div className="overflow-x-auto rounded-md border border-ink-100 bg-white">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-ink-500 border-b border-ink-100">
              <th className="font-medium py-1.5 px-2.5">Producto</th>
              <th className="font-medium py-1.5 px-2.5 text-right whitespace-nowrap">Cant.</th>
              <th className="font-medium py-1.5 px-2.5 text-right whitespace-nowrap">Precio unit.</th>
              <th className="font-medium py-1.5 px-2.5 text-right whitespace-nowrap">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {invLines.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-center text-ink-400 py-3">
                  Sin líneas facturables
                </td>
              </tr>
            ) : invLines.map((il, i) => (
              <tr key={i} className="border-b border-ink-50 last:border-0">
                <td className="py-1.5 px-2.5 text-ink-800">{il.name || '—'}</td>
                <td className="py-1.5 px-2.5 text-right tabular-nums">{il.qty}</td>
                <td className="py-1.5 px-2.5 text-right tabular-nums whitespace-nowrap">{fmt(il.unit)}</td>
                <td className="py-1.5 px-2.5 text-right tabular-nums whitespace-nowrap">{fmt(il.subtotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="sm:ml-auto sm:w-72 text-xs tabular-nums">
        <TotalLine label="Subtotal" value={fmt(totals.subtotal)} />
        {totals.discountAmt > 0 && <TotalLine label="Descuento" value={`–${fmt(totals.discountAmt)}`} />}
        <TotalLine label="Base imponible" value={fmt(totals.taxableBase)} />
        <TotalLine label={`ITBIS (${totals.taxPct}%)`} value={fmt(totals.taxAmt)} />
        {totals.shipping > 0 && <TotalLine label="Envío" value={fmt(totals.shipping)} />}
        <TotalLine label="Total" value={fmt(totals.grandTotal)} strong />
      </div>
    </div>
  );
}

function TotalLine({ label, value, strong }) {
  return (
    <div className={`flex items-center justify-between py-1 border-b border-ink-100 last:border-b-0 ${
      strong ? 'font-semibold text-ink-900' : 'text-ink-600'
    }`}>
      <span>{label}</span>
      <span className="whitespace-nowrap">{value}</span>
    </div>
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
      const { generateQuotePdf, downloadBlob, quoteFileName } = await safeDynamicImport(
        () => import('../../pdf/quotePdf.js'),
      );
      const blob = await generateQuotePdf({ quote, settings, lines, totals, customer });
      await downloadBlob(blob, `${quoteFileName(quote, customer)}.pdf`);
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

/* -------------------------------------------------------------------------- */
/*  Odoo invoice lines — single source of truth                               */
/* -------------------------------------------------------------------------- */

// CSV column order for the Odoo invoice import. Shared by the bulk
// "Facturas" export and the per-quote CSV so they stay identical.
const ODOO_INVOICE_HEADER = [
  'partner_name', 'invoice_date', 'quote_number', 'product_name',
  'qty', 'price_unit', 'price_subtotal', 'currency', 'status',
];

/**
 * Build the bookable invoice lines for one quote: one entry per priced
 * product, with compound lines expanded to one entry per component and
 * line-level margin/discount folded into each unit price. Excludes
 * optional and non-selected-alternative lines (isPricedLine). Shared by
 * the per-row dropdown, the per-quote CSV, and the bulk export so all
 * three agree on product name, qty and price math.
 */
function invoiceLinesForQuote(quote, lines) {
  const out = [];
  const itemLines = (lines || [])
    .filter(isPricedLine)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  for (const l of itemLines) {
    if (isCompoundLine(l)) {
      const familyName = (l.name || '').trim();
      for (const c of l.components || []) {
        const unit = applyLineAdjustments(c.unitPrice, l.lineMarginPct, l.lineDiscountPct);
        const qty = Number(c.qty) || 0;
        const componentName = [c.name, c.reference, c.dimensions]
          .map((s) => (s || '').trim()).filter(Boolean).join(' · ');
        out.push({
          name: familyName ? `${familyName} — ${componentName}` : componentName,
          qty, unit, subtotal: unit * qty,
        });
      }
    } else {
      const unit = applyLineAdjustments(l.unitPrice, l.lineMarginPct, l.lineDiscountPct);
      const qty = Number(l.qty) || 0;
      out.push({
        name: [l.name, l.reference, l.dimensions]
          .map((s) => (s || '').trim()).filter(Boolean).join(' · '),
        qty, unit, subtotal: unit * qty,
      });
    }
  }
  return out;
}

// One CSV row from a quote + customer + an invoiceLinesForQuote entry.
function invoiceCsvRow(quote, customer, il) {
  const partnerName = customer ? (customer.company || customer.name || '') : '';
  const invoiceDate = quote.acceptedAt ? isoDate(quote.acceptedAt) : '';
  const currency = quote.currencyCode || 'USD';
  return [
    partnerName, invoiceDate, quote.number != null ? String(quote.number) : '',
    il.name, il.qty, il.unit.toFixed(2), il.subtotal.toFixed(2), currency, quote.status,
  ];
}

// Per-quote Odoo invoice CSV (the single-quote counterpart of the bulk
// "Facturas" export), triggered from the per-row accounting dropdown.
function downloadQuoteInvoiceCsv(quote, customer, lines) {
  const rows = [ODOO_INVOICE_HEADER];
  for (const il of invoiceLinesForQuote(quote, lines)) {
    rows.push(invoiceCsvRow(quote, customer, il));
  }
  downloadCsv(`odoo-factura-${quote.number || quote.id}-${isoDate(Date.now())}.csv`, rows);
}
