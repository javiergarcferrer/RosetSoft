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
  MessageCircle, Landmark, Instagram, Plug, Sofa,
} from 'lucide-react';
import { accountingSectionNav } from './accountingSections.js';

export const ROLES = ['admin', 'employee', 'accounting', 'team'];

// ── nav building blocks ──────────────────────────────────────────────────
const HOME = { items: [{ to: '/', label: 'Inicio', icon: LayoutDashboard, end: true }] };

// The CRM "Ventas" group. WhatsApp (the inbox) is in admin-only testing for
// now, so the inbox link only joins the group for admins; employees get the
// rest of Ventas without it. Drop the `role` gate on the WhatsApp item once
// testing ends to bring it back for everyone.
function crmGroup(role) {
  return {
    label: 'Ventas',
    items: [
      { to: '/quotes', label: 'Cotizaciones', icon: FileText },
      { to: '/togo', label: 'Configurador Togo', icon: Sofa, sub: true },
      { to: '/orders', label: 'Pedidos', icon: Package },
      ...(role === 'admin' ? [{ to: '/chats', label: 'WhatsApp', icon: MessageCircle }] : []),
      { to: '/customers', label: 'Clientes', icon: Users },
      { to: '/professionals', label: 'Profesionales', icon: UserSquare2 },
    ],
  };
}

// The bridge surface — commissions sit between a CRM sale and an accounting
// payout, so every role that earns or pays them can reach it.
const COMMISSIONS = { items: [{ to: '/comisiones', label: 'Comisiones', icon: Wallet }] };

// The `children` primitive: a parent item carries sub-items that the sidebar
// reveals (indented) ONLY while that parent's section is open — Layout's
// `isSectionOpen` decides from the route, so the same code path drives
// Catálogos→Materiales and Configuración→Integraciones/Usuarios. No per-section
// open flags. (The Contabilidad expansion stays a labeled group below — it's a
// full workspace nav, not a couple of sub-links.)
const ADMIN_GROUP = {
  label: 'Administración',
  items: [
    { to: '/marketing', label: 'Instagram', icon: Instagram, match: ['/marketing', '/instagram-studio'] },
    {
      to: '/inventario/existencias',
      label: 'Inventario',
      icon: Boxes,
      match: ['/inventario/existencias', '/inventario/lifestylegarden'],
    },
    {
      to: '/admin/catalog',
      label: 'Catálogos',
      icon: PackageSearch,
      children: [
        { to: '/admin/materials', label: 'Materiales', icon: Layers },
        { to: '/admin/catalog/togo', label: 'Togo', icon: Sofa },
      ],
    },
    { to: '/accounting/dashboard', label: 'Contabilidad', icon: Landmark },
  ],
};

const ACCOUNTING_GROUP = { label: 'Contabilidad', items: accountingSectionNav };

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
 *   • accounting — the Contabilidad centers (commissions live in its Ventas tab).
 *   • admin      — everything, both cores, in one place.
 * `team` is the shared settings row, not a human, so it gets nothing.
 */
export function navForRole(role, { accountingOpen = true } = {}) {
  if (role === 'accounting') return [{ items: accountingSectionNav }];
  if (role === 'admin') {
    // Nested children (Materiales, Integraciones, Usuarios) always live in the
    // structure — the sidebar reveals them per-route via the `children`
    // primitive, and GlobalSearch flattens them so every destination stays
    // searchable. Only the Contabilidad workspace nav is route-gated here.
    return [
      HOME, crmGroup('admin'), COMMISSIONS, ADMIN_GROUP,
      ...(accountingOpen ? [ACCOUNTING_GROUP] : []),
      CONFIG_GROUP,
    ];
  }
  if (role === 'employee') return [HOME, crmGroup('employee'), COMMISSIONS];
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
