import { createContext, useContext } from 'react';

/**
 * Line-mutation actions for the quote editor, served by `Workspace` so the
 * item tree (`LineItemsCard → LineItemList → QuoteLineItem`) doesn't have to
 * thread ~13 handlers through every intermediate layer. This mirrors the
 * `FamiliesContext` escape hatch already used for catalog families — the
 * point is that UI changes (re-nesting cards, splitting a list component)
 * no longer have to re-plumb the logic; a block subscribes to exactly the
 * actions it uses.
 *
 * The value is the bundle of editor actions (already history-wrapped where
 * the original call sites wrapped them):
 *   onChangeLine, onRemoveLine, onDuplicateLine, onReorder,
 *   onToggleOptional, onAddAlternative, onSelectAlternative,
 *   onSeparateFromSet, onUngroup, onJoinSet, onToggleGroupOptional,
 *   onAddSection, onOpenCatalog
 */
export const QuoteActionsContext = createContext(null);

/**
 * Read the editor actions. Throws if used outside the provider so a missing
 * wrapper surfaces immediately in development rather than as a dead button.
 */
export function useQuoteActions() {
  const ctx = useContext(QuoteActionsContext);
  if (!ctx) {
    throw new Error('useQuoteActions must be used within a QuoteActionsContext.Provider');
  }
  return ctx;
}
