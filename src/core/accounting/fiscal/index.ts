// Fiscal-plugin registry — the single seam where the jurisdiction is chosen.
//
// `activeFiscalPlugin(settings)` is what the engine and the screens call; today
// it returns DGII, but the lookup is by country code, so registering a Puerto
// Rico plugin under 'PR' and flipping `settings.fiscalCountry` re-skins every
// fiscal surface with zero other changes. Unknown/unset → DR (the current
// single-tenant deployment).
import { dgiiPlugin } from './dgii.js';
import type { FiscalPlugin } from './types.js';

export type { FiscalPlugin, FiscalTax, FiscalId, FiscalReceipt, FiscalReport } from './types.js';
export { dgiiPlugin };

/** Every registered jurisdiction, keyed by ISO country code. */
export const FISCAL_PLUGINS: Record<string, FiscalPlugin> = {
  DO: dgiiPlugin,
};

/** The jurisdiction the books currently run under. */
export function activeFiscalPlugin(
  settings?: { fiscalCountry?: string | null } | null,
): FiscalPlugin {
  const code = settings?.fiscalCountry || 'DO';
  return FISCAL_PLUGINS[code] || dgiiPlugin;
}
