import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Download, Users as UsersIcon, FileCheck, Wallet, Shield, ArrowRight, Loader2,
} from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import { downloadCsv } from '../../lib/csv.js';
import {
  computeTotals, applyLineAdjustments, lineForTotals,
  isCompoundLine,
} from '../../lib/pricing.js';
import { isPricedLine, QUOTE_STATUS_ACCEPTED } from '../../lib/constants.js';
import { cycleEnding, isoDate, clampPct } from '../../lib/commissionCycle.js';

/**
 * One-stop Odoo CSV exporter. Three sections, each a card:
 *
 *   • Clientes      → res.partner-shaped CSV
 *   • Facturas      → one row per line of every accepted cotización
 *   • Comisiones    → same export as /accounting/commissions but
 *                     reachable from here too
 *
 * The integration is intentionally manual: Contabilidad downloads
 * these files when they're ready to push, then imports them through
 * Odoo's standard CSV import. We don't keep state, we don't sync, we
 * don't store credentials.
 */
export default function OdooExport() {
  const { profileId, currentProfile, profiles } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';

  const customersQ = useLiveQueryStatus(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const quotesQ = useLiveQueryStatus(
    () => db.quotes.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const linesQ = useLiveQueryStatus(() => db.quoteLines.toArray(), [], []);

  const customerById = useMemo(() => {
    const m = new Map();
    for (const c of customersQ.data) m.set(c.id, c);
    return m;
  }, [customersQ.data]);

  const linesByQuote = useMemo(() => {
    const m = new Map();
    for (const ln of linesQ.data) {
      if (!m.has(ln.quoteId)) m.set(ln.quoteId, []);
      m.get(ln.quoteId).push(ln);
    }
    return m;
  }, [linesQ.data]);

  const acceptedCount = useMemo(
    () => quotesQ.data.filter((q) => q.status === QUOTE_STATUS_ACCEPTED).length,
    [quotesQ.data],
  );

  const [busy, setBusy] = useState(null); // 'customers' | 'invoices' | 'commissions' | null

  function withBusy(key, fn) {
    return async () => {
      if (busy) return;
      setBusy(key);
      try { await fn(); } finally { setBusy(null); }
    };
  }

  const today = isoDate(Date.now());

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
        // taxId field doesn't exist on the customer schema — leave the
        // VAT column empty so Contabilidad can fill it in Odoo.
        c.taxId || '',
        c.notes || '',
      ]);
    }
    downloadCsv(`odoo-clientes-${today}.csv`, rows);
  }

  async function exportInvoices() {
    const header = [
      'partner_name',
      'invoice_date',
      'quote_number',
      'product_name',
      'qty',
      'price_unit',
      'price_subtotal',
      'currency',
      'status',
    ];
    const rows = [header];
    const accepted = quotesQ.data.filter((q) => q.status === QUOTE_STATUS_ACCEPTED);
    for (const q of accepted) {
      const customer = q.customerId ? customerById.get(q.customerId) : null;
      const partnerName = customer
        ? (customer.company || customer.name || '')
        : '';
      const invoiceDate = q.acceptedAt ? isoDate(q.acceptedAt) : '';
      const currency = q.currencyCode || 'USD';
      // applyLineAdjustments() is the same per-line math computeTotals
      // uses internally — keeps the per-line subtotal here consistent
      // with the grand total Contabilidad sees elsewhere in the app.
      // For compound lines (one family + several priced components) we
      // emit one CSV row per component so Odoo books each priced item
      // as its own invoice line, with the line-level margin/discount
      // applied uniformly across components.
      const itemLines = (linesByQuote.get(q.id) || [])
        .filter(isPricedLine)
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      for (const l of itemLines) {
        if (isCompoundLine(l)) {
          const familyName = (l.name || '').trim();
          for (const c of l.components || []) {
            const unit = applyLineAdjustments(c.unitPrice, l.lineMarginPct, l.lineDiscountPct);
            const qty = Number(c.qty) || 0;
            const subtotal = unit * qty;
            const componentName = [c.name, c.reference, c.dimensions]
              .map((s) => (s || '').trim())
              .filter(Boolean)
              .join(' · ');
            const productName = familyName
              ? `${familyName} — ${componentName}`
              : componentName;
            rows.push([
              partnerName,
              invoiceDate,
              q.number != null ? String(q.number) : '',
              productName,
              qty,
              unit.toFixed(2),
              subtotal.toFixed(2),
              currency,
              q.status,
            ]);
          }
        } else {
          const unit = applyLineAdjustments(l.unitPrice, l.lineMarginPct, l.lineDiscountPct);
          const qty = Number(l.qty) || 0;
          const subtotal = unit * qty;
          const productName = [l.name, l.reference, l.dimensions]
            .map((s) => (s || '').trim())
            .filter(Boolean)
            .join(' · ');
          rows.push([
            partnerName,
            invoiceDate,
            q.number != null ? String(q.number) : '',
            productName,
            qty,
            unit.toFixed(2),
            subtotal.toFixed(2),
            currency,
            q.status,
          ]);
        }
      }
    }
    downloadCsv(`odoo-facturas-${today}.csv`, rows);
  }

  async function exportCommissions() {
    const profilesById = new Map();
    for (const p of profiles) profilesById.set(p.id, p);

    // Default to the current cycle — same window the /accounting/commissions
    // page exports when opened with no override. If Contabilidad wants a
    // different range, the dedicated page has the picker.
    const cycle = cycleEnding(new Date(), 0);
    const cycleStartIso = isoDate(cycle.start);
    const cycleEndIso   = isoDate(cycle.end);

    function totalsFor(q) {
      const rows = (linesByQuote.get(q.id) || [])
        .filter(isPricedLine)
        .map(lineForTotals);
      const t = computeTotals(rows, q);
      return { base: t.taxableBase, grandTotal: t.grandTotal };
    }

    const header = [
      'cycle_start',
      'cycle_end',
      'employee_name',
      'employee_email',
      'quote_number',
      'customer',
      'deposit_date',
      'base_imponible_usd',
      'grand_total_usd',
      'commission_pct',
      'commission_amount_usd',
    ];
    const rows = [header];
    for (const q of quotesQ.data) {
      if (!q.depositReceivedAt) continue;
      if (q.depositReceivedAt < cycle.start || q.depositReceivedAt > cycle.end) continue;
      if (!q.createdByUserId) continue;
      const user = profilesById.get(q.createdByUserId);
      if (!user) continue;
      const { base, grandTotal } = totalsFor(q);
      const pct = clampPct(user.commissionPct);
      const commission = base * (pct / 100);
      const customer = q.customerId ? customerById.get(q.customerId) : null;
      rows.push([
        cycleStartIso,
        cycleEndIso,
        user.name || '',
        user.email || '',
        q.number != null ? String(q.number) : '',
        customer ? (customer.company || customer.name || '') : '',
        isoDate(q.depositReceivedAt),
        base.toFixed(2),
        grandTotal.toFixed(2),
        pct,
        commission.toFixed(2),
      ]);
    }
    downloadCsv(`comisiones-${cycleStartIso}-a-${cycleEndIso}.csv`, rows);
  }

  if (!allowed) {
    return (
      <>
        <PageHeader title="Exportar a Odoo" subtitle=" " />
        <EmptyState
          icon={Shield}
          title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página."
        />
      </>
    );
  }

  const customerCount = customersQ.data.length;
  const loaded = customersQ.loaded && quotesQ.loaded && linesQ.loaded;

  return (
    <>
      <PageHeader title="Exportar a Odoo" subtitle="Clientes, facturas y comisiones en CSV" />

      <p className="text-sm text-ink-600 mb-5 max-w-2xl">
        Estos archivos son CSV listos para importar en Odoo (Contactos /
        Facturación / Diarios). Descárgalos cuando los necesites — no se
        sincronizan automáticamente.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ExportCard
          icon={UsersIcon}
          title="Clientes"
          description="Todos los clientes del sistema, en el formato de res.partner."
          hint={loaded
            ? `${customerCount} ${customerCount === 1 ? 'cliente' : 'clientes'} en el archivo`
            : 'Cargando…'}
          fileLabel={`odoo-clientes-${today}.csv`}
          busy={busy === 'customers'}
          disabled={!loaded || customerCount === 0}
          onExport={withBusy('customers', exportCustomers)}
        />
        <ExportCard
          icon={FileCheck}
          title="Facturas (cotizaciones aceptadas)"
          description="Una fila por línea de cotización aceptada — importa como apuntes de factura."
          hint={loaded
            ? `${acceptedCount} ${acceptedCount === 1 ? 'cotización aceptada' : 'cotizaciones aceptadas'}`
            : 'Cargando…'}
          fileLabel={`odoo-facturas-${today}.csv`}
          busy={busy === 'invoices'}
          disabled={!loaded || acceptedCount === 0}
          onExport={withBusy('invoices', exportInvoices)}
        />
        <ExportCard
          icon={Wallet}
          title="Comisiones del ciclo"
          description="Comisiones por pagar del ciclo activo — mismo CSV que la página de comisiones."
          hint={
            <Link to="/accounting/commissions" className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1">
              Cambiar ciclo en la página de comisiones <ArrowRight size={11} />
            </Link>
          }
          fileLabel={`comisiones-<ciclo>.csv`}
          busy={busy === 'commissions'}
          disabled={!loaded}
          onExport={withBusy('commissions', exportCommissions)}
        />
      </div>
    </>
  );
}

function ExportCard({ icon: Icon, title, description, hint, fileLabel, busy, disabled, onExport }) {
  return (
    <section className="card card-pad flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-md bg-ink-100 text-ink-700 flex items-center justify-center flex-shrink-0">
          <Icon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-sm">{title}</h2>
          <p className="text-xs text-ink-500 mt-0.5">{description}</p>
        </div>
      </div>
      <div className="text-[11px] text-ink-500">
        {typeof hint === 'string' ? hint : hint}
      </div>
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-ink-100">
        <code className="text-[10px] text-ink-400 truncate" title={fileLabel}>{fileLabel}</code>
        <button
          type="button"
          onClick={onExport}
          disabled={disabled || busy}
          className="btn-primary text-xs disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy
            ? <><Loader2 size={12} className="animate-spin" /> Generando…</>
            : <><Download size={12} /> Descargar CSV</>}
        </button>
      </div>
    </section>
  );
}
