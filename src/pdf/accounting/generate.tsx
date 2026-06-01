import { pdf } from '@react-pdf/renderer';
import QRCode from 'qrcode';
import { InvoiceDocument } from './InvoiceDocument.js';
import type { InvoiceDocumentProps } from './InvoiceDocument.js';
import { StatementDocument } from './StatementDocument.js';
import type { StatementDocumentProps } from './StatementDocument.js';
import { registerBrandFonts } from '../react/theme.js';

/**
 * Render a factura/RFCE e-CF to a Blob. If `qrUrl` is given, the DGII timbre QR
 * is rendered to a PNG data URL first (the async step react-pdf can't do
 * mid-layout) and embedded.
 */
export async function generateInvoicePdf(
  props: Omit<InvoiceDocumentProps, 'qrDataUrl'> & { qrUrl?: string },
): Promise<Blob> {
  registerBrandFonts('/fonts');
  let qrDataUrl = '';
  if (props.qrUrl) {
    try { qrDataUrl = await QRCode.toDataURL(props.qrUrl, { margin: 0, width: 180 }); } catch { /* QR optional */ }
  }
  return pdf(<InvoiceDocument {...props} qrDataUrl={qrDataUrl} />).toBlob();
}

export async function generateStatementPdf(props: StatementDocumentProps): Promise<Blob> {
  registerBrandFonts('/fonts');
  return pdf(<StatementDocument {...props} />).toBlob();
}
