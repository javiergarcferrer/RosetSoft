import type { PDFDocument, PDFFont } from 'pdf-lib';
import type {
  Quote,
  Customer,
  Professional,
  Profile,
  Settings,
  RatesMap,
  CurrencyCode,
} from '../types/domain.ts';
import type { CatalogFamily } from '../lib/catalog.ts';

/**
 * Shared rendering context passed to every draw* function in the PDF
 * pipeline. Bundles the pdf-lib `doc` + embedded font handles together
 * with the domain inputs (settings / quote / customer) and the live
 * exchange-rate snapshot (`rates`, `currency`) the renderers use to
 * format money values.
 *
 * Constructed once in `generateQuotePdf` and threaded read-only through
 * the header / lines / totals modules — no draw* function mutates it.
 */
export interface PdfCtx {
  doc: PDFDocument;
  fontRegular: PDFFont;
  fontBold: PDFFont;
  fontItalic: PDFFont;
  settings: Settings;
  quote: Quote;
  customer: Customer | null;
  /** The referring professional (interior designer / architect), if any. */
  professional?: Professional | null;
  /** The seller (profile) who owns/closed the quote — commission attribution. */
  seller?: Profile | null;
  rates: RatesMap;
  currency: CurrencyCode;
  /**
   * Catalog families keyed by SKU root — used to price a line's material
   * options (delta vs. the chosen grade). Optional: surfaces that don't
   * have the catalog loaded (e.g. the accounting workspace) omit it, and
   * the renderer falls back to showing option labels without a delta.
   */
  families?: Map<string, CatalogFamily> | null;
}

/**
 * The drawing cursor passed between renderers — left edge `x` (always
 * MARGIN_L in practice) and the descending `y` baseline where the next
 * block should start. Every draw* function returns an updated Cursor
 * so the next stage knows where to pick up.
 */
export interface Cursor {
  x: number;
  y: number;
}
