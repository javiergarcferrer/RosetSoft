// Identity & Access — the "limbic system": ONE identity (a profile + role) that
// governs BOTH cores. This is the single source of truth for which modules each
// role may reach, and it drives the unified sidebar. Same login, same person;
// the role decides whether they're working the CRM core, the Accounting core,
// or (as admin) both — never two separate apps.
//
// Cores:
//   • crm        — sales & flexibility (cotizaciones, pedidos, clientes, …)
//   • accounting — security & data integrity (libro, impuestos, nómina, …)
//   • bridge     — shared surfaces where the two cores meet (comisiones)
//   • admin      — org administration + configuración
import {
  LayoutDashboard, Users, UserSquare2, FileText, Package, Wallet,
  Shield, Layers, PackageSearch, Boxes, Settings as SettingsIcon,
  Landmark, Plug, HardDrive, Mail, Sparkles,
} from 'lucide-react';
import TogoIcon from './icons/TogoIcon.jsx';
import WhatsAppIcon from './icons/WhatsAppIcon.jsx';
import InstagramIcon from './icons/InstagramIcon.jsx';
import { accountingSectionGroups } from './accountingSections.js';

export const ROLES = ['admin', 'employee', 'accounting', 'team'];

// ── nav building blocks ──────────────────────────────────────────────────
const HOME = { items: [{ to: '/', label: 'Inicio', icon: LayoutDashboard, end: true }] };

// The CRM "Ventas" group. Togo sits as a peer of Cotizaciones/Pedidos (no longer
// nested). Comisiones — the bridge surface between a CRM sale and an accounting
// payout — lives here too, right after Pedidos. Clientes/Profesionales sit just
// below in their own label-less group (PEOPLE_GROUP) so they read as a separate
// cluster from the sales documents above. The customer CHANNELS (WhatsApp +
// Instagram) live in their own group below, in brand colors.
const CRM_GROUP = {
  label: 'Ventas',
  items: [
    { to: '/quotes', label: 'Cotizaciones', icon: FileText },
    { to: '/togo', label: 'Togo', icon: TogoIcon },
    { to: '/orders', label: 'Pedidos', icon: Package },
    { to: '/comisiones', label: 'Comisiones', icon: Wallet },
  ],
};

// Clientes + Profesionales — a label-less group rendered right under Ventas, so
// the mt-4 gap (and its own bracket) sets the people apart from the sales docs.
const PEOPLE_GROUP = {
  items: [
    { to: '/customers', label: 'Clientes', icon: Users },
    { to: '/professionals', label: 'Profesionales', icon: UserSquare2 },
  ],
};

// The customer channels — WhatsApp + Instagram — grouped together and shown in
// their own brand colors/logos. Admin-only for now (WhatsApp inbox is in
// testing; Instagram Studio is an admin surface).
const CHANNELS_GROUP = {
  label: 'Canales',
  items: [
    { to: '/chats', label: 'WhatsApp', icon: WhatsAppIcon },
    { to: '/marketing', label: 'Instagram', icon: InstagramIcon, match: ['/marketing', '/instagram-studio'] },
    { to: '/estudio-imagenes', label: 'Estudio de imágenes', icon: Sparkles },
    { to: '/gmail', label: 'Gmail', icon: Mail },
  ],
};

// The `children` primitive: a parent item carries sub-items that the sidebar
// reveals (indented) ONLY while that parent's section is open — Layout's
// `isSectionOpen` decides from the route, so the same code path drives
// Catálogos→Materiales and Configuración→Integraciones/Usuarios. No per-section
// open flags. (The Contabilidad expansion stays a labeled group below — it's a
// full workspace nav, not a couple of sub-links.)
const ADMIN_GROUP = {
  label: 'Administración',
  items: [
    {
      to: '/admin/catalog',
      label: 'Catálogos',
      icon: PackageSearch,
      children: [
        { to: '/admin/materials', label: 'Materiales', icon: Layers },
      ],
    },
    {
      to: '/inventario/existencias',
      label: 'Inventario',
      icon: Boxes,
      match: ['/inventario/existencias', '/inventario/lifestylegarden'],
    },
    { to: '/accounting/dashboard', label: 'Contabilidad', icon: Landmark },
    { to: '/drive', label: 'Drive', icon: HardDrive },
  ],
};

// The Contabilidad centers render as several labeled bands that follow the
// trade cycle (Resumen / Compras e importación / Ventas y tesorería / Fiscal y
// libros / Configuración) — `accountingSectionGroups`, spread into the sidebar
// below. The first band's "Contabilidad" label is the umbrella that marks where
// the accounting cluster begins.

// The slice of the CRM an accounting user gets, sitting ABOVE the Contabilidad
// centers in their sidebar: quoting + the clients they quote for. They're not
// sellers (no Togo/Pedidos/Comisiones) — they price the deal and keep the
// books. The quote builder picks/creates a customer inline, so the Clientes
// page is there to manage the full customer record (RNC, address) the invoice
// needs, not as a hard dependency of quoting. Label-less on purpose so the
// cluster doesn't read as a second "Ventas" beside the accounting Ventas center
// just below it.
const ACCOUNTING_SALES_GROUP = {
  items: [
    { to: '/quotes', label: 'Cotizaciones', icon: FileText },
    { to: '/customers', label: 'Clientes', icon: Users },
    { to: '/drive', label: 'Drive', icon: HardDrive },
  ],
};

const CONFIG_GROUP = {
  items: [
    {
      to: '/settings',
      label: 'Configuración',
      icon: SettingsIcon,
      children: [
        { to: '/integraciones', label: 'Integraciones', icon: Plug },
        { to: '/admin/users', label: 'Usuarios', icon: Shield },
      ],
    },
  ],
};

/**
 * The unified sidebar for a role. ONE structure; the role reveals its slice:
 *   • employee   — Inicio + CRM + Comisiones (their own).
 *   • accounting — quoting + clients (ACCOUNTING_SALES_GROUP), then the
 *                  Contabilidad centers below.
 *   • admin      — everything, both cores, in one place.
 * `team` is the shared settings row, not a human, so it gets nothing.
 */
export function navForRole(role, { accountingOpen = true } = {}) {
  if (role === 'accounting') return [ACCOUNTING_SALES_GROUP, ...accountingSectionGroups];
  if (role === 'admin') {
    // Nested children (Materiales, Integraciones, Usuarios) always live in the
    // structure — the sidebar reveals them per-route via the `children`
    // primitive, and GlobalSearch flattens them so every destination stays
    // searchable. Only the Contabilidad workspace nav is route-gated here.
    return [
      HOME, CRM_GROUP, PEOPLE_GROUP, CHANNELS_GROUP, ADMIN_GROUP,
      ...(accountingOpen ? accountingSectionGroups : []),
      CONFIG_GROUP,
    ];
  }
  if (role === 'employee') return [HOME, CRM_GROUP, PEOPLE_GROUP];
  return [];
}

/** Flatten a nav group's items + their `children` — for indexing/search where
 *  the contextual reveal doesn't apply (every destination should be findable). */
export function flattenNavItems(groups) {
  return (groups || []).flatMap((g) => (g.items || []).flatMap((it) => [it, ...(it.children || [])]));
}

/** Whether a role participates in each core (for page-level gates + docs). */
export const CORE_ACCESS = {
  admin: { crm: true, accounting: true, bridge: true, admin: true },
  accounting: { crm: false, accounting: true, bridge: true, admin: false },
  employee: { crm: true, accounting: false, bridge: true, admin: false },
  team: { crm: false, accounting: false, bridge: false, admin: false },
};

export function canUseCore(role, core) {
  return !!CORE_ACCESS[role]?.[core];
}
