import { createContext } from 'react';

/**
 * Catalog families (keyed by SKU root), provided by the quote `Workspace` and
 * read by the line-item editor — `QuoteLineItem`/`GradeFabricRow` resolve a
 * line's family from its reference root to price the material-option deltas.
 *
 * It lives in its own module (rather than inside `QuoteLineItem.jsx`) so the
 * provider and consumers don't have to import a context out of a 1.5k-LOC UI
 * component — the wiring is independent of the presentation.
 */
export const FamiliesContext = createContext(new Map());
