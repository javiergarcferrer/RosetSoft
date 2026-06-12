import { pdf } from '@react-pdf/renderer';
import { registerBrandFonts } from '../react/theme.js';
import { resolveCatalogImages } from './images.js';
import { CatalogDocument } from './CatalogDocument.js';
import type { CatalogBook } from './CatalogDocument.js';

/**
 * Browser entry for the LifestyleGarden catalog PDF. Mirrors the quote's
 * generate step: fonts registered, every card photo resolved up front (the
 * async work react-pdf can't do mid-layout), then one render to a Blob for
 * the shared delivery layer (Web Share on touch / anchor download on desktop).
 * The book comes pre-resolved from core/catalog's resolveLsgCatalogBook —
 * in-stock pieces only.
 */
export async function generateLsgCatalogPdf({ book }: { book: CatalogBook }): Promise<Blob> {
  registerBrandFonts('/fonts');
  const images = await resolveCatalogImages(
    book.sections.flatMap((s) => s.models.map((m) => ({ key: m.key, imageId: m.imageId, imageSrc: m.imageSrc }))),
  );
  return pdf(<CatalogDocument book={book} images={images} generatedAt={Date.now()} />).toBlob();
}
