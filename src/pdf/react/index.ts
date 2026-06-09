/**
 * The react-pdf quote pipeline — drop-in replacement for the legacy pdf-lib
 * `src/pdf/quotePdf.ts`. Same three exports the callers destructure, so the
 * import path is the only change at the call sites.
 */
export { generateQuotePdf } from './generate.js';
export { quoteFileName, downloadBlob } from './deliver.js';
