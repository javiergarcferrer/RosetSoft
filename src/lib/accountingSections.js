// Accounting navigation model — cloned from QuickBooks Online's structure:
//   • a set of top-level CENTERS in the sidebar, grouped into scannable BANDS
//     (`band` per center) that follow the importer's trade cycle, so the
//     cluster reads as ~5 groups, not 10 flat rows: Resumen (the overview,
//     leads) → Compras e importación (the DGA inbound supply side) → Ventas y
//     tesorería (the sale + the money in/out) → Fiscal y libros (DGII + books +
//     reports) → Configuración. The sidebar renders each band with its own
//     header + bracket.
//   • each center's pages render as a horizontal secondary tab strip in-page
//     (AccountingSubnav),
//   • a "+ Nuevo" quick-create menu (Clientes / Proveedores / … / Otros)
//     above the nav — QBO's signature create button.
// Importaciones is a first-class center, NOT a Gastos tab: for this business an
// expediente capitalizes inventory (an asset) — it's the supply side of the
// trade cycle, never an expense.
import {
  Gauge, FileText, Receipt, Landmark, Wallet, BookOpen, BarChart3,
  Percent, SlidersHorizontal, Ship, ClipboardList,
} from 'lucide-react';

// Order = on-screen order, grouped by band, following the trade cycle of an
// importer-dealer: bring merchandise in (DGA customs), sell it (DGII e-CF),
// settle the money, then the books. The DGII center isolates ALL Dominican
// fiscal logic (607 · IT-1 · e-CF/comprobantes · 606) behind ONE label, so
// moving DR→PR swaps this one center, not the books.
export const ACCOUNTING_SECTIONS = [
  // ── Resumen ── the accounting home (QBO "Business overview"); leads the nav
  //    and is where every primary entry point lands.
  { key: 'panel', band: 'resumen', label: 'Resumen', icon: Gauge, tabs: [
    { to: '/accounting/dashboard', label: 'Resumen' },
  ] },

  // ── Compras e importación ── the inbound / DGA supply side: the import
  //    expediente (customs landed cost) and every supplier invoice. This is
  //    where merchandise becomes inventory before it can be sold.
  { key: 'importaciones', band: 'compras', label: 'Importaciones', icon: Ship, tabs: [
    { to: '/accounting/importaciones', label: 'Expedientes' },
    { to: '/accounting/importaciones/impuestos', label: 'Impuestos de aduana' },
    { to: '/accounting/importaciones/calculadora', label: 'Calculadora de costos' },
  ] },
  // Compras y gastos — the supplier hub. Every supplier invoice (mercancía,
  // activos, gastos) registers + lists here (filtro por tipo); el 606 (declared
  // from the DGII center) reads them; los Proveedores viven junto a las facturas
  // que se les registran. `extraMatch` mantiene encendido el centro en los paths
  // viejos que ahora renderizan la misma página.
  { key: 'gastos', band: 'compras', label: 'Compras y gastos', icon: Receipt, tabs: [
    { to: '/accounting/compras-gastos', label: 'Compras y gastos' },
    { to: '/accounting/recurrentes', label: 'Recurrentes' },
    { to: '/accounting/suppliers', label: 'Proveedores' },
    { to: '/accounting/proveedor-360', label: 'Proveedor 360' },
  ], extraMatch: ['/accounting/expenses', '/accounting/compras'] },
  { key: 'ordenes', band: 'compras', label: 'Órdenes de compra', icon: ClipboardList, tabs: [
    { to: '/accounting/ordenes-compra', label: 'Órdenes de compra' },
  ] },

  // ── Ventas y tesorería ── the outbound / revenue side: the sale, the bank
  //    (cobros y pagos), and payroll — the money in and out.
  { key: 'ventas', band: 'ventas', label: 'Ventas', icon: FileText, tabs: [
    { to: '/accounting/ventas', label: 'Ventas' },
  ], extraMatch: ['/accounting/ligne-roset'] },
  { key: 'banca', band: 'ventas', label: 'Banca', icon: Landmark, tabs: [
    { to: '/accounting/cuentas', label: 'Cobros y pagos' },
    { to: '/accounting/caja-chica', label: 'Caja chica' },
    { to: '/accounting/planes-de-pago', label: 'Planes de pago' },
    { to: '/accounting/conciliacion', label: 'Conciliación' },
  ] },
  { key: 'nomina', band: 'ventas', label: 'Nómina', icon: Wallet, tabs: [
    { to: '/accounting/nomina', label: 'Nómina' },
    { to: '/accounting/empleados', label: 'Empleados' },
  ] },

  // ── Fiscal y libros ── the back-office / compliance band: Dominican fiscal
  //    filings (DGII), the double-entry books, and the financial reports.
  // The DGII hub (Resumen) shows the ITBIS position and routes to 606/607/IT-1;
  // Facturación issues the 607 + e-CF; Secuencias holds the authorized e-NCF
  // ranges.
  { key: 'dgii', band: 'libros', label: 'DGII', icon: Percent, tabs: [
    { to: '/accounting/impuestos', label: 'Resumen' },
    { to: '/accounting/facturacion', label: '607 · IT-1 · e-CF' },
    { to: '/accounting/ecf', label: 'Secuencias e-NCF' },
    { to: '/accounting/recibidos', label: 'Comprobantes recibidos' },
  ] },
  { key: 'contabilidad', band: 'libros', label: 'Libros', icon: BookOpen, tabs: [
    { to: '/accounting/ledger', label: 'Libro diario / mayor' },
    { to: '/accounting/periodos', label: 'Cierre de período' },
    { to: '/accounting/bitacora', label: 'Bitácora' },
  ] },
  { key: 'informes', band: 'libros', label: 'Informes', icon: BarChart3, tabs: [
    { to: '/accounting/informes', label: 'Informes' },
    { to: '/accounting/statements', label: 'Estados financieros' },
    { to: '/accounting/presupuesto', label: 'Presupuesto' },
    { to: '/accounting/flujo-proyectado', label: 'Flujo proyectado' },
    { to: '/accounting/vistas', label: 'Vistas guardadas' },
  ] },

  // ── Configuración ── label-less footer band.
  { key: 'config', band: 'config', label: 'Configuración contable', icon: SlidersHorizontal, tabs: [
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
    { label: 'Orden de compra', to: '/accounting/ordenes-compra?new=1' },
    { label: 'Gasto recurrente', to: '/accounting/recurrentes?new=1' },
  ] },
  { group: 'Empleados', items: [
    { label: 'Nómina', to: '/accounting/nomina' },
    { label: 'Empleado', to: '/accounting/empleados?new=1' },
  ] },
  { group: 'Otros', items: [
    { label: 'Vale de caja chica', to: '/accounting/caja-chica?new=1' },
    { label: 'Asiento contable', to: '/accounting/ledger?new=1' },
  ] },
];

// The sidebar bands, in on-screen order. `null` label = a label-less band (the
// Resumen lead carries the "Contabilidad" umbrella; the Configuración footer
// needs no header). Each band becomes one `{ label, items }` nav group the
// unified sidebar renders with its own eyebrow + bracket.
const ACCOUNTING_BANDS = [
  { key: 'resumen', label: 'Contabilidad' },
  { key: 'compras', label: 'Compras e importación' },
  { key: 'ventas', label: 'Ventas y tesorería' },
  { key: 'libros', label: 'Fiscal y libros' },
  { key: 'config', label: null },
];

const sectionToNav = (s) => ({
  to: s.tabs[0].to,
  label: s.label,
  icon: s.icon,
  // Routes that light this center in the sidebar — its tabs plus any
  // `extraMatch` (a page reached by a button, not a visible tab, e.g. the
  // Ligne Roset report under Ventas).
  match: [...s.tabs.map((t) => t.to), ...(s.extraMatch || [])],
});

// Flat list of every center — kept for consumers that want the ungrouped set.
export const accountingSectionNav = ACCOUNTING_SECTIONS.map(sectionToNav);

// Banded groups for the unified sidebar: one nav group per band, in band order.
export const accountingSectionGroups = ACCOUNTING_BANDS
  .map((b) => ({
    label: b.label,
    items: ACCOUNTING_SECTIONS.filter((s) => s.band === b.key).map(sectionToNav),
  }))
  .filter((g) => g.items.length > 0);

export function sectionForPath(pathname) {
  return ACCOUNTING_SECTIONS.find((s) => s.tabs.some((t) => t.to === pathname)) || null;
}
