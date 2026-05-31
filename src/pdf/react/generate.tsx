import { pdf } from '@react-pdf/renderer';
import { QuoteDocument } from './QuoteDocument.js';
import type { QuoteDocumentProps } from './QuoteDocument.js';
import { registerInterFonts } from './theme.js';
import { resolveQuoteImages } from './images.js';
import type { CurrencyCode } from '../../types/domain.ts';

/**
 * Browser entry: resolve every image up front (the async step react-pdf can't
 * do mid-layout), then render the quote to a Blob for the existing delivery
 * layer (Web Share / anchor download). Same input shape as the legacy
 * `generateQuotePdf`, so callers and `downloadBlob` stay untouched.
 */
export async function generateQuotePdf(
  { publicImages = false, ...props }: QuoteDocumentProps & { publicImages?: boolean },
): Promise<Blob> {
  registerInterFonts('/fonts');
  const images = await resolveQuoteImages({
    settings: props.settings,
    lines: props.lines,
    families: props.families,
    currency: (props.quote.currencyCode || 'USD') as CurrencyCode,
    // The public client link is anonymous → resolve images via public URLs.
    publicUrls: publicImages,
  });
  return pdf(<QuoteDocument {...props} images={images} />).toBlob();
}
