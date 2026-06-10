// The order-registration PDF (Registro de pedido · Ligne Roset). Loaded via
// safeDynamicImport from OrderDetail (the @react-pdf bundle is heavy).
// Delivery reuses the shared blob pipeline.
export { generateOrderRegistrationPdf } from './generate.js';
export { downloadBlob } from '../react/deliver.js';
