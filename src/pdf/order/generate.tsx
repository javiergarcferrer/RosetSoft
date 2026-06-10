import { pdf } from '@react-pdf/renderer';
import { RegistrationDocument } from './RegistrationDocument.js';
import type { RegistrationDocumentProps } from './RegistrationDocument.js';
import { registerBrandFonts } from '../react/theme.js';

/** Render the Ligne Roset order-registration document to a Blob. */
export async function generateOrderRegistrationPdf(
  props: RegistrationDocumentProps,
): Promise<Blob> {
  registerBrandFonts('/fonts');
  return pdf(<RegistrationDocument {...props} />).toBlob();
}
