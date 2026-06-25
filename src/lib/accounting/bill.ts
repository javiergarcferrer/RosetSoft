/**
 * Line-by-line vendor-bill posting Model — the Odoo-style invoice where each
 * LINE carries its own GL account and its own taxes (ITBIS + retentions). Turns
 * the lines into ONE balanced asiento:
 *
 *   Debit  <each line's account>      Σ line base, merged per account
 *   Debit  ITBIS adelantado           Σ line ITBIS
 *   Credit <suplidores | bank | cash> net = Σbase + Σitbis − Σret
 *   Credit Retención ISR / ITBIS      (only when withheld)
 *
 * Generalizes buildExpenseEntry/buildPurchaseEntry (one account + header tax) to
 * N accounts + per-line tax. The stored doc still carries rolled-up
 * base/itbis/retentions, so the 606 (one row per NCF) is unchanged. Pure: no
 * React, no Supabase.
 */
import { round2, buildJournalEntry, type DraftLine } from './ledger.js';
import { requireAccount, type ResolvedAccountingConfig } from './config.js';
import { applyLineTaxes } from './taxPresets.js';
import type { JournalEntry, JournalLine, JournalSource, PaymentMethod } from '../../types/domain.ts';

function payRole(method: PaymentMethod): string {
  if (method === 'credit') return 'accountsPayable';
  if (method === 'cash') return 'cash';
  return 'bank';
}

/** Raw line as the bill form holds it (qty/price may be empty-string inputs). */
export interface BillLineInput {
  id?: string;
  description?: string;
  accountCode?: string | null;
  qty?: number | string | null;
  unitPrice?: number | string | null;
  /** Per-line discount in money (RD$), applied to the gross. */
  discount?: number | string | null;
  taxIds?: readonly string[] | null;
  itemId?: string | null;
  reference?: string;
}

export interface ResolvedBillLine {
  id: string;
  description: string;
  accountCode: string;
  itemId: string | null;
  reference: string;
  qty: number;
  unitPrice: number;
  /** Gross before discount = qty × unit price. */
  gross: number;
  /** Per-line discount (RD$), clamped to [0, gross]. */
  discount: number;
  /** NET base = gross − discount (taxes + the asiento debit compute on this). */
  base: number;
  itbis: number;
  retIsr: number;
  retItbis: number;
  taxIds: string[];
}

export interface BillTotals {
  base: number; itbis: number; retIsr: number; retItbis: number; total: number; net: number;
}

/**
 * Resolve raw form lines into per-line base + taxes + the invoice totals. A
 * line's base = qty × unit price; its taxes come from applyLineTaxes. Blank rows
 * (no account, no item, no description, no amount) are dropped so a half-filled
 * row is ignored. Pure — the one source the editor preview, the asiento and the
 * stored doc read.
 */
export function resolveBillLines(
  lines: readonly BillLineInput[] | null | undefined,
): { lines: ResolvedBillLine[]; totals: BillTotals } {
  const resolved: ResolvedBillLine[] = (lines || [])
    .map((l) => {
      const qty = round2(Math.max(0, Number(l?.qty) || 0));
      const unitPrice = round2(Math.max(0, Number(l?.unitPrice) || 0));
      const gross = round2(qty * unitPrice);
      const discount = round2(Math.min(Math.max(0, Number(l?.discount) || 0), gross));
      const base = round2(gross - discount);
      const taxIds = ((l?.taxIds || []) as string[]).filter(Boolean);
      const t = applyLineTaxes(base, taxIds);
      return {
        id: l?.id || '',
        description: (l?.description || '').trim(),
        accountCode: l?.accountCode || '',
        itemId: l?.itemId || null,
        reference: (l?.reference || '').trim(),
        qty, unitPrice, gross, discount, base,
        itbis: t.itbis, retIsr: t.retIsr, retItbis: t.retItbis,
        taxIds,
      };
    })
    .filter((l) => l.accountCode || l.itemId || l.description || l.base > 0);

  const sum = (f: (l: ResolvedBillLine) => number) => round2(resolved.reduce((s, l) => s + f(l), 0));
  const base = sum((l) => l.base);
  const itbis = sum((l) => l.itbis);
  const retIsr = sum((l) => l.retIsr);
  const retItbis = sum((l) => l.retItbis);
  return {
    lines: resolved,
    totals: {
      base, itbis, retIsr, retItbis,
      total: round2(base + itbis),
      net: round2(base + itbis - retIsr - retItbis),
    },
  };
}

export interface BillPostInput {
  id: string;
  supplierId?: string | null;
  lines: ReadonlyArray<{ accountCode: string; base: number; itbis: number; retIsr: number; retItbis: number }>;
  paymentMethod: PaymentMethod;
  ncf?: string | null;
  memo?: string;
  /** Where the doc is stored (purchases by default); also the asiento source. */
  source?: JournalSource;
  refTable?: string;
}

/**
 * Build the single balanced asiento for a line bill: one debit per DISTINCT
 * account (line bases merged), the ITBIS credit, the net payable to the
 * supplier/bank, and the retentions. Throws on a line missing its account (it
 * would mis-book) or a bill with no amount. Pure.
 */
export function buildBillEntry({
  newId, config, bill, postedAt,
}: {
  newId: () => string;
  config: ResolvedAccountingConfig;
  bill: BillPostInput;
  postedAt?: number;
}): { entry: JournalEntry; lines: JournalLine[] } {
  const sum = (f: (l: BillPostInput['lines'][number]) => number) =>
    round2(bill.lines.reduce((s, l) => s + f(l), 0));
  const itbis = sum((l) => round2(l.itbis || 0));
  const retIsr = sum((l) => round2(l.retIsr || 0));
  const retItbis = sum((l) => round2(l.retItbis || 0));

  // Debit each distinct account once, with the line bases merged.
  const byAccount = new Map<string, number>();
  for (const l of bill.lines) {
    const amt = round2(Math.max(0, Number(l.base) || 0));
    if (amt <= 0) continue;
    if (!l.accountCode) throw new Error('Cada línea necesita una cuenta de destino.');
    byAccount.set(l.accountCode, round2((byAccount.get(l.accountCode) || 0) + amt));
  }
  if (byAccount.size === 0) throw new Error('La factura no tiene líneas con monto.');
  const base = round2([...byAccount.values()].reduce((s, v) => s + v, 0));
  const net = round2(base + itbis - retIsr - retItbis);

  const draft: DraftLine[] = [];
  for (const [accountCode, amt] of byAccount) draft.push({ accountCode, debit: amt, memo: bill.memo || '' });
  if (itbis > 0) draft.push({ accountCode: requireAccount(config, 'itbisCredit'), debit: itbis, memo: 'ITBIS adelantado' });
  draft.push({
    accountCode: requireAccount(config, payRole(bill.paymentMethod)),
    credit: net,
    thirdPartyType: bill.supplierId ? 'supplier' : null,
    thirdPartyId: bill.supplierId || null,
    ncf: bill.ncf || null,
  });
  if (retIsr > 0) draft.push({ accountCode: requireAccount(config, 'isrWithheld'), credit: retIsr, memo: 'Retención ISR' });
  if (retItbis > 0) draft.push({ accountCode: requireAccount(config, 'itbisWithheld'), credit: retItbis, memo: 'Retención ITBIS' });

  return buildJournalEntry({
    newId,
    postedAt,
    source: bill.source || 'purchase',
    memo: bill.memo || 'Factura de proveedor',
    refTable: bill.refTable || 'purchases',
    refId: bill.id,
    lines: draft,
  });
}
