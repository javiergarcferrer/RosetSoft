// Contract PDF — the per-quote payment-plan contract (terms + amortized
// schedule + signature block). Lazy-loaded via safeDynamicImport from the
// PaymentPlanCard and the public contract link (the @react-pdf bundle is heavy).
// Delivery reuses the quote pipeline's downloadBlob.
export { generateContractPdf } from './generate.js';
export type { ContractDocumentProps, ContractInstallment } from './ContractDocument.js';
export { downloadBlob } from '../react/deliver.js';
