/**
 * Meta Ads payment-receipt EMAIL parser — pure Model.
 *
 * On PayPal/card threshold billing, Meta charges the dealer's payment method
 * whenever spend crosses a limit and emails a receipt per charge. Those emails
 * are the ONLY place the receipt document + the exact charged amount live (the
 * Marketing API exposes spend, never the receipt). This module turns one such
 * email into a structured charge — the heart of the Gmail ingestion path.
 *
 * It runs in the browser tests (here) AND, byte-for-byte mirrored, inside the
 * `meta-receipts` Edge Function (Deno) — the Deno↔Vite wall forbids importing
 * across it, so the extraction is duplicated on purpose and pinned HERE by
 * tests/metaReceiptEmail.test.js. Edit one copy → edit the other.
 *
 * Heuristic by nature (Meta tweaks its templates): conservative — a confident
 * match returns a charge; anything ambiguous returns null and the caller falls
 * back to Marketing-API spend.
 */

export interface MetaEmail {
  subject?: string;
  from?: string;
  /** Plain-text body (preferred for parsing). */
  text?: string;
  /** HTML body (the document we keep; also parsed if text is empty). */
  html?: string;
  /** Internal date of the email (ms) — the charge date. */
  dateMs?: number;
  /** Gmail message id — the stable per-charge identity fallback. */
  messageId?: string;
}

export interface ParsedReceipt {
  /** Charged amount in major units. */
  amount: number;
  /** 'USD' | 'DOP' (the dealer's world). */
  currency: string;
  /** When the charge happened (ms) — the email's internal date. */
  chargedAt: number;
  /** Meta's reference/transaction number, else the Gmail message id. */
  receiptId: string;
}

const lc = (s) => String(s || '').toLowerCase();
/** Strip tags + collapse whitespace so an HTML body parses like text. */
const stripHtml = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();

/** Symbol/code → ISO currency. US$ and a bare $ are the dealer's USD account;
 *  RD$ / DOP is Dominican pesos. */
function currencyOf(token) {
  const t = String(token || '').toUpperCase();
  if (t === 'RD$' || t === 'DOP' || t === 'RD') return 'DOP';
  if (t === 'US$' || t === 'USD' || t === '$') return 'USD';
  return 'USD';
}

/** "1,234.56" → 1234.56 (Meta US receipt format: comma thousands, dot decimal). */
function parseAmount(raw) {
  const n = Number(String(raw || '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/** Is this email actually a Meta ads payment receipt? (sender + intent). */
export function isMetaReceiptEmail(m) {
  const from = lc(m.from);
  const fromMeta = /facebookmail\.com|facebook\.com|meta\.com|metaplatforms/.test(from);
  const body = `${lc(m.subject)} ${lc(m.text) || lc(stripHtml(m.html))}`;
  const aboutPayment = /(payment|receipt|amount billed|amount paid|you paid|recibo|pago|importe facturado|factura)/.test(body);
  const aboutAds = /(ad|ads|anuncio|campaign|campaña|meta|facebook|instagram)/.test(body);
  return fromMeta && aboutPayment && aboutAds;
}

// Labels that precede the figure that matters (the total charged), most
// specific first — English + Spanish across Meta's template variants.
const AMOUNT_LABELS = [
  'amount billed', 'amount paid', 'amount charged', 'you paid', 'total amount', 'total charged',
  'importe facturado', 'importe pagado', 'monto pagado', 'monto facturado', 'total pagado', 'total',
];
// A money token: US$/RD$/$ before the number, or a USD/DOP code after it.
const MONEY = '(US\\$|RD\\$|\\$)\\s?([0-9][0-9.,]*)|([0-9][0-9.,]*)\\s?(USD|DOP|RD\\$)';

/** Pull the charged amount + currency: a labeled total wins; else the largest
 *  money token in the body. Returns null if nothing parses. */
function extractAmount(body) {
  for (const label of AMOUNT_LABELS) {
    const re = new RegExp(`${label}[^0-9A-Za-z]{0,24}(?:${MONEY})`, 'i');
    const m = body.match(re);
    if (m) {
      const sym = m[1] || m[4] || '$';
      const amt = parseAmount(m[2] || m[3]);
      if (amt > 0) return { amount: amt, currency: currencyOf(sym) };
    }
  }
  // No label hit — take the largest money token (the total dwarfs line items).
  let best: { amount: number; currency: string } | null = null;
  const re = new RegExp(MONEY, 'gi');
  let m;
  while ((m = re.exec(body))) {
    const sym = m[1] || m[4] || '$';
    const amt = parseAmount(m[2] || m[3]);
    if (amt > 0 && (!best || amt > best.amount)) best = { amount: amt, currency: currencyOf(sym) };
  }
  return best;
}

const REF_RE = /(?:reference number|payment reference|transaction id|transaction number|n[úu]mero de referencia|referencia)[:#\s]*([A-Z0-9][A-Z0-9-]{5,})/i;

/**
 * Parse one Meta receipt email → a structured charge, or null if it's not a
 * confident receipt. `chargedAt` is the email's internal date; `receiptId`
 * prefers Meta's reference number and falls back to the Gmail message id.
 */
export function parseMetaReceiptEmail(m) {
  if (!isMetaReceiptEmail(m)) return null;
  const body = `${m.subject || ''}\n${m.text || stripHtml(m.html)}`;
  const found = extractAmount(body);
  if (!found || !(found.amount > 0)) return null;
  const ref = body.match(REF_RE)?.[1] || m.messageId || '';
  return {
    amount: found.amount,
    currency: found.currency,
    chargedAt: Number(m.dateMs) || 0,
    receiptId: String(ref),
  };
}

/**
 * Sum a month's parsed charges into one figure for the monthly gasto draft.
 * Currency is taken from the charges (assumed uniform — one ad account, one
 * billing currency); `chargedAt` is the latest charge in the month.
 */
export function sumReceipts(parsed) {
  const list = (parsed || []).filter((p) => p && p.amount > 0);
  if (!list.length) return null;
  const amount = Math.round(list.reduce((s, p) => s + p.amount, 0) * 100) / 100;
  return {
    amount,
    currency: list[0].currency || 'USD',
    chargedAt: Math.max(...list.map((p) => p.chargedAt || 0)),
    count: list.length,
    receiptIds: list.map((p) => p.receiptId).filter(Boolean),
  };
}
