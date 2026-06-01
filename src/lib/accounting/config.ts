/**
 * Accounting configuration Model — tax parameters + the posting-account map.
 *
 * The posting modules never hard-code chart codes. They ask `accountFor(config,
 * role)` for the account that plays a well-known role ("salesLocal", "itbisPayable",
 * "accountsPayable", …). Defaults below are pre-wired to THIS catálogo's real
 * codes (the advisor's DGII IR-2 plan); the accountant overrides any of them in
 * the Configuración contable page, and the tax rates, without touching code.
 *
 * Business decisions baked as defaults (owner-confirmed): ITBIS 18%, no exempt
 * operations (so input ITBIS is fully creditable), customs duty 20% on
 * merchandise. Retention rates are starting points to confirm with the advisor.
 *
 * Pure: no React, no Supabase.
 */
import type { AccountingConfig } from '../../types/domain.ts';

export interface PostingRole {
  key: string;
  label: string;
  /** Default chart code (a postable leaf in the seeded catálogo). */
  defaultCode: string;
  /** Class grouping, for the settings UI. */
  group: string;
}

/**
 * Well-known roles a posting can reference. `defaultCode` points at the leaf
 * account in the advisor's catálogo that conventionally holds that role.
 */
export const POSTING_ROLES: PostingRole[] = [
  // Activos
  { key: 'cash', label: 'Caja general', defaultCode: '1-01-001-01-01-00', group: 'Activos' },
  { key: 'bank', label: 'Bancos', defaultCode: '1-01-001-02-00-00', group: 'Activos' },
  { key: 'accountsReceivable', label: 'Cuentas por cobrar clientes', defaultCode: '1-01-002-00-00-00', group: 'Activos' },
  { key: 'inventory', label: 'Inventario (productos terminados)', defaultCode: '1-01-005-00-00-00', group: 'Activos' },
  { key: 'goodsInTransit', label: 'Mercancías en tránsito', defaultCode: '1-01-009-00-00-00', group: 'Activos' },
  { key: 'itbisCredit', label: 'ITBIS adelantado en compras', defaultCode: '1-04-002-06-00-00', group: 'Activos' },
  { key: 'isrAdvance', label: 'Anticipo ISR por compensar', defaultCode: '1-04-002-02-00-00', group: 'Activos' },
  // Pasivos
  { key: 'accountsPayable', label: 'Suplidores', defaultCode: '2-01-002-01-00-00', group: 'Pasivos' },
  { key: 'itbisPayable', label: 'ITBIS por pagar', defaultCode: '2-01-003-01-00-00', group: 'Pasivos' },
  { key: 'itbisWithheld', label: 'ITBIS retenido (por pagar)', defaultCode: '2-01-003-02-00-00', group: 'Pasivos' },
  { key: 'isrWithheld', label: 'Retención ISR (IR-17 por pagar)', defaultCode: '2-01-003-07-00-00', group: 'Pasivos' },
  { key: 'customerDeposits', label: 'Cobros anticipados (depósitos)', defaultCode: '2-01-005-00-00-00', group: 'Pasivos' },
  { key: 'payrollPayable', label: 'Nóminas por pagar', defaultCode: '2-01-004-01-00-00', group: 'Pasivos' },
  { key: 'tssPayable', label: 'TSS por pagar', defaultCode: '2-01-003-04-00-00', group: 'Pasivos' },
  { key: 'infotepPayable', label: 'INFOTEP por pagar', defaultCode: '2-01-003-05-00-00', group: 'Pasivos' },
  // Ingresos
  { key: 'salesLocal', label: 'Ventas locales', defaultCode: '4-01-001-01-00-00', group: 'Ingresos' },
  { key: 'salesDiscount', label: 'Descuentos sobre ventas', defaultCode: '4-01-004-00-00-00', group: 'Ingresos' },
  { key: 'fxGain', label: 'Diferencia cambiaria (ganancia)', defaultCode: '4-03-003-00-00-00', group: 'Ingresos' },
  // Costos
  { key: 'costOfSales', label: 'Costo de venta', defaultCode: '5-01-000-00-00-00', group: 'Costos' },
  // Gastos
  { key: 'bankFees', label: 'Cargos y comisiones bancarias', defaultCode: '6-07-010-01-00-00', group: 'Gastos' },
  { key: 'cardCommissions', label: 'Comisiones de tarjetas (pasarela)', defaultCode: '6-07-010-02-01-00', group: 'Gastos' },
  { key: 'fxLoss', label: 'Diferencia cambiaria (pérdida)', defaultCode: '6-08-005-00-00-00', group: 'Gastos' },
  { key: 'salaries', label: 'Salarios y comisiones', defaultCode: '6-01-001-01-00-00', group: 'Gastos' },
  { key: 'employerSS', label: 'Aportes patronales a la seguridad social', defaultCode: '6-01-005-00-00-00', group: 'Gastos' },
  { key: 'employerInfotep', label: 'Aporte patronal al INFOTEP', defaultCode: '6-01-006-00-00-00', group: 'Gastos' },
];

/** Tax-rate defaults (percentages). Owner-confirmed where noted. */
export const TAX_DEFAULTS = {
  itbisRate: 18,                 // ITBIS general
  dutyRate: 20,                  // customs duty on merchandise (owner: 99% of cases)
  retentionIsrServicesRate: 10,  // ISR withheld on services from individuals — confirm
  retentionItbisRate: 30,        // % of ITBIS withheld on services from individuals — confirm
};

/** A fully-resolved config: tax rates + a complete role→code map (no gaps). */
export interface ResolvedAccountingConfig {
  itbisRate: number;
  dutyRate: number;
  retentionIsrServicesRate: number;
  retentionItbisRate: number;
  postingMap: Record<string, string>;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Merge the saved overrides over the code defaults so callers always get a
 * complete, gap-free config (every role resolves to a code, every rate to a
 * number).
 */
export function resolveAccountingConfig(saved: AccountingConfig | null | undefined): ResolvedAccountingConfig {
  const s = saved || {};
  const savedMap = s.postingMap || {};
  const postingMap: Record<string, string> = {};
  for (const r of POSTING_ROLES) postingMap[r.key] = savedMap[r.key] || r.defaultCode;
  return {
    itbisRate: num(s.itbisRate, TAX_DEFAULTS.itbisRate),
    dutyRate: num(s.dutyRate, TAX_DEFAULTS.dutyRate),
    retentionIsrServicesRate: num(s.retentionIsrServicesRate, TAX_DEFAULTS.retentionIsrServicesRate),
    retentionItbisRate: num(s.retentionItbisRate, TAX_DEFAULTS.retentionItbisRate),
    postingMap,
  };
}

/** The account code playing `role` — saved override, else the default. */
export function accountFor(
  config: AccountingConfig | ResolvedAccountingConfig | null | undefined,
  role: string,
): string | null {
  const code = config?.postingMap?.[role];
  if (code) return code;
  return POSTING_ROLES.find((r) => r.key === role)?.defaultCode || null;
}

/** ITBIS amount for a base, at the config's rate. */
export function itbisOn(base: number, config: ResolvedAccountingConfig): number {
  return Math.round(((Number(base) || 0) * config.itbisRate) / 100 * 100) / 100;
}

/** Resolve a posting role to a code, or throw — a missing mapping mis-books. */
export function requireAccount(
  config: AccountingConfig | ResolvedAccountingConfig | null | undefined,
  role: string,
): string {
  const code = accountFor(config, role);
  if (!code) throw new Error(`Cuenta no configurada para el rol "${role}".`);
  return code;
}
