import { pdf } from '@react-pdf/renderer';
import { ContractDocument } from './ContractDocument.js';
import type { ContractDocumentProps } from './ContractDocument.js';
import { registerBrandFonts } from '../react/theme.js';

/**
 * Render a payment-plan contract to a Blob. Same delivery pipeline as the quote
 * PDF (downloadBlob / Web Share). The signature, when present, is embedded from
 * `signature.src` (a data URL at browser signing time, a public image URL when
 * the dealer re-renders an already-signed contract).
 */
export async function generateContractPdf(props: ContractDocumentProps): Promise<Blob> {
  registerBrandFonts('/fonts');
  return pdf(<ContractDocument {...props} />).toBlob();
}
