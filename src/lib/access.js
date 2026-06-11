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
  MessageCircle,
} from 'lucide-react';
import { accountingSectionNav } from './accountingSections.js';

export const ROLES = ['admin', 'employee', 'accounting', 'team'];

// ── nav building blocks ──────────────────────────────────────────────────
const HOME = { items: [{ to: '/', label: 'Inicio', icon: LayoutDashboard, end: true }] };

const CRM_GROUP = {
  label: 'Ventas',
  items: [
    { to: '/quotes', label: 'Cotizaciones', icon: FileText },
    { to: '/orders', label: 'Pedidos', icon: Package },
    { to: '/chats', label: 'WhatsApp', icon: MessageCircle },
    { to: '/customers', label: 'Clientes', icon: Users },
    { to: '/professionals', label: 'Profesionales', icon: UserSquare2 },
  ],
};

// The bridge surface — commissions sit between a CRM sale and an accounting
// payout, so every role that earns or pays them can reach it.
const COMMISSIONS = { items: [{ to: '/comisiones', label: 'Comisiones', icon: Wallet }] };

const ADMIN_GROUP = {
  label: 'Administración',
  items: [
    { to: '/admin/users', label: 'Usuarios', icon: Shield },
    { to: '/admin/materials', label: 'Materiales', icon: Layers },
    { to: '/admin/catalog', label: 'Catálogos', icon: PackageSearch },
    { to: '/accounting/inventario', label: 'Inventario', icon: Boxes },
  ],
};

const ACCOUNTING_GROUP = { label: 'Contabilidad', items: accountingSectionNav };
const CONFIG = { items: [{ to: '/settings', label: 'Configuración', icon: SettingsIcon }] };

/**
 * The unified sidebar for a role. ONE structure; the role reveals its slice:
 *   • employee   — Inicio + CRM + Comisiones (their own).
 *   • accounting — the Contabilidad centers (commissions live in its Ventas tab).
 *   • admin      — everything, both cores, in one place.
 * `team` is the shared settings row, not a human, so it gets nothing.
 */
export function navForRole(role) {
  if (role === 'accounting') return [{ items: accountingSectionNav }];
  if (role === 'admin') return [HOME, CRM_GROUP, COMMISSIONS, ADMIN_GROUP, ACCOUNTING_GROUP, CONFIG];
  if (role === 'employee') return [HOME, CRM_GROUP, COMMISSIONS];
  return [];
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
