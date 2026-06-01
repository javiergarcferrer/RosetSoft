// Accounting navigation model — QuickBooks-style: a short set of top-level
// SECTIONS for the sidebar, each with its own secondary tabs that render as a
// horizontal strip inside the section (AccountingSubnav). Keeps the sidebar
// short and the depth in-page. The routes themselves are unchanged.
import {
  Gauge, FileText, Receipt, Landmark, Boxes, Wallet, BookOpen, Scale, SlidersHorizontal,
} from 'lucide-react';

export const ACCOUNTING_SECTIONS = [
  { key: 'resumen', label: 'Resumen', icon: Gauge, tabs: [
    { to: '/accounting/dashboard', label: 'Resumen' },
  ] },
  { key: 'ventas', label: 'Ventas', icon: FileText, tabs: [
    { to: '/accounting/facturacion', label: 'Facturación' },
    { to: '/accounting/ecf', label: 'Comprobantes e-NCF' },
    { to: '/accounting', label: 'Ventas y comisiones', end: true },
  ] },
  { key: 'gastos', label: 'Gastos y compras', icon: Receipt, tabs: [
    { to: '/accounting/expenses', label: 'Gastos' },
    { to: '/accounting/compras', label: 'Compras' },
    { to: '/accounting/importaciones', label: 'Importaciones' },
    { to: '/accounting/suppliers', label: 'Proveedores' },
  ] },
  { key: 'banco', label: 'Banco', icon: Landmark, tabs: [
    { to: '/accounting/cuentas', label: 'Cobros y pagos' },
    { to: '/accounting/conciliacion', label: 'Conciliación' },
  ] },
  { key: 'inventario', label: 'Inventario', icon: Boxes, tabs: [
    { to: '/accounting/inventario', label: 'Existencias' },
  ] },
  { key: 'nomina', label: 'Nómina', icon: Wallet, tabs: [
    { to: '/accounting/nomina', label: 'Nómina' },
    { to: '/accounting/empleados', label: 'Empleados' },
  ] },
  { key: 'contabilidad', label: 'Contabilidad', icon: BookOpen, tabs: [
    { to: '/accounting/ledger', label: 'Libro diario / mayor' },
    { to: '/accounting/chart', label: 'Catálogo de cuentas' },
    { to: '/accounting/periodos', label: 'Cierre de período' },
  ] },
  { key: 'reportes', label: 'Reportes', icon: Scale, tabs: [
    { to: '/accounting/statements', label: 'Estados financieros' },
  ] },
  { key: 'config', label: 'Configuración', icon: SlidersHorizontal, tabs: [
    { to: '/accounting/settings', label: 'Configuración contable' },
  ] },
];

/** Sidebar items: one per section, linking to its first tab; `match` lists all
 *  the section's tab paths so the section highlights on any of them. */
export const accountingSectionNav = ACCOUNTING_SECTIONS.map((s) => ({
  to: s.tabs[0].to,
  label: s.label,
  icon: s.icon,
  match: s.tabs.map((t) => t.to),
}));

/** The section that owns a pathname (exact tab match), or null. */
export function sectionForPath(pathname) {
  return ACCOUNTING_SECTIONS.find((s) => s.tabs.some((t) => t.to === pathname)) || null;
}
