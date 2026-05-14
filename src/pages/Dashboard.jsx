import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Sofa, Palette, Users, ArrowRight, Upload } from 'lucide-react';
import { useLiveQuery } from '../db/hooks.js';
import PageHeader from '../components/PageHeader.jsx';
import { useApp } from '../context/AppContext.jsx';
import { db } from '../db/database.js';
import { formatDateTime, formatMoney } from '../lib/format.js';

export default function Dashboard() {
  const { profileId, settings } = useApp();
  const counts = useLiveQuery(async () => ({
    products: await db.products.count(),
    materials: await db.materials.count(),
    customers: await db.customers.where('profileId').equals(profileId || '').count(),
    quotes: await db.quotes.where('profileId').equals(profileId || '').count(),
  }), [profileId], { products: 0, materials: 0, customers: 0, quotes: 0 });

  const recentQuotes = useLiveQuery(
    () => db.quotes.where('profileId').equals(profileId || '').reverse().sortBy('updatedAt').then((r) => r.slice(0, 6)),
    [profileId],
    []
  );

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`${settings?.companyName || 'Your Company'} · ${counts.products} products · ${counts.materials} materials`}
        actions={
          <>
            <Link to="/import" className="btn-secondary"><Upload size={14} /> Import PDF</Link>
            <Link to="/quotes/new" className="btn-primary">New quote</Link>
          </>
        }
      />

      <div className="grid grid-cols-4 gap-4">
        <StatCard icon={Sofa} label="Products" value={counts.products} to="/catalog" />
        <StatCard icon={Palette} label="Materials" value={counts.materials} to="/materials" />
        <StatCard icon={Users} label="Customers" value={counts.customers} to="/customers" />
        <StatCard icon={FileText} label="Quotes" value={counts.quotes} to="/quotes" />
      </div>

      <div className="card mt-6">
        <div className="px-5 py-4 border-b border-ink-100 flex items-center justify-between">
          <h2 className="font-semibold">Recent quotes</h2>
          <Link to="/quotes" className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1">
            See all <ArrowRight size={12} />
          </Link>
        </div>
        {recentQuotes.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-ink-500">No quotes yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Customer</th>
                <th>Status</th>
                <th>Updated</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {recentQuotes.map((q) => (
                <RecentQuoteRow key={q.id} q={q} />
              ))}
            </tbody>
          </table>
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

function RecentQuoteRow({ q }) {
  const customer = useLiveQuery(() => (q.customerId ? db.customers.get(q.customerId) : null), [q.customerId], null);
  const total = useLiveQuery(async () => {
    const lines = await db.quoteLines.where('quoteId').equals(q.id).toArray();
    return lines.reduce((acc, l) => acc + (l.qty || 0) * (l.unitPrice || 0), 0);
  }, [q.id], 0);
  return (
    <tr>
      <td><Link to={`/quotes/${q.id}`} className="font-medium hover:underline">#{q.number || '—'}</Link></td>
      <td className="text-ink-700">{customer?.name || '—'}</td>
      <td><span className="badge capitalize">{q.status || 'draft'}</span></td>
      <td className="text-ink-500">{formatDateTime(q.updatedAt)}</td>
      <td className="text-right font-medium">{formatMoney(total, q.currencyCode || 'USD', q.rates || { USD: 1 })}</td>
    </tr>
  );
}
