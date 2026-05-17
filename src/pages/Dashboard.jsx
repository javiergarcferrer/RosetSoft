import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Users, Package, ArrowRight } from 'lucide-react';
import { useLiveQuery } from '../db/hooks.js';
import PageHeader from '../components/PageHeader.jsx';
import { useApp } from '../context/AppContext.jsx';
import { db } from '../db/database.js';
import { formatDateTime, formatMoney } from '../lib/format.js';

const STATUS_LABELS = {
  draft: 'Borrador',
  sent: 'Enviada',
  accepted: 'Aceptada',
  declined: 'Rechazada',
  archived: 'Archivada',
};

export default function Dashboard() {
  const { profileId, settings } = useApp();
  const counts = useLiveQuery(async () => ({
    customers: await db.customers.where('profileId').equals(profileId || '').count(),
    quotes: await db.quotes.where('profileId').equals(profileId || '').count(),
    orders: await db.orders.where('profileId').equals(profileId || '').count(),
  }), [profileId], { customers: 0, quotes: 0, orders: 0 });

  const recentQuotes = useLiveQuery(
    () => db.quotes.where('profileId').equals(profileId || '').reverse().sortBy('updatedAt').then((r) => r.slice(0, 6)),
    [profileId],
    []
  );
  const customers = useLiveQuery(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );
  const customersById = useMemo(() => {
    const m = new Map();
    for (const c of customers) m.set(c.id, c);
    return m;
  }, [customers]);

  // Single batch fetch of all quote lines → derive per-quote totals. Replaces
  // the per-row useLiveQuery that ran one round-trip per recent quote.
  const allLines = useLiveQuery(() => db.quoteLines.toArray(), [], []);
  const totalsByQuoteId = useMemo(() => {
    const m = new Map();
    for (const l of allLines) {
      m.set(l.quoteId, (m.get(l.quoteId) || 0) + (l.qty || 0) * (l.unitPrice || 0));
    }
    return m;
  }, [allLines]);

  return (
    <>
      <PageHeader
        title="Inicio"
        subtitle={settings?.companyName || 'Tu empresa'}
        actions={
          <Link to="/quotes/new" className="btn-primary">Nueva cotización</Link>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard icon={FileText} label="Cotizaciones" value={counts.quotes} to="/quotes" />
        <StatCard icon={Users} label="Clientes" value={counts.customers} to="/customers" />
        <StatCard icon={Package} label="Pedidos" value={counts.orders} to="/orders" />
      </div>

      <div className="card mt-6">
        <div className="px-5 py-4 border-b border-ink-100 flex items-center justify-between">
          <h2 className="font-semibold">Cotizaciones recientes</h2>
          <Link to="/quotes" className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1">
            Ver todas <ArrowRight size={12} />
          </Link>
        </div>
        {recentQuotes.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-ink-500">Aún no hay cotizaciones.</div>
        ) : (
          <>
            {/* Mobile: card list */}
            <ul className="md:hidden divide-y divide-ink-100">
              {recentQuotes.map((q) => (
                <RecentQuoteCard
                  key={q.id}
                  q={q}
                  customer={customersById.get(q.customerId)}
                  total={totalsByQuoteId.get(q.id) || 0}
                />
              ))}
            </ul>
            {/* Desktop: table — fluid, low-priority columns hidden at narrow widths */}
            <div className="hidden md:block">
              <table className="table">
                <thead>
                  <tr>
                    <th>Número</th>
                    <th>Cliente</th>
                    <th>Estado</th>
                    <th className="hidden lg:table-cell">Actualizada</th>
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {recentQuotes.map((q) => (
                    <RecentQuoteRow
                      key={q.id}
                      q={q}
                      customer={customersById.get(q.customerId)}
                      total={totalsByQuoteId.get(q.id) || 0}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function StatCard({ icon: Icon, label, value, to }) {
  return (
    <Link to={to} className="card card-pad hover:border-ink-300 transition-colors group">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">{label}</div>
          <div className="text-3xl font-semibold mt-1.5">{value ?? 0}</div>
        </div>
        <div className="w-9 h-9 rounded-md bg-ink-100 group-hover:bg-brand-100 text-ink-600 group-hover:text-brand-600 flex items-center justify-center transition-colors">
          <Icon size={18} />
        </div>
      </div>
    </Link>
  );
}

function RecentQuoteRow({ q, customer, total }) {
  return (
    <tr>
      <td className="whitespace-nowrap"><Link to={`/quotes/${q.id}`} className="font-medium hover:underline">#{q.number || '—'}</Link></td>
      <td className="text-ink-700 truncate max-w-[180px]" title={customer?.name || ''}>{customer?.name || '—'}</td>
      <td><span className="badge">{STATUS_LABELS[q.status] || 'Borrador'}</span></td>
      <td className="hidden lg:table-cell text-ink-500 whitespace-nowrap">{formatDateTime(q.updatedAt)}</td>
      <td className="text-right font-medium whitespace-nowrap">{formatMoney(total, q.currencyCode || 'USD', q.rates || { USD: 1 })}</td>
    </tr>
  );
}

function RecentQuoteCard({ q, customer, total }) {
  return (
    <li>
      <Link to={`/quotes/${q.id}`} className="block px-4 py-3 hover:bg-ink-50">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">#{q.number || '—'}</div>
            <div className="text-xs text-ink-500 truncate">{customer?.name || '—'}</div>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-sm font-medium">{formatMoney(total, q.currencyCode || 'USD', q.rates || { USD: 1 })}</div>
            <div className="text-[10px] text-ink-500">{formatDateTime(q.updatedAt)}</div>
          </div>
        </div>
        <div className="mt-1.5">
          <span className="badge">{STATUS_LABELS[q.status] || 'Borrador'}</span>
        </div>
      </Link>
    </li>
  );
}
