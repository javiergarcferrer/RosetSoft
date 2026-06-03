import { createContext } from 'react';

/**
 * Catalog materials (the fabric/leather rows with their colors + grade),
 * provided by the quote `Workspace` and read by `GradeFabricRow`. A pasted or
 * typed fabric that embeds a catalog color code ("… (#code)") is resolved
 * against these via swatchMatch.locateColor to pick up the material's GRADE —
 * so pasting a coded fabric moves the price tier, not just the label/swatch.
 *
 * Lives in its own module (like FamiliesContext) so the provider and consumers
 * don't import a context out of the 2k-LOC line-item component, and so the row
 * doesn't re-query db.materials per line/component (the workspace already holds
 * the list once).
 */
export const MaterialsContext = createContext([]);
