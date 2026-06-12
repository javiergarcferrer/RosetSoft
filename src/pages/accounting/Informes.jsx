import { Link } from 'react-router-dom';
import { BarChart3, ChevronRight } from 'lucide-react';
import PageHeader from '../../components/PageHeader.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';

/**
 * Informes — the reports center (QuickBooks-style): every accounting and
 * fiscal report grouped by area, each deep-linking into the surface (and tab)
 * that renders it. Self-gates on accounting/admin via AccountingGate.
 */
const GROUPS = [
  { title: 'Resumen del negocio', items: [
    { label: 'Panel de contabilidad', desc: 'KPIs, flujo y series de 6 meses', to: '/accounting/dashboard' },
    { label: 'Balance General', desc: 'Estado de situación a una fecha', to: '/accounting/statements?tab=balance' },
    { label: 'Estado de Resultados', desc: 'Ingresos, costos y gastos del período', to: '/accounting/statements?tab=income' },
  ] },
  { title: 'Contabilidad', items: [
    { label: 'Balanza de comprobación', desc: 'Saldos por cuenta — debe = haber', to: '/accounting/ledger?tab=balanza' },
    { label: 'Libro mayor', desc: 'Movimientos por cuenta', to: '/accounting/ledger?tab=mayor' },
    { label: 'Libro diario', desc: 'Todos los asientos', to: '/accounting/ledger?tab=diario' },
    { label: 'Catálogo de cuentas', desc: 'El plan de cuentas completo', to: '/accounting/chart' },
    { label: 'Cierre de período', desc: 'Meses bloqueados / abiertos', to: '/accounting/periodos' },
  ] },
  { title: 'Impuestos (DGII)', items: [
    { label: '607 — Ventas', desc: 'Comprobantes de ventas + TXT Oficina Virtual', to: '/accounting/facturacion?tab=607' },
    { label: '606 — Compras y gastos', desc: 'Comprobantes de compras + TXT Oficina Virtual', to: '/accounting/expenses?tab=606' },
    { label: 'Liquidación de ITBIS (IT-1)', desc: 'Débito − crédito (local + importación)', to: '/accounting/facturacion?tab=it1' },
    { label: 'Secuencias e-NCF', desc: 'Rangos autorizados por tipo de e-CF', to: '/accounting/ecf' },
  ] },
  { title: 'Ventas y clientes', items: [
    { label: 'Ventas y comisiones', desc: 'Ciclo de ventas, comisiones por pagar y CSV Odoo', to: '/accounting/ventas' },
    { label: 'Ventas Ligne Roset', desc: 'Ventas de piso del mes para el proveedor', to: '/accounting/ligne-roset' },
    { label: 'Cuentas por cobrar', desc: 'Antigüedad y estados de cuenta', to: '/accounting/cuentas?tab=cxc' },
  ] },
  { title: 'Importaciones e inventario', items: [
    { label: 'Importaciones', desc: 'Expedientes, costo en destino e ITBIS aduanal', to: '/accounting/importaciones' },
    { label: 'Existencias y valuación', desc: 'Kardex y costo promedio', to: '/accounting/inventario' },
  ] },
  { title: 'Gastos, banca y nómina', items: [
    { label: 'Cuentas por pagar', desc: 'Antigüedad por proveedor', to: '/accounting/cuentas?tab=cxp' },
    { label: 'Conciliación bancaria', desc: 'Movimientos del banco vs. el mayor', to: '/accounting/conciliacion' },
    { label: 'Nómina', desc: 'Corridas mensuales — TSS, ISR y neto', to: '/accounting/nomina' },
  ] },
];

export default function Informes() {
  return (
    <AccountingGate title="Informes">
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
    </AccountingGate>
  );
}
