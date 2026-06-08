// Accounting PDFs — factura/RFCE e-CF + estado de cuenta. Lazy-loaded via
// safeDynamicImport from the pages (the @react-pdf bundle is heavy). Delivery
// reuses the quote pipeline's downloadBlob / print helpers.
export { generateInvoicePdf, generateStatementPdf } from './generate.js';
export { downloadBlob, printBlob, printInWindow } from '../react/deliver.js';
