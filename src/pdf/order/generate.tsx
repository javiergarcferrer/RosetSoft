import { pdf } from '@react-pdf/renderer';
import { RegistrationDocument } from './RegistrationDocument.js';
import type { RegistrationDocumentProps } from './RegistrationDocument.js';
import { WarehouseOrderDocument } from './WarehouseOrderDocument.js';
import type { WarehouseOrderDocumentProps } from './WarehouseOrderDocument.js';
import { registerBrandFonts } from '../react/theme.js';
import { resolveQuoteImages } from '../react/images.js';
import type { QuoteLine, Settings, CurrencyCode } from '../../types/domain.ts';
import type { CatalogFamily } from '../../lib/catalog.ts';

/** Render the Ligne Roset order-registration document to a Blob. */
export async function generateOrderRegistrationPdf(
  props: RegistrationDocumentProps,
): Promise<Blob> {
  registerBrandFonts('/fonts');
  return pdf(<RegistrationDocument {...props} />).toBlob();
}

/**
 * Render the warehouse-order (orden de almacén) document to a Blob. The picking
 * list carries a product PHOTO per row, so — like the quote PDF — every cover
 * image is resolved to a data URI up front (react-pdf can't await mid-layout)
 * through the shared resolver, keyed by coverKey(lineId). The content
 * (`resolveWarehouseOrder`) and the lines are passed alongside: the content
 * names which photos to draw, the lines feed the resolver.
 */
export async function generateWarehouseOrderPdf({
  content, settings, lines, families, currency,
  companyName, generatedAt,
}: {
  content: Omit<WarehouseOrderDocumentProps, 'images' | 'companyName' | 'generatedAt'>;
  settings: Settings | null | undefined;
  lines: QuoteLine[];
  families?: Map<string, CatalogFamily> | null;
  currency: CurrencyCode;
  companyName: string;
  generatedAt?: number;
}): Promise<Blob> {
  registerBrandFonts('/fonts');
  const images = await resolveQuoteImages({ settings, lines, families, currency });
  return pdf(
    <WarehouseOrderDocument
      {...content}
      companyName={companyName}
      generatedAt={generatedAt}
      images={images}
    />,
  ).toBlob();
}
