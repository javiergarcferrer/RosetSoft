// The Dominican Republic fiscal plugin (DGII).
//
// Implements the country-agnostic FiscalPlugin contract by delegating to the
// existing DR Models — it does NOT re-derive anything: e-CF types/format and
// the RNC check come from lib/accounting/ecf; the ITBIS rate from the shared
// tax defaults. The 606/607/IT-1 builders keep living in their own modules
// (core/accounting/{dgiiFormats,sales607,expenses}); this plugin only declares
// the filings (label · route · kind) so a View can list them without naming
// DGII. Swapping this plugin out is how the engine moves jurisdictions.
import {
  ECF_TYPES, ecfTypeLabel, saleEcfType, isValidFiscalId,
} from '../../../lib/accounting/ecf.js';
import { TAX_DEFAULTS } from '../../../lib/accounting/config.js';
import type { FiscalPlugin } from './types.js';

/** ITBIS on a base at `rate` — mirrors lib/accounting/config:itbisOn exactly
 *  (round to cents) but takes a bare rate so the engine can ask the plugin for
 *  the tax without resolving a posting config. */
function itbisOn(base: number, rate: number = TAX_DEFAULTS.itbisRate): number {
  return Math.round(((Number(base) || 0) * rate) / 100 * 100) / 100;
}

export const dgiiPlugin: FiscalPlugin = {
  country: 'DO',
  label: 'República Dominicana',
  authority: 'DGII',

  tax: {
    name: 'ITBIS',
    defaultRate: TAX_DEFAULTS.itbisRate, // 18
    on: itbisOn,
  },

  fiscalId: {
    label: 'RNC / Cédula',
    isValid: isValidFiscalId,
  },

  receipt: {
    electronic: true,
    label: 'e-CF',
    types: ECF_TYPES,
    typeLabel: ecfTypeLabel,
    typeForSale: saleEcfType,
  },

  reports: [
    {
      code: '606',
      label: 'Compras y gastos (606)',
      description: 'Comprobantes de proveedores del mes',
      to: '/accounting/expenses?tab=606',
      kind: 'purchases',
      dueDay: 15, // envío 606 vence el 15 del mes siguiente
    },
    {
      code: '607',
      label: 'Ventas (607)',
      description: 'Comprobantes de ventas del mes',
      to: '/accounting/facturacion?tab=607',
      kind: 'sales',
      dueDay: 15, // envío 607 vence el 15 del mes siguiente
    },
    {
      code: 'IT-1',
      label: 'Liquidación de ITBIS (IT-1)',
      description: 'Débito fiscal − crédito fiscal',
      to: '/accounting/facturacion?tab=it1',
      kind: 'liquidation',
      dueDay: 20, // declaración/pago IT-1 vence el 20 del mes siguiente
    },
    {
      code: 'e-CF',
      label: 'Comprobantes e-CF',
      description: 'Emisión / transmisión y secuencias e-NCF',
      to: '/accounting/facturacion?tab=607',
      kind: 'receipt',
    },
  ],
};
