/**
 * Ligne Roset INVOICE (factura) parser — pure.
 *
 * The Roset commercial invoice lays out, per ORDER (N° Cde) group: an HS code +
 * group total on a header row, then one row per article carrying its quantity,
 * reference, multi-word description (TYPE · MODEL · FABRIC), origin and — the
 * thing we need — the **unit cost in USD (CIP Santo Domingo)**. A piece's
 * identity is REF + FABRIC: the same reference ships in several fabrics at
 * different costs (e.g. 15420000 SILLON TOGO in PHLOX 1488.40, SPORT 1336.49,
 * HARALD 1373.02), so each fabric is its own stock piece.
 *
 * Input is normalized text items `{ x, y, str, page }` (top-down y) — the shape
 * pdfjs and our test fixtures produce — so this module is pure and unit-tested
 * without a PDF engine (mirrors lib/materialsPdf.ts; the browser adapter in
 * lib/loadRosetInvoice.js feeds it real items).
 *
 * Columns are resolved by x band (captured from the real L450 layout):
 *   ORD ~19 · QTY ~84 · REF ~94 · DESC 139..405 (MODEL ~240, FABRIC ≥252) ·
 *   ORIGIN/HS ~415 · UNIT COST 448..496 · GROUP AMOUNT ≥496.
 *
 * Furniture filter ("muebles grandes" = seats + tables): an 8-digit numeric
 * reference whose group HS code is 9401 (seats) or 9403 (other furniture). That
 * cleanly drops accessories (glass/ceramic/lighting/rugs/textiles → other HS)
 * and modular montage parts / kits (alphanumeric refs).
 */

export interface PdfTextItem {
  x: number;
  y: number;
  str: string;
  /** 0-based page. Defaults to 0. */
  page?: number;
}

export interface RosetInvoiceLine {
  /** N° Cde / order number this article belongs to. */
  orderNo: string;
  /** Group HS code (Code NDP). */
  hsCode: string;
  /** Article reference (Ref. No). */
  reference: string;
  quantity: number;
  /** Full désignation: TYPE MODEL FABRIC, single-spaced. */
  description: string;
  /** The fabric/finish part (after the model column) — distinguishes pieces of
   *  the same reference. */
  fabric: string;
  /** Unit cost in USD (CIP), from the Prix unitaire column. */
  unitCostUsd: number;
  /** Origin tag (EU/FR, IN, CH, VN, ID, …) when present. */
  origin: string;
  /** Seats + tables with a proper 8-digit reference. */
  isFurniture: boolean;
}

export interface ParsedInvoice {
  lines: RosetInvoiceLine[];
  /** Convenience: lines.filter((l) => l.isFurniture). */
  furniture: RosetInvoiceLine[];
}

/** Parse a European money string ("1.488,40", "567,29") to a number. */
function money(s: string): number {
  const m = String(s).replace(/[^\d.,]/g, '');
  if (!m) return 0;
  const n = Number(m.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

const ORIGIN_RE = /^[A-Z]{2}(\/[A-Z]{2})?$/; // EU/FR, IN, CH, VN, ID …

/** Group text items into rows (same page, y within tolerance). */
function toRows(items: readonly PdfTextItem[]): PdfTextItem[][] {
  const sorted = [...items].sort(
    (a, b) => (a.page ?? 0) - (b.page ?? 0) || a.y - b.y || a.x - b.x,
  );
  const rows: PdfTextItem[][] = [];
  let cur: PdfTextItem[] | null = null;
  let curPage = -1;
  let curY = -1e9;
  for (const it of sorted) {
    const pg = it.page ?? 0;
    if (!cur || pg !== curPage || Math.abs(it.y - curY) > 3) {
      cur = [];
      rows.push(cur);
      curPage = pg;
      curY = it.y;
    }
    cur.push(it);
  }
  return rows;
}

/**
 * Parse Roset invoice text items into article lines (with the furniture subset).
 */
export function parseRosetInvoice(items: readonly PdfTextItem[]): ParsedInvoice {
  const lines: RosetInvoiceLine[] = [];
  let order = { orderNo: '', hsCode: '' };
  let last: RosetInvoiceLine | null = null;

  for (const row of toRows(items)) {
    const its = row.slice().sort((a, b) => a.x - b.x);
    const band = (lo: number, hi: number) => its.filter((i) => i.x >= lo && i.x < hi);

    const ordCell = band(10, 35).find((i) => /^\d{5,6}$/.test(i.str));
    const qtyCell = band(72, 92).find((i) => /^\d+$/.test(i.str));
    const refCell = band(92, 112)[0];
    const descCells = band(135, 405);

    // Group header: order number, no quantity. Capture the HS code.
    if (ordCell && !qtyCell) {
      const hs = band(405, 448).find((i) => /^\d{6,8}$/.test(i.str))?.str || '';
      order = { orderNo: ordCell.str, hsCode: hs };
      last = null;
      continue;
    }

    // Article row: a quantity AND a reference.
    if (qtyCell && refCell) {
      const description = descCells.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
      const fabric = descCells.filter((i) => i.x >= 252).map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
      const origin = band(405, 448).map((i) => i.str).find((s) => ORIGIN_RE.test(s)) || '';
      const costCell = band(448, 496).find((i) => /\d/.test(i.str));
      const reference = refCell.str.trim();
      const hsCode = order.hsCode;
      const isFurniture = /^\d{8}$/.test(reference) && (hsCode.startsWith('9401') || hsCode.startsWith('9403'));
      const line: RosetInvoiceLine = {
        orderNo: order.orderNo,
        hsCode,
        reference,
        quantity: Number(qtyCell.str) || 0,
        description,
        fabric,
        unitCostUsd: costCell ? money(costCell.str) : 0,
        origin,
        isFurniture,
      };
      lines.push(line);
      last = line;
      continue;
    }

    // Continuation row: only description words → append to the current article.
    if (!ordCell && descCells.length && last) {
      const extra = descCells.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
      if (extra) last.description = `${last.description} ${extra}`.replace(/\s+/g, ' ').trim();
    }
  }

  return { lines, furniture: lines.filter((l) => l.isFurniture) };
}
