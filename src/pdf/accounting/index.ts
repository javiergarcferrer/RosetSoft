// Accounting PDFs — factura/RFCE e-CF + estado de cuenta. Lazy-loaded via
// safeDynamicImport from the pages (the @react-pdf bundle is heavy). Delivery
// reuses the quote pipeline's downloadBlob.
export { generateInvoicePdf, generateStatementPdf } from './generate.js';
export { downloadBlob } from '../react/deliver.js';
