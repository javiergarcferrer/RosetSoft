// Accounting navigation model — cloned from QuickBooks Online's structure:
//   • a short set of top-level CENTERS in the sidebar, ordered for an importer:
//     the trade cycle first (Ventas → Importaciones → Inventario), then the
//     money-out centers (Gastos, Banca, Nómina), then fiscal + books + config,
//   • each center's pages render as a horizontal secondary tab strip in-page
//     (AccountingSubnav),
//   • a "+ Nuevo" quick-create menu (Clientes / Proveedores / … / Otros)
//     above the nav — QBO's signature create button.
// Importaciones is a first-class center, NOT a Gastos tab: for this business an
// expediente capitalizes inventory (an asset) — it's the supply side of the
// trade cycle, never an expense.
import {
  Gauge, FileText, Receipt, Landmark, Wallet, BookOpen, BarChart3,
  Percent, SlidersHorizontal, Ship,
} from 'lucide-react';

export const ACCOUNTING_SECTIONS = [
  { key: 'panel', label: 'Panel', icon: Gauge, tabs: [
    { to: '/accounting/dashboard', label: 'Resumen' },
  ] },
  { key: 'ventas', label: 'Ventas', icon: FileText, tabs: [
    { to: '/accounting/facturacion', label: 'Facturación' },
    { to: '/accounting/ecf', label: 'Comprobantes e-NCF' },
    { to: '/accounting/ligne-roset', label: 'Ventas Ligne Roset' },
    { to: '/accounting/ventas', label: 'Ventas y comisiones' },
  ] },
  { key: 'importaciones', label: 'Importaciones', icon: Ship, tabs: [
    { to: '/accounting/importaciones', label: 'Expedientes' },
    { to: '/accounting/importaciones/calculadora', label: 'Calculadora de costos' },
  ] },
  // Inventario left Contabilidad — it's a standalone section now (see
  // lib/access.js ADMIN_GROUP) while the accounting engine is in testing.
  { key: 'gastos', label: 'Gastos', icon: Receipt, tabs: [
    { to: '/accounting/expenses', label: 'Gastos' },
    { to: '/accounting/compras', label: 'Compras' },
    { to: '/accounting/suppliers', label: 'Proveedores' },
  ] },
  { key: 'banca', label: 'Banca', icon: Landmark, tabs: [
    { to: '/accounting/cuentas', label: 'Cobros y pagos' },
    { to: '/accounting/conciliacion', label: 'Conciliación' },
  ] },
  { key: 'nomina', label: 'Nómina', icon: Wallet, tabs: [
    { to: '/accounting/nomina', label: 'Nómina' },
    { to: '/accounting/empleados', label: 'Empleados' },
  ] },
  { key: 'impuestos', label: 'Impuestos', icon: Percent, tabs: [
    { to: '/accounting/impuestos', label: 'Centro de impuestos' },
  ] },
  { key: 'informes', label: 'Informes', icon: BarChart3, tabs: [
    { to: '/accounting/informes', label: 'Informes' },
    { to: '/accounting/statements', label: 'Estados financieros' },
  ] },
  { key: 'contabilidad', label: 'Contabilidad', icon: BookOpen, tabs: [
    { to: '/accounting/ledger', label: 'Libro diario / mayor' },
    { to: '/accounting/chart', label: 'Catálogo de cuentas' },
    { to: '/accounting/periodos', label: 'Cierre de período' },
  ] },
  { key: 'config', label: 'Configuración', icon: SlidersHorizontal, tabs: [
    { to: '/accounting/settings', label: 'Configuración contable' },
  ] },
];

/**
 * QuickBooks-style "+ Nuevo" quick-create menu — grouped create actions. Each
 * links to the page that owns the create flow; `?new=…` auto-opens that page's
 * form so it's a true one-click create.
 */
export const QUICK_CREATE = [
  { group: 'Clientes', items: [
    { label: 'Factura', to: '/accounting/facturacion' },
    { label: 'Cobro', to: '/accounting/cuentas?new=in' },
  ] },
  { group: 'Importaciones', items: [
    { label: 'Expediente de importación', to: '/accounting/importaciones?new=1' },
    { label: 'Calculadora de costo en destino', to: '/accounting/importaciones/calculadora' },
  ] },
  { group: 'Proveedores', items: [
    { label: 'Gasto', to: '/accounting/expenses?new=1' },
    { label: 'Compra', to: '/accounting/compras?new=1' },
    { label: 'Pago', to: '/accounting/cuentas?new=out' },
  ] },
  { group: 'Empleados', items: [
    { label: 'Nómina', to: '/accounting/nomina' },
    { label: 'Empleado', to: '/accounting/empleados?new=1' },
  ] },
  { group: 'Otros', items: [
    { label: 'Asiento contable', to: '/accounting/ledger?new=1' },
    { label: 'Artículo de inventario', to: '/inventario/existencias?new=1' },
    { label: 'Cuenta del catálogo', to: '/accounting/chart' },
  ] },
];

export const accountingSectionNav = ACCOUNTING_SECTIONS.map((s) => ({
  to: s.tabs[0].to,
  label: s.label,
  icon: s.icon,
  match: s.tabs.map((t) => t.to),
}));

export function sectionForPath(pathname) {
  return ACCOUNTING_SECTIONS.find((s) => s.tabs.some((t) => t.to === pathname)) || null;
}
