import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart3, BookOpen, Percent, TrendingUp, Container, Landmark, CalendarClock,
  Bookmark, Search, ChevronRight,
} from 'lucide-react';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';

/**
 * Informes — the reports center (QuickBooks-style): every accounting and
 * fiscal report grouped by area, each deep-linking into the surface (and tab)
 * that renders it. A quick filter narrows the list; "Vistas guardadas" keeps
 * the user's pinned views one tap away. Self-gates on accounting/admin via
 * AccountingGate.
 */
const GROUPS = [
  { title: 'Resumen del negocio', icon: BarChart3, items: [
    { label: 'Panel de contabilidad', desc: 'KPIs, flujo y series de 6 meses', to: '/accounting/dashboard' },
    { label: 'Balance General', desc: 'Estado de situación a una fecha', to: '/accounting/statements?tab=balance' },
    { label: 'Estado de Resultados', desc: 'Ingresos, costos y gastos del período', to: '/accounting/statements?tab=income' },
    { label: 'Flujo de efectivo', desc: 'Movimiento de Cajas y Bancos del período', to: '/accounting/statements?tab=cashflow' },
  ] },
  { title: 'Contabilidad', icon: BookOpen, items: [
    { label: 'Balanza de comprobación', desc: 'Saldos por cuenta — debe = haber', to: '/accounting/ledger?tab=balanza' },
    { label: 'Libro mayor', desc: 'Movimientos por cuenta', to: '/accounting/ledger?tab=mayor' },
    { label: 'Libro diario', desc: 'Todos los asientos', to: '/accounting/ledger?tab=diario' },
    { label: 'Cierre de período', desc: 'Meses bloqueados / abiertos', to: '/accounting/periodos' },
    { label: 'Bitácora', desc: 'Registro inalterable de cambios en los libros', to: '/accounting/bitacora' },
  ] },
  { title: 'Impuestos (DGII)', icon: Percent, items: [
    { label: 'Panel DGII', desc: 'ITBIS del mes y fechas límite de presentación', to: '/accounting/impuestos' },
    { label: '607 — Ventas', desc: 'Comprobantes de ventas + TXT Oficina Virtual', to: '/accounting/facturacion?tab=607' },
    { label: '606 — Compras y gastos', desc: 'Comprobantes de compras + TXT Oficina Virtual', to: '/accounting/compras-gastos?tab=606' },
    { label: 'Liquidación de ITBIS (IT-1)', desc: 'Débito − crédito (local + importación)', to: '/accounting/facturacion?tab=it1' },
    { label: 'Secuencias e-NCF', desc: 'Rangos autorizados por tipo de e-CF', to: '/accounting/ecf' },
  ] },
  { title: 'Ventas y clientes', icon: TrendingUp, items: [
    { label: 'Ventas y comisiones', desc: 'Ciclo de ventas, comisiones por pagar y CSV Odoo', to: '/accounting/ventas' },
    { label: 'Ventas Ligne Roset', desc: 'Ventas de piso del mes para el proveedor', to: '/accounting/ligne-roset' },
    { label: 'Cuentas por cobrar', desc: 'Antigüedad y estados de cuenta', to: '/accounting/cuentas?tab=cxc' },
  ] },
  { title: 'Importaciones e inventario', icon: Container, items: [
    { label: 'Importaciones', desc: 'Expedientes, costo en destino e ITBIS aduanal', to: '/accounting/importaciones' },
    { label: 'Calculadora de costo en destino', desc: 'Simula DGA, flete y margen antes de comprar', to: '/accounting/importaciones/calculadora' },
    { label: 'Existencias y valuación', desc: 'Kardex y costo promedio', to: '/inventario/existencias' },
  ] },
  { title: 'Gastos, banca y nómina', icon: Landmark, items: [
    { label: 'Cuentas por pagar', desc: 'Antigüedad por proveedor', to: '/accounting/cuentas?tab=cxp' },
    { label: 'Conciliación bancaria', desc: 'Movimientos del banco vs. el mayor', to: '/accounting/conciliacion' },
    { label: 'Caja chica', desc: 'Fondo, vales y reposiciones', to: '/accounting/caja-chica' },
    { label: 'Nómina', desc: 'Corridas mensuales — TSS, ISR y neto', to: '/accounting/nomina' },
  ] },
  { title: 'Planificación', icon: CalendarClock, items: [
    { label: 'Presupuesto vs. real', desc: 'Plan anual por cuenta contra el mayor', to: '/accounting/presupuesto' },
    { label: 'Flujo de caja proyectado', desc: 'Proyección a 13 semanas — cobros y pagos', to: '/accounting/flujo-proyectado' },
  ] },
];

export default function Informes() {
  const [q, setQ] = useState('');

  // Filtered view of the fixed catalog — groups with no surviving items drop out.
  const groups = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return GROUPS;
    return GROUPS
      .map((g) => ({
        ...g,
        items: g.items.filter((it) => `${it.label} ${it.desc}`.toLowerCase().includes(query)),
      }))
      .filter((g) => g.items.length > 0);
  }, [q]);

  return (
    <AccountingGate title="Informes">
      <PageHeader
        title="Informes"
        subtitle="Todos los reportes contables y fiscales, en un lugar"
        actions={
          <Link to="/accounting/vistas" className="btn-ghost">
            <Bookmark size={14} /> Vistas guardadas
          </Link>
        }
      />

      <label className="relative block max-w-sm mb-4">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar un informe…"
          aria-label="Buscar un informe"
          className="input w-full pl-9"
        />
      </label>

      {groups.length === 0 ? (
        <EmptyState icon={Search} title="Sin resultados"
          description={`Ningún informe coincide con “${q.trim()}”.`} />
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {groups.map((g) => {
            const Icon = g.icon;
            return (
              <div key={g.title} className="card p-4">
                <h2 className="eyebrow font-semibold text-ink-600 mb-2 inline-flex items-center gap-1.5"><Icon size={14} /> {g.title}</h2>
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
            );
          })}
        </div>
      )}
    </AccountingGate>
  );
}
