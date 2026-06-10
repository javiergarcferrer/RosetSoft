import { Link } from 'react-router-dom';
import { Shield, BarChart3, ChevronRight } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';

/**
 * Informes — the reports center (QuickBooks-style): every report grouped by
 * area, each linking to the surface that renders it. Self-gates on
 * accounting/admin.
 */
const GROUPS = [
  { title: 'Resumen del negocio', items: [
    { label: 'Balance General', desc: 'Estado de situación a una fecha', to: '/accounting/statements?tab=balance' },
    { label: 'Estado de Resultados', desc: 'Ingresos, costos y gastos del período', to: '/accounting/statements?tab=income' },
  ] },
  { title: 'Contabilidad', items: [
    { label: 'Balanza de comprobación', desc: 'Saldos por cuenta — debe = haber', to: '/accounting/ledger?tab=balanza' },
    { label: 'Libro mayor', desc: 'Movimientos por cuenta', to: '/accounting/ledger?tab=mayor' },
    { label: 'Libro diario', desc: 'Todos los asientos', to: '/accounting/ledger?tab=diario' },
    { label: 'Catálogo de cuentas', desc: 'El plan de cuentas completo', to: '/accounting/chart' },
  ] },
  { title: 'Ventas y clientes', items: [
    { label: '607 — Ventas', desc: 'Comprobantes de ventas del mes', to: '/accounting/facturacion?tab=607' },
    { label: 'Ventas Ligne Roset', desc: 'Ventas de piso del mes para el proveedor', to: '/accounting/ligne-roset' },
    { label: 'Cuentas por cobrar', desc: 'Antigüedad y estados de cuenta', to: '/accounting/cuentas' },
  ] },
  { title: 'Gastos y proveedores', items: [
    { label: '606 — Compras y gastos', desc: 'Comprobantes de compras del mes', to: '/accounting/expenses?tab=606' },
    { label: 'Cuentas por pagar', desc: 'Antigüedad por proveedor', to: '/accounting/cuentas' },
  ] },
  { title: 'Impuestos', items: [
    { label: 'Liquidación de ITBIS (IT-1)', desc: 'Débito − crédito del mes', to: '/accounting/facturacion?tab=it1' },
    { label: 'Centro de impuestos', desc: '606 · 607 · IT-1 en un lugar', to: '/accounting/impuestos' },
  ] },
  { title: 'Inventario', items: [
    { label: 'Existencias y valuación', desc: 'Kardex y costo promedio', to: '/accounting/inventario' },
  ] },
];

export default function Informes() {
  const { currentProfile } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  if (!allowed) {
    return (
      <>
        <PageHeader title="Informes" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }
  return (
    <>
      <PageHeader title="Informes" subtitle="Todos los reportes contables y fiscales, en un lugar" />
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {GROUPS.map((g) => (
          <div key={g.title} className="card p-4">
            <h2 className="eyebrow font-semibold text-ink-600 mb-2 inline-flex items-center gap-1.5"><BarChart3 size={14} /> {g.title}</h2>
            <div className="divide-y divide-ink-50">
              {g.items.map((it) => (
                <Link key={it.label} to={it.to} className="flex items-center gap-3 py-2 min-h-8 coarse:min-h-11 -mx-2 px-2 rounded-lg group hover:bg-ink-50 active:bg-ink-100 transition-colors">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink-900 group-hover:text-ink-700">{it.label}</div>
                    <div className="text-xs text-ink-500">{it.desc}</div>
                  </div>
                  <ChevronRight size={15} className="text-ink-300 group-hover:text-ink-600 transition-colors" />
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
