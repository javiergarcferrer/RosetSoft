// MVVM migration: the canonical quote MUTATION reducer now lives in the quote
// Model (src/core/quote/actions.js) so the optimistic client path and the
// authoritative server path resolve a pick the same way. This thin re-export
// keeps the existing import path (PublicQuoteView, tests) working unchanged.
export { applyAction, applyClientPick } from '../core/quote/actions.js';
