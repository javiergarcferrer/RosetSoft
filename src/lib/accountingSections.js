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

// The sales command screen leads: it's the daily front door (and the
// /accounting landing). The DGII center isolates ALL Dominican fiscal logic
// (607 · IT-1 · e-CF/comprobantes · 606) behind ONE label, so the rest of the
// accounting stays jurisdiction-agnostic — moving DR→PR swaps this one center,
// not the books. Everything below DGII is core Alcover accounting.
export const ACCOUNTING_SECTIONS = [
  { key: 'ventas', label: 'Ventas', icon: FileText, tabs: [
    { to: '/accounting/ventas', label: 'Ventas' },
  ], extraMatch: ['/accounting/ligne-roset'] },
  // DGII — the single "local logic" pane. The hub (Resumen) shows the ITBIS
  // position and routes to 606/607/IT-1; Facturación issues the 607 + e-CF;
  // Secuencias holds the authorized e-NCF ranges. 606 is filed from Gastos but
  // surfaced here through the hub.
  { key: 'dgii', label: 'DGII', icon: Percent, tabs: [
    { to: '/accounting/impuestos', label: 'Resumen' },
    { to: '/accounting/facturacion', label: '607 · IT-1 · e-CF' },
    { to: '/accounting/ecf', label: 'Secuencias e-NCF' },
  ] },
  { key: 'panel', label: 'Panel', icon: Gauge, tabs: [
    { to: '/accounting/dashboard', label: 'Resumen' },
  ] },
  { key: 'importaciones', label: 'Importaciones', icon: Ship, tabs: [
    { to: '/accounting/importaciones', label: 'Expedientes' },
    { to: '/accounting/importaciones/calculadora', label: 'Calculadora de costos' },
  ] },
  // Inventario left Contabilidad — it's a standalone section now (see
  // lib/access.js ADMIN_GROUP) while the accounting engine is in testing.
  // Compras y gastos — the supplier hub. Every supplier invoice (mercancía,
  // activos, gastos) registers + lists here (filtro por tipo); el 606 (tab
  // in-page) las declara todas; y los Proveedores viven junto a las facturas que
  // se les registran. `extraMatch` mantiene encendido el centro en los paths
  // viejos que ahora renderizan la misma página.
  { key: 'gastos', label: 'Compras y gastos', icon: Receipt, tabs: [
    { to: '/accounting/compras-gastos', label: 'Compras y gastos' },
    { to: '/accounting/suppliers', label: 'Proveedores' },
  ], extraMatch: ['/accounting/expenses', '/accounting/compras'] },
  { key: 'banca', label: 'Banca', icon: Landmark, tabs: [
    { to: '/accounting/cuentas', label: 'Cobros y pagos' },
    { to: '/accounting/planes-de-pago', label: 'Planes de pago' },
    { to: '/accounting/conciliacion', label: 'Conciliación' },
  ] },
  { key: 'nomina', label: 'Nómina', icon: Wallet, tabs: [
    { to: '/accounting/nomina', label: 'Nómina' },
    { to: '/accounting/empleados', label: 'Empleados' },
  ] },
  { key: 'informes', label: 'Informes', icon: BarChart3, tabs: [
    { to: '/accounting/informes', label: 'Informes' },
    { to: '/accounting/statements', label: 'Estados financieros' },
  ] },
  { key: 'contabilidad', label: 'Contabilidad', icon: BookOpen, tabs: [
    { to: '/accounting/ledger', label: 'Libro diario / mayor' },
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
    // Front of the sales funnel — the quote precedes the factura. Lands on the
    // draft quote builder (the same target as every "Nueva cotización" button).
    { label: 'Cotización', to: '/quotes/new' },
    { label: 'Factura', to: '/accounting/facturacion' },
    { label: 'Cobro', to: '/accounting/cuentas?new=in' },
  ] },
  { group: 'Importaciones', items: [
    { label: 'Expediente de importación', to: '/accounting/importaciones/nuevo' },
    { label: 'Calculadora de costo en destino', to: '/accounting/importaciones/calculadora' },
  ] },
  { group: 'Proveedores', items: [
    { label: 'Gasto', to: '/accounting/compras-gastos/nuevo?tipo=gasto' },
    { label: 'Compra de mercancía', to: '/accounting/compras-gastos/nuevo?tipo=mercancia' },
    { label: 'Pago', to: '/accounting/cuentas?new=out' },
  ] },
  { group: 'Empleados', items: [
    { label: 'Nómina', to: '/accounting/nomina' },
    { label: 'Empleado', to: '/accounting/empleados?new=1' },
  ] },
  { group: 'Otros', items: [
    { label: 'Asiento contable', to: '/accounting/ledger?new=1' },
  ] },
];

export const accountingSectionNav = ACCOUNTING_SECTIONS.map((s) => ({
  to: s.tabs[0].to,
  label: s.label,
  icon: s.icon,
  // Routes that light this center in the sidebar — its tabs plus any
  // `extraMatch` (a page reached by a button, not a visible tab, e.g. the
  // Ligne Roset report under Ventas).
  match: [...s.tabs.map((t) => t.to), ...(s.extraMatch || [])],
}));

export function sectionForPath(pathname) {
  return ACCOUNTING_SECTIONS.find((s) => s.tabs.some((t) => t.to === pathname)) || null;
}
