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
