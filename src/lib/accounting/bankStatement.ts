/**
 * Bank-statement import Model — parse a bank's exported movements (Banco Popular
 * first), apply deterministic categorization rules, and match each statement
 * line to the bank account's unreconciled ledger lines. Pure: no React, no
 * Supabase.
 *
 * The matcher is the heart of QuickBooks-style reconciliation and designs out
 * its #1 complaint: a downloaded line is MATCHED to an existing asiento (so the
 * books are never double-entered — "Match, never Add a duplicate") when the
 * signed amount agrees and the dates are close; only the leftover (bank fees,
 * interest, charges…) needs a new asiento, which a rule can pre-categorize.
 *
 * Sign convention aligns with the reconciliation VM's `amount = debit − credit`
 * on a bank ASSET account: money IN (crédito/depósito) is +, money OUT
 * (débito/retiro) is −.
 */
import type { BankRule } from '../../types/domain.ts';
import { round2 } from './ledger.js';

export interface BankStatementLine {
  date: number;
  description: string;
  /** Signed: + money in (crédito), − money out (débito). */
  amount: number;
  balance: number | null;
  raw: string;
}

export interface BankProfile {
  key: string;
  label: string;
  date: string[];
  desc: string[];
  debit: string[];
  credit: string[];
  amount: string[];
  balance: string[];
}

const COMMON = {
  date: ['fecha', 'fecha transaccion', 'fecha de transaccion', 'fecha contable', 'fecha efectiva', 'date'],
  desc: ['descripcion', 'concepto', 'detalle', 'transaccion', 'referencia', 'description', 'memo'],
  debit: ['debito', 'debitos', 'cargo', 'cargos', 'retiro', 'retiros', 'debe', 'debit'],
  credit: ['credito', 'creditos', 'abono', 'abonos', 'deposito', 'depositos', 'haber', 'credit'],
  amount: ['monto', 'importe', 'valor', 'amount'],
  balance: ['balance', 'saldo', 'saldo disponible', 'balance disponible', 'saldo contable'],
};

/** Bank import profiles — header aliases per bank. Banco Popular first; the
 *  generic profile lets other banks' CSVs work on a best-effort basis. */
export const BANK_PROFILES: Record<string, BankProfile> = {
  popular: { key: 'popular', label: 'Banco Popular', ...COMMON },
  generic: { key: 'generic', label: 'Genérico', ...COMMON },
};

/** lowercase, strip accents, collapse whitespace — for header/description match. */
export function normalizeText(s: unknown): string {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Parse a DOP amount: handles "1,234.56", "1.234,56", "500,5" (EU one-decimal),
 *  "1.234.567"/"1,234,567" (grouping only), "(1,234.56)" (negative), leading
 *  "RD$"/spaces, and a leading minus. The decimal separator is decided by
 *  position (the later of , and .) and shape (a single separator followed by
 *  1–2 digits is a decimal; anything else — repeated separators, or 3 digits
 *  after — is thousands grouping), so a value is never 10×-off or dropped. */
export function parseAmount(s: unknown): number {
  if (s == null) return 0;
  let t = String(s).trim();
  if (!t) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/[^\d.,\-]/g, '');
  // Leading OR trailing minus ("1,500.00-" is common SAP/LatAm debit notation —
  // stripping it silently would flip a withdrawal into a deposit).
  if (t.startsWith('-') || t.endsWith('-')) neg = true;
  t = t.replace(/-/g, '');

  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the LATER separator is the decimal point, the other grouping.
    if (lastComma > lastDot) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(/,/g, '');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const occurrences = t.split(sep).length - 1;
    const afterLast = t.length - Math.max(lastComma, lastDot) - 1;
    if (occurrences === 1 && afterLast >= 1 && afterLast <= 2) {
      t = t.replace(sep, '.');          // a single separator + 1–2 digits = decimal
    } else {
      t = t.split(sep).join('');        // repeated, or 3 digits after = grouping → strip
    }
  }
  const n = Number(t);
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}

/** Parse a date — DD/MM/YYYY (DR convention), DD-MM-YY, or YYYY-MM-DD → ms. */
export function parseDate(s: unknown): number {
  if (!s) return NaN;
  const t = String(s).trim();
  let m: RegExpMatchArray | null;
  // Reject impossible month/day instead of letting Date.UTC roll them over —
  // a US-format CSV ("12/25/2026" read as dd/mm) must SKIP the row, not parse
  // as a valid-looking date two years out.
  if ((m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
    if (+m[2] > 12 || +m[3] > 31) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }
  if ((m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) {
    if (+m[2] > 12 || +m[1] > 31) return NaN;
    let y = +m[3]; if (y < 100) y += 2000;
    return Date.UTC(y, +m[2] - 1, +m[1]);
  }
  const d = Date.parse(t);
  return Number.isFinite(d) ? d : NaN;
}

function detectDelimiter(text: string): string {
  const head = text.split(/\r?\n/).slice(0, 6).join('\n');
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  for (const ch of head) if (ch in counts) counts[ch]++;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top && top[1] > 0 ? top[0] : ',';
}

function splitLine(line: string, delim: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function findCol(headers: string[], aliases: string[]): number {
  for (let i = 0; i < headers.length; i++) if (aliases.includes(headers[i])) return i;
  for (let i = 0; i < headers.length; i++) if (aliases.some((a) => headers[i].includes(a))) return i;
  return -1;
}

export interface ParsedStatement {
  lines: BankStatementLine[];
  headerRow: number;
  columns: Record<string, number> | null;
  skipped: number;
  bank: string;
}

/** Parse exported statement text (CSV/TSV) into normalized, signed lines. */
export function parseBankStatement(text: string, { bank = 'popular' }: { bank?: string } = {}): ParsedStatement {
  const profile = BANK_PROFILES[bank] || BANK_PROFILES.generic;
  const rawRows = String(text || '').split(/\r?\n/).filter((r) => r.trim() !== '');
  if (!rawRows.length) return { lines: [], headerRow: -1, columns: null, skipped: 0, bank: profile.key };
  const delim = detectDelimiter(text);

  let headerIdx = -1;
  let cols: Record<string, number> | null = null;
  for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
    const cells = splitLine(rawRows[i], delim).map(normalizeText);
    const dateC = findCol(cells, profile.date);
    if (dateC < 0) continue;
    const descC = findCol(cells, profile.desc);
    const debitC = findCol(cells, profile.debit);
    const creditC = findCol(cells, profile.credit);
    const amountC = findCol(cells, profile.amount);
    const balanceC = findCol(cells, profile.balance);
    if (descC >= 0 || amountC >= 0 || debitC >= 0 || creditC >= 0) {
      headerIdx = i; cols = { dateC, descC, debitC, creditC, amountC, balanceC }; break;
    }
  }
  if (headerIdx < 0 || !cols) return { lines: [], headerRow: -1, columns: null, skipped: rawRows.length, bank: profile.key };

  const lines: BankStatementLine[] = [];
  let skipped = 0;
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const cells = splitLine(rawRows[i], delim);
    const date = parseDate(cells[cols.dateC]);
    if (!Number.isFinite(date)) { skipped++; continue; }
    const description = (cols.descC >= 0 ? cells[cols.descC] : '') || '';
    let amount: number;
    if (cols.amountC >= 0 && cols.debitC < 0 && cols.creditC < 0) {
      amount = parseAmount(cells[cols.amountC]);
    } else {
      const debit = cols.debitC >= 0 ? Math.abs(parseAmount(cells[cols.debitC])) : 0;
      const credit = cols.creditC >= 0 ? Math.abs(parseAmount(cells[cols.creditC])) : 0;
      amount = credit - debit;
    }
    if (!amount) { skipped++; continue; }
    const balance = cols.balanceC >= 0 ? parseAmount(cells[cols.balanceC]) : null;
    lines.push({ date, description: description.trim(), amount: round2(amount), balance, raw: rawRows[i] });
  }
  return { lines, headerRow: headerIdx, columns: cols, skipped, bank: profile.key };
}

/* ── deterministic categorization rules ───────────────────────────────────── */

/** Does a rule's pattern match this description (case/accent-insensitive)? */
export function ruleMatches(rule: Pick<BankRule, 'pattern' | 'matchType'>, description: string): boolean {
  const hay = normalizeText(description);
  const needle = normalizeText(rule.pattern);
  if (!needle) return false;
  switch (rule.matchType) {
    case 'equals': return hay === needle;
    case 'startsWith': return hay.startsWith(needle);
    case 'contains':
    default: return hay.includes(needle);
  }
}

/** Highest-priority rule that matches the description, or null. */
export function firstMatchingRule(rules: BankRule[] | null | undefined, description: string): BankRule | null {
  return (rules || [])
    .slice()
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .find((r) => ruleMatches(r, description)) || null;
}

/* ── matcher: statement line ↔ unreconciled ledger line ───────────────────── */

// Both sides are round2'd, so real float noise is ~1e-12 — the epsilon only
// needs to absorb that. 0.01 would silently auto-match lines a full cent OFF
// (a mistyped RD$50.01 cobro against a RD$50.00 deposit), stamping
// reconciledAt on a wrong-amount asiento.
const AMOUNT_EPS = 0.005;

interface LedgerRow { line?: { id?: string; usd?: number | null }; postedAt?: number; amount: number; usd?: number | null; reconciled?: boolean; memo?: string; number?: number | null }

/**
 * The signed ledger amount to compare a statement line against. For a DOP
 * account that's `row.amount` (debit − credit). For a USD account it's the
 * dollar magnitude carrying the row's debit/credit DIRECTION — `|line.usd|`
 * (or the precomputed `row.usd`) signed by `sign(row.amount)` — so a USD
 * statement (in dollars) matches the dollars stored on the line, not the DOP.
 */
function signedLedgerAmount(row: LedgerRow, accountCurrency: 'DOP' | 'USD'): number {
  if (accountCurrency !== 'USD') return row.amount;
  if (typeof row.usd === 'number' && Number.isFinite(row.usd)) return row.usd;
  const usdMag = Math.abs(Number(row.line?.usd) || 0);
  const sign = row.amount < 0 ? -1 : 1;
  return round2(sign * usdMag);
}

export interface MatchItem {
  statementLine: BankStatementLine;
  ledgerRow: LedgerRow | null;
  rule: { id: string; accountCode: string; label: string } | null;
  status: 'matched' | 'suggested' | 'unmatched';
}

/**
 * Match each statement line to an unreconciled ledger row of the SAME signed
 * amount within `toleranceDays`; claim each ledger row at most once. Unmatched
 * lines get a rule suggestion (the contra account to post). Already-reconciled
 * rows cleared before, so they're never re-offered.
 */
export function matchStatementToLedger({
  statementLines, ledgerRows, rules, toleranceDays = 5, accountCurrency = 'DOP',
}: {
  statementLines?: BankStatementLine[];
  ledgerRows?: LedgerRow[];
  rules?: BankRule[];
  toleranceDays?: number;
  accountCurrency?: 'DOP' | 'USD';
} = {}) {
  const tol = toleranceDays * 86400000;
  const pool = (ledgerRows || []).filter((r) => !r.reconciled).map((r) => ({ row: r, claimed: false }));

  const items: MatchItem[] = (statementLines || []).map((sl) => {
    let best: { row: LedgerRow; claimed: boolean } | null = null;
    let bestDelta = Infinity;
    for (const c of pool) {
      if (c.claimed) continue;
      if (Math.abs(signedLedgerAmount(c.row, accountCurrency) - sl.amount) > AMOUNT_EPS) continue;
      const delta = Math.abs((c.row.postedAt || 0) - sl.date);
      if (delta <= tol && delta < bestDelta) { best = c; bestDelta = delta; }
    }
    if (best) {
      best.claimed = true;
      return { statementLine: sl, ledgerRow: best.row, rule: null, status: 'matched' as const };
    }
    const rule = firstMatchingRule(rules, sl.description);
    return {
      statementLine: sl,
      ledgerRow: null,
      rule: rule ? { id: rule.id, accountCode: rule.accountCode, label: rule.label || '' } : null,
      status: (rule ? 'suggested' : 'unmatched') as 'suggested' | 'unmatched',
    };
  });

  const summary = {
    total: items.length,
    matched: items.filter((i) => i.status === 'matched').length,
    suggested: items.filter((i) => i.status === 'suggested').length,
    unmatched: items.filter((i) => i.status === 'unmatched').length,
    statementIn: round2(items.reduce((s, i) => s + (i.statementLine.amount > 0 ? i.statementLine.amount : 0), 0)),
    statementOut: round2(items.reduce((s, i) => s + (i.statementLine.amount < 0 ? -i.statementLine.amount : 0), 0)),
    endingBalance: statementLines && statementLines.length ? statementLines[statementLines.length - 1].balance : null,
  };
  return { items, summary };
}
