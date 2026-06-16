import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Wallet, FileCheck, Users as UsersIcon, Download,
  Loader2, Calendar, ChevronDown, Briefcase, Check, Receipt,
  Warehouse, MapPin, FileBarChart,
} from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import LigneRosetReport from '../../components/accounting/LigneRosetReport.jsx';
import Dropdown, { DropdownItem } from '../../components/primitives/Dropdown.jsx';
import ListSearchHeader from '../../components/search/ListSearchHeader.jsx';
import { formatDate, formatMoney } from '../../lib/format.js';
import { displayRatesFor, effectiveDopRate } from '../../lib/exchangeRate.js';
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
  commissionAmount, commissionBreakdown, decoratorBilling,
  commissionOwedAt, reportedCommission,
} from '../../lib/commissions.js';
import { resolveSales, resolveWorkspaceEntries } from '../../core/accounting/sales.js';
import { activeFiscalPlugin } from '../../core/accounting/index.js';
import { groupFamilies } from '../../lib/catalog.js';
import { resolveWarehouseOrder } from '../../core/quote/index.js';
import RowCards from '../../components/RowCards.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';

/**
 * Customizable columns (Shopify-style) for the payout rollup tables (Resumen
 * por vendedor / por profesional). Both rollups share this one ordered
 * definition but persist independently via their own storage key. The name is
 * the fixed identity anchor (`canHide: false`); each `cell` is a pure render
 * off the per-row `ctx` the row builds, and `foot` returns this column's value
 * in the totals row (null = no total, render an empty cell).
 */
const SUMMARY_COLUMNS = [
  {
    key: 'name', label: 'Nombre', canHide: false,
    tdClass: 'font-medium',
    cell: ({ name, sub }) => (
      <>
        {name}
        {sub && <div className="text-[11px] text-ink-400">{sub}</div>}
      </>
    ),
  },
  {
    key: 'count', label: '# ventas',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums',
    cell: ({ r }) => r.count,
  },
  {
    key: 'commission', label: 'Comisión',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => formatMoney(r.commission, 'USD', { USD: 1 }),
  },
  {
    key: 'paid', label: 'Pagado',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap text-emerald-700',
    cell: ({ r }) => formatMoney(r.paid, 'USD', { USD: 1 }),
  },
  {
    key: 'pending', label: 'Pendiente',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap font-medium text-amber-700',
    cell: ({ r }) => formatMoney(r.pending, 'USD', { USD: 1 }),
    foot: ({ pendingTotal }) => formatMoney(pendingTotal, 'USD', { USD: 1 }),
  },
];
const SUMMARY_DEFAULT_COLS = {
  count: true, commission: true, paid: true, pending: true,
};

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

  // Which sales lens is showing: the per-cycle sales + commissions ('ciclo'),
  // or the Ligne Roset monthly sell-through ('lr'). Both are SALES logic, so
  // both live on this one screen — the LR report is the shared component, the
  // same one its standalone page renders.
  const [lens, setLens] = useState('ciclo'); // 'ciclo' | 'lr'

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
  // Catalog products → families (keyed by SKU root), the SAME map the quote
  // builder feeds the warehouse-order PDF — it resolves each pulled item's
  // cover photo. Not gated into `loaded`: the page renders without it and the
  // photos fill in once the catalog arrives (a warehouse order is still usable
  // with reference + name while it loads).
  const productsQ = useLiveQueryStatus(
    () => db.products.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const families = useMemo(() => {
    const m = new Map();
    for (const fam of groupFamilies(productsQ.data)) m.set(fam.root, fam);
    return m;
  }, [productsQ.data]);

  const loaded = quotesQ.loaded && customersQ.loaded && linesQ.loaded && professionalsQ.loaded;

  // Sales-tax label from the active jurisdiction plugin (DR: "ITBIS"). The
  // sales screen never hardcodes the tax name — the engine is country-agnostic.
  const taxName = activeFiscalPlugin(settings).tax.name;

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
  // Domain derivation lives in the accounting Model (core/accounting/sales);
  // the page passes the cycle-scoped data + its totalsFor resolver and renders
  // the result. (linesByQuote stays in deps — totalsFor closes over it.)
  const derived = useMemo(
    () => resolveSales({
      quotes: quotesQ.data, cycle, customerById, profileById, professionalById, totalsFor,
    }),
    [quotesQ.data, cycle, customerById, profileById, professionalById, linesByQuote],
  );

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

  // Refinement (deposit tabs, vendedor filter, needle, sort) lives in the
  // Model — resolveWorkspaceEntries — because the commission sort encodes a
  // money rule. The View keeps only the control state.
  const workspace = useMemo(
    () => resolveWorkspaceEntries({ entries: derived.entries, q, tab, creator: filters.creator, sort }),
    [derived.entries, q, tab, filters, sort],
  );
  const filteredEntries = workspace.rows;
  const tabs = workspace.tabs;
  const creatorFilter = {
    key: 'creator', label: 'Vendedor', type: 'select', placeholder: 'Todos',
    options: workspace.creatorOptions,
  };

  const sortOptions = [
    { key: 'accepted', label: 'Aceptada' },
    { key: 'total', label: 'Total' },
    { key: 'commission', label: 'Comisión' },
    { key: 'customer', label: 'Cliente A–Z' },
  ];

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
      // Only deposit-in-cycle entries with a real (non-zero) seller commission
      // owe a payout — a 0%/no-rate seller owes nothing. Same rule as the
      // on-screen rollup (Resumen por vendedor), so the CSV can't drift from it.
      if (!e.depositIn || !e.creator || !e.sellerHasCommission) continue;
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

  return (
    <AccountingGate title="Ventas">
      <PageHeader
        title="Ventas"
        subtitle={`Comando de ventas · Ciclo ${formatCycle(cycle)}`}
        actions={
          /* The four Odoo exports apply to the cycle lens (clientes / facturas
             / comisiones del ciclo) — hidden on the Ligne Roset lens, which
             carries its own export. ONE menu instead of four crowding buttons. */
          lens === 'ciclo' ? (
          <Dropdown
            align="right"
            ariaLabel="Exportar CSV para Odoo"
            panelClassName="w-72"
            label={exportBusy
              ? <><Loader2 size={14} className="animate-spin" aria-hidden /> Exportar</>
              : <><Download size={14} aria-hidden /> Exportar</>}
          >
            {({ close }) => (
              <>
                <DropdownItem
                  disabled={!loaded || customersQ.data.length === 0}
                  onSelect={() => { close(); withBusy('customers', exportCustomers)(); }}
                >
                  <UsersIcon size={14} className="mt-0.5 flex-shrink-0 text-ink-400" aria-hidden />
                  <span>
                    <span className="block font-medium">Clientes</span>
                    <span className="block text-xs text-ink-500">CSV de clientes para Odoo</span>
                  </span>
                </DropdownItem>
                <DropdownItem
                  disabled={!loaded}
                  onSelect={() => { close(); withBusy('invoices', exportInvoices)(); }}
                >
                  <FileCheck size={14} className="mt-0.5 flex-shrink-0 text-ink-400" aria-hidden />
                  <span>
                    <span className="block font-medium">Facturas</span>
                    <span className="block text-xs text-ink-500">Todas las cotizaciones aceptadas</span>
                  </span>
                </DropdownItem>
                <DropdownItem
                  disabled={!loaded}
                  onSelect={() => { close(); withBusy('commissions', exportCommissions)(); }}
                >
                  <Wallet size={14} className="mt-0.5 flex-shrink-0 text-ink-400" aria-hidden />
                  <span>
                    <span className="block font-medium">Comisiones</span>
                    <span className="block text-xs text-ink-500">Vendedores · ciclo seleccionado</span>
                  </span>
                </DropdownItem>
                <DropdownItem
                  disabled={!loaded || !derived.entries.some((e) => e.professional && e.mode === 'commission' && e.proOwed)}
                  onSelect={() => { close(); withBusy('pro-commissions', exportProCommissions)(); }}
                >
                  <Briefcase size={14} className="mt-0.5 flex-shrink-0 text-ink-400" aria-hidden />
                  <span>
                    <span className="block font-medium">Com. profesionales</span>
                    <span className="block text-xs text-ink-500">Profesionales · ciclo seleccionado</span>
                  </span>
                </DropdownItem>
              </>
            )}
          </Dropdown>
          ) : null
        }
      />

      {/* Sales lens toggle — the two ways to read the cycle's SALES, both on
          this one screen: the per-sale cycle view and the Ligne Roset monthly
          sell-through. */}
      <div className="flex flex-wrap gap-1 mb-4 p-1 rounded-lg bg-ink-100/60 w-fit">
        <LensTab active={lens === 'ciclo'} onClick={() => setLens('ciclo')} icon={FileCheck} label="Ventas del ciclo" />
        <LensTab active={lens === 'lr'} onClick={() => setLens('lr')} icon={FileBarChart} label="Reporte Ligne Roset" />
      </div>

      {lens === 'ciclo' && (
      <>
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
                families={families}
                taxName={taxName}
                savingPaid={savingPaid}
                onSellerPaid={setSellerPaid}
                onProPaid={setProPaid}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Payout rollups — batch "who do I pay how much" for the cycle. Same
          per-sale numbers as the cards above, grouped, paid vs pending split.
          Tucked in a collapsed disclosure so the SALE LIST is the single-screen
          focus: the accountant opens this only when settling payouts. */}
      {loaded && (derived.vendedorRows.length > 0 || derived.profRows.length > 0) && (
        <details className="group mt-6">
          <summary className="flex items-center gap-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-sm font-medium text-ink-600 hover:text-ink-900 py-2">
            <ChevronDown size={16} className="text-ink-400 transition-transform group-open:rotate-180" aria-hidden />
            Resumen de comisiones por persona
            <span className="text-[11px] text-ink-400 font-normal">
              {derived.vendedorRows.length} vendedor{derived.vendedorRows.length === 1 ? '' : 'es'}
              {derived.profRows.length > 0 && ` · ${derived.profRows.length} profesional${derived.profRows.length === 1 ? '' : 'es'}`}
            </span>
          </summary>
          {derived.vendedorRows.length > 0 && (
            <SummaryTable
              title="Resumen por vendedor"
              icon={UsersIcon}
              rows={derived.vendedorRows}
              keyOf={(r) => r.user.id}
              nameOf={(r) => r.user.name || r.user.email || '—'}
              subOf={(r) => (r.user.email && r.user.name ? r.user.email : null)}
              colsStorageKey="rs.workspace.vendedores.cols.v1"
              widthsStorageKey="rs.workspace.vendedores.widths.v1"
            />
          )}
          {derived.profRows.length > 0 && (
            <SummaryTable
              title="Resumen por profesional"
              icon={Briefcase}
              rows={derived.profRows}
              keyOf={(r) => r.professional.id}
              nameOf={(r) => r.professional.name || '—'}
              subOf={(r) => r.professional.company || null}
              colsStorageKey="rs.workspace.profesionales.cols.v1"
              widthsStorageKey="rs.workspace.profesionales.widths.v1"
            />
          )}
        </details>
      )}
      </>
      )}

      {lens === 'lr' && <LigneRosetReport />}
    </AccountingGate>
  );
}

/**
 * One sale (accepted quote) as the accountant reads it. Collapsed: quote #,
 * customer, vendedor + date, the grand total and a one-glance commission
 * status. Expanded: the Odoo invoice detail (lines + totals + CSV) and then
 * BOTH commissions owed on the sale — vendedor and, if assigned, the
 * profesional (with the invoicing mode), each tickable as paid once earned.
 */
function SaleCard({ entry, lines, settings, families, taxName, savingPaid, onSellerPaid, onProPaid }) {
  const {
    quote, customer, creator, professional, mode, decoratorPct, base, grandTotal, totals,
    commissionPct, potentialCommission, sellerReported, sellerPayable, sellerPaid, sellerHasCommission,
    proPct, proAmount, proReported, proPayable, proPaid,
  } = entry;
  const [open, setOpen] = useState(false);
  const pdf = usePdfDownload({ quote, customer, lines, settings });
  // The warehouse-order (orden de almacén) PDF for THIS sale — the picking list
  // the warehouse pulls from (photo · ref · name · qty). The seller is the
  // quote's creator; families resolves the cover photos.
  const warehouse = useWarehouseDownload({
    quote, customer, professional, seller: creator, lines, settings, families,
  });
  const currency = quote.currencyCode || 'USD';
  const rates = displayRatesFor(quote, settings);
  const invLines = useMemo(() => invoiceLinesForQuote(quote, lines), [quote, lines]);
  const customerName = customer?.company || customer?.name || '—';
  // The delivery address — the piece accounting needs at a glance to invoice
  // and dispatch. Street + city; falls back to a muted prompt when unset so
  // it's obvious the customer record is missing it.
  const addressText = [customer?.address, customer?.city].map((s) => (s || '').trim()).filter(Boolean).join(', ');

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

  // A 0%/no-rate seller earns no commission, so its deposit must not light up
  // a phantom payout state; only a real seller cut counts. A sale with neither
  // a seller commission nor a professional shows no commission chip at all.
  const sellerCounts = sellerHasCommission && sellerPayable;
  const anyPayable = sellerCounts || proPayable;
  const anyPending = (sellerCounts && !sellerPaid) || (proPayable && !proPaid);
  const hasCommissions = sellerHasCommission || Boolean(professional);
  const chip = !hasCommissions
    ? null
    : !anyPayable
      ? { cls: 'text-ink-400', text: 'Comisión tras depósito' }
      : anyPending
        ? { cls: 'text-amber-700', text: 'Comisión pendiente' }
        : { cls: 'text-emerald-700', text: 'Comisiones pagadas' };

  return (
    <li className="bg-surface hover:bg-ink-50/40 transition-colors group">
      <div className="flex items-start gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-start gap-3 flex-1 min-w-0 text-left"
          aria-expanded={open}
        >
          <ChevronDown
            size={16}
            className={`flex-shrink-0 text-ink-400 transition-transform duration-150 mt-0.5 ${open ? 'rotate-180' : ''}`}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium tabular-nums whitespace-nowrap text-ink-600">#{quote.number || '—'}</span>
              <span className="text-ink-700 truncate min-w-0">{customerName}</span>
            </div>
            <div className="text-[11px] text-ink-500 truncate">
              {creatorDisplay(creator) || 'Sin vendedor'} · <span className="tabular-nums">{formatDate(quote.acceptedAt)}</span>
            </div>
            <div className={`text-[11px] truncate flex items-center gap-1 mt-0.5 ${addressText ? 'text-ink-600' : 'text-ink-400 italic'}`}>
              <MapPin size={11} className="flex-shrink-0 text-ink-400" aria-hidden />
              <span className="truncate">{addressText || 'Sin dirección registrada'}</span>
            </div>
            <div className="flex sm:hidden flex-wrap items-center gap-2 mt-1">
              <span className="tabular-nums font-semibold text-ink-900 text-sm">
                {formatMoney(grandTotal, currency, rates)}
              </span>
              {chip && <span className={`text-[10px] font-semibold ${chip.cls}`}>{chip.text}</span>}
            </div>
          </div>
          <div className="hidden sm:block flex-shrink-0 text-right">
            <div className="tabular-nums font-semibold text-ink-900 whitespace-nowrap">
              {formatMoney(grandTotal, currency, rates)}
            </div>
            {chip && <span className={`text-[10px] font-semibold ${chip.cls}`}>{chip.text}</span>}
          </div>
        </button>
        <div className="flex flex-col items-stretch gap-1 flex-shrink-0">
          <PdfButton pdf={pdf} />
          <WarehouseButton warehouse={warehouse} />
        </div>
      </div>
      {warehouse.error && (
        <div className="px-4 pb-2 -mt-1 text-[11px] text-rose-600">{warehouse.error}</div>
      )}

      {open && (
        <div className="px-3 sm:px-4 pb-5 sm:pl-10 space-y-4 border-t border-ink-100 bg-ink-50/30 min-w-0">
          <QuoteAccountingDetail
            invLines={invLines}
            totals={totals}
            currency={currency}
            rates={rates}
            taxName={taxName}
            onExportCsv={() => downloadQuoteInvoiceCsv(quote, customer, lines)}
          />

          {(sellerHasCommission || professional) && (
          <div className="space-y-2">
            <h3 className="eyebrow font-semibold tracking-wide text-ink-600">
              Comisiones de esta venta
            </h3>

            {sellerHasCommission && (
            <CommissionLine
              role="Vendedor"
              who={creatorDisplay(creator) || '—'}
              detail={sellerPaid
                ? `Pagada · ${fmtUsd(sellerReported)}`
                : `Base ${fmtUsd(base)} · ${commissionPct}% = ${fmtUsd(potentialCommission)}`}
              action={sellerPayable ? (
                <span className="inline-flex items-center gap-1.5">
                  <PaidToggle
                    paid={sellerPaid}
                    busy={savingPaid === `seller:${quote.id}`}
                    onToggle={(n) => onSellerPaid(quote.id, n, potentialCommission)}
                  />
                  {sellerPaid && (
                    <ExpenseLink
                      amountUsd={sellerReported}
                      desc={`Comisión vendedor ${creatorDisplay(creator) || ''} · cot. #${quote.number ?? ''}`.trim()}
                      settings={settings}
                    />
                  )}
                </span>
              ) : (
                <span className="text-[11px] text-ink-400 italic whitespace-nowrap">Tras depósito</span>
              )}
            />
            )}

            {professional && (
              <CommissionLine
                role="Profesional"
                who={professional.name || '—'}
                badge={mode === 'trade_discount' ? 'Trade discount' : 'Comisión'}
                detail={proDetail}
                action={mode === 'trade_discount' ? null : (proPayable ? (
                  <span className="inline-flex items-center gap-1.5">
                    <PaidToggle
                      paid={proPaid}
                      busy={savingPaid === `pro:${quote.id}`}
                      onToggle={(n) => onProPaid(quote.id, n, proAmount)}
                    />
                    {proPaid && (
                      <ExpenseLink
                        amountUsd={proReported}
                        desc={`Comisión profesional ${professional?.name || ''} · cot. #${quote.number ?? ''}`.trim()}
                        settings={settings}
                      />
                    )}
                  </span>
                ) : (
                  <span className="text-[11px] text-ink-400 italic whitespace-nowrap">
                    Tras {quote.orderType === 'special' ? 'balance' : 'depósito'}
                  </span>
                ))}
              />
            )}
          </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Payout → books handoff: once a commission is marked paid, offer Gastos a
 * prefilled expense (DOP at today's effective rate, ITBIS 0 — it's a payout,
 * not a vendor invoice). Booking it stays a human act in Gastos.
 */
function ExpenseLink({ amountUsd, desc, settings }) {
  const rate = effectiveDopRate(settings);
  if (!rate || !(amountUsd > 0)) return null;
  const dop = Math.round(amountUsd * rate * 100) / 100;
  return (
    <Link
      to={`/accounting/expenses?new=1&amount=${dop}&itbis=0&desc=${encodeURIComponent(desc)}`}
      className="btn-ghost text-xs whitespace-nowrap"
      title="Registrar el gasto de esta comisión (monto al tipo de cambio actual)"
    >
      <Receipt size={12} aria-hidden /> Gasto
    </Link>
  );
}

/** One commission row inside a sale card (vendedor or profesional). */
function CommissionLine({ role, who, badge, detail, action }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-ink-100 bg-surface px-3 py-2.5 shadow-xs">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="eyebrow-xs tracking-wide text-ink-400">{role}</span>
          <span className="text-sm font-medium text-ink-800 truncate">{who}</span>
          {badge && (
            <span className={`chip ${
              badge === 'Trade discount' ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-ink-100 text-ink-600'
            }`}>
              {badge}
            </span>
          )}
        </div>
        <div className="text-[11px] text-ink-500 break-words mt-0.5">{detail}</div>
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}

/** Payout rollup card — name, # ventas, comisión, pagado, pendiente. */
function SummaryTable({ title, icon: Icon, rows, keyOf, nameOf, subOf, colsStorageKey, widthsStorageKey }) {
  const pendingTotal = rows.reduce((s, r) => s + r.pending, 0);
  // Column visibility (Shopify "edit columns") — each rollup persists its own
  // choice via its storage key; both share the SUMMARY_COLUMNS definition.
  const {
    visible, setVisible, reset, cols,
  } = useColumns(SUMMARY_COLUMNS, SUMMARY_DEFAULT_COLS, colsStorageKey);
  // Drag-to-resize widths (persisted) — the two rollups render this same
  // component, so each instance gets its OWN widths state via its per-instance
  // widthsStorageKey (mirrors how colsStorageKey isolates their visibility).
  const {
    tableRef, tableStyle, thProps, ResizeHandle, reset: resetWidths,
  } = useColumnWidths(cols, widthsStorageKey);

  // Footer: the "Pendiente total" label spans the leading columns up to the
  // first column carrying a total, then each remaining column renders its
  // total (or an empty cell). Stays coherent as columns toggle.
  const footCtx = { pendingTotal };
  const firstFootIdx = cols.findIndex((c) => typeof c.foot === 'function');
  const labelSpan = firstFootIdx === -1 ? cols.length : firstFootIdx;

  return (
    <section className="card overflow-hidden mt-6">
      <header className="card-header">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={15} className="text-ink-500" />}
          <h2>{title}</h2>
        </div>
        <span className="badge">{rows.length}</span>
      </header>
      <RowCards inCard
        rows={rows.map((r) => ({
          key: keyOf(r),
          title: nameOf(r),
          sub: subOf(r),
          right: formatMoney(r.commission, 'USD', { USD: 1 }),
          kv: [
            ['# ventas', r.count],
            ['Pagado', <span className="text-emerald-700">{formatMoney(r.paid, 'USD', { USD: 1 })}</span>],
            ['Pendiente', <span className="font-medium text-amber-700">{formatMoney(r.pending, 'USD', { USD: 1 })}</span>],
          ],
        }))}
        footer={[['Pendiente total', formatMoney(pendingTotal, 'USD', { USD: 1 })]]}
      />
      <div className="hidden md:block">
        {/* Standalone columns control for this rollup table. */}
        <div className="hidden md:flex justify-end mb-2">
          <ColumnsMenu columns={SUMMARY_COLUMNS} visible={visible} onChange={setVisible} onReset={() => { reset(); resetWidths(); }} />
        </div>
        <div className="overflow-x-auto">
          <table ref={tableRef} style={tableStyle} className="table">
            <thead>
              <tr>
                {cols.map((col) => (
                  <th key={col.key} className={col.thClass || ''} {...thProps(col.key)}>
                    {col.label}
                    {ResizeHandle(col.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ctx = { r, name: nameOf(r), sub: subOf(r) };
                return (
                  <tr key={keyOf(r)} className="hover:bg-ink-50 transition-colors">
                    {cols.map((col) => (
                      <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-ink-50 border-t border-ink-200">
                <td colSpan={labelSpan || 1} className="text-right text-[11px] font-semibold uppercase tracking-wide text-ink-500 py-2 px-4">
                  Pendiente total
                </td>
                {cols.slice(labelSpan).map((col) => (
                  <td key={col.key} className="text-right tabular-nums whitespace-nowrap font-semibold text-amber-700 py-2 px-4">
                    {typeof col.foot === 'function' ? col.foot(footCtx) : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
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
        className="btn text-xs border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 active:bg-emerald-200 disabled:cursor-wait"
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
      className="btn-secondary text-xs disabled:cursor-wait"
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
function QuoteAccountingDetail({ invLines, totals, currency, rates, taxName, onExportCsv }) {
  const fmt = (v) => formatMoney(v, currency, rates);
  return (
    <div className="space-y-3 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="eyebrow font-semibold tracking-wide text-ink-600 min-w-0 truncate">
          Detalle para facturar
        </h3>
        <button type="button" onClick={onExportCsv} className="btn-ghost text-xs shrink-0">
          <Download size={12} /> CSV Odoo
        </button>
      </div>

      <div className="overflow-x-auto rounded-md border border-ink-100 bg-surface shadow-xs">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-ink-500 bg-ink-50 border-b border-ink-100">
              <th className="font-semibold py-1.5 px-2.5 uppercase tracking-wide text-[10px]">Producto</th>
              <th className="font-semibold py-1.5 px-2.5 text-right whitespace-nowrap uppercase tracking-wide text-[10px]">Cant.</th>
              <th className="font-semibold py-1.5 px-2.5 text-right whitespace-nowrap uppercase tracking-wide text-[10px]">Precio unit.</th>
              <th className="font-semibold py-1.5 px-2.5 text-right whitespace-nowrap uppercase tracking-wide text-[10px]">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {invLines.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-center text-ink-400 py-4">
                  Sin líneas facturables
                </td>
              </tr>
            ) : invLines.map((il, i) => (
              <tr key={i} className="border-b border-ink-50 last:border-0 hover:bg-ink-50/60 transition-colors">
                <td className="py-1.5 px-2.5 text-ink-800">{il.name || '—'}</td>
                <td className="py-1.5 px-2.5 text-right tabular-nums text-ink-700">{il.qty}</td>
                <td className="py-1.5 px-2.5 text-right tabular-nums whitespace-nowrap text-ink-700">{fmt(il.unit)}</td>
                <td className="py-1.5 px-2.5 text-right tabular-nums whitespace-nowrap font-medium text-ink-900">{fmt(il.subtotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="w-full sm:ml-auto sm:w-72 text-xs tabular-nums">
        <TotalLine label="Subtotal" value={fmt(totals.subtotal)} />
        {totals.discountAmt > 0 && <TotalLine label="Descuento" value={`–${fmt(totals.discountAmt)}`} />}
        <TotalLine label="Base imponible" value={fmt(totals.taxableBase)} />
        <TotalLine label={`${taxName} (${totals.taxPct}%)`} value={fmt(totals.taxAmt)} />
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

/** A segment of the sales-lens toggle (Ventas del ciclo ↔ Reporte Ligne Roset). */
function LensTab({ active, onClick, icon: Icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors select-none ${
        active
          ? 'bg-surface text-ink-900 shadow-xs'
          : 'text-ink-500 hover:text-ink-800'
      }`}
    >
      <Icon size={14} className={active ? 'text-brand-600' : 'text-ink-400'} aria-hidden />
      {label}
    </button>
  );
}

function CyclePill({ label, sub, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`text-left rounded-md border px-3 py-2 min-h-11 transition-all active:scale-[0.98] select-none ${
        active
          ? 'border-brand-300 bg-brand-50 text-brand-700 shadow-xs'
          : 'border-ink-200 hover:border-ink-300 bg-surface hover:shadow-xs text-ink-700'
      }`}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Calendar size={12} className={active ? 'text-brand-600' : 'text-ink-400'} />
        {label}
      </div>
      <div className={`text-[10px] mt-0.5 tabular-nums ${active ? 'text-brand-600/80' : 'text-ink-500'}`}>{sub}</div>
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

/** Per-sale "Orden de almacén" button — prints the warehouse picking list. */
function WarehouseButton({ warehouse }) {
  return (
    <button
      type="button"
      onClick={warehouse.run}
      disabled={warehouse.busy}
      className="btn-ghost text-xs disabled:opacity-60 disabled:cursor-wait"
      aria-label="Imprimir orden de almacén"
      title="Orden de almacén — lista de preparación (foto · ref · cantidad)"
    >
      {warehouse.busy
        ? <><Loader2 size={12} className="animate-spin" /> Almacén</>
        : <><Warehouse size={12} /> Almacén</>}
    </button>
  );
}

/**
 * Build + deliver the warehouse-order (orden de almacén) PDF for one sale: the
 * price-free picking list the warehouse pulls from (product photo · reference ·
 * name · qty). Mirrors the quote builder's export (resolveWarehouseOrder VM →
 * generateWarehouseOrderPdf), so the accountant can dispatch a sale straight
 * from this screen without reopening the quote. safeDynamicImport recovers a
 * stale-chunk reference the same way the PDF download does.
 */
function useWarehouseDownload({ quote, customer, professional, seller, lines, settings, families }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function run() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const content = resolveWarehouseOrder({ quote, lines, customer, professional, seller });
      if (content.rowCount === 0) {
        throw new Error('La venta no tiene artículos con precio para preparar.');
      }
      const mod = await safeDynamicImport(() => import('../../pdf/order/index.js'));
      const blob = await mod.generateWarehouseOrderPdf({
        content,
        settings,
        lines,
        families,
        currency: quote.currencyCode || 'USD',
        companyName: settings?.companyName || '',
      });
      if (!blob || !blob.size) {
        throw new Error('El PDF generado está vacío; revisa que la venta tenga líneas.');
      }
      const num = quote.number ? `#${quote.number}` : '';
      await mod.downloadBlob(blob, `Orden de almacén ${num}`.trim() + '.pdf');
    } catch (err) {
      console.error('[Contabilidad] warehouse order failed:', err);
      setError(err?.message || 'No se pudo generar la orden de almacén.');
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
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
        () => import('../../pdf/react/index.js'),
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
