/**
 * Purchase (Compra) posting Model — capitalizes goods into inventory (or hits an
 * asset/expense account), with creditable ITBIS and optional retentions.
 *
 *   Debit  <inventory | asset account>   base
 *   Debit  ITBIS adelantado               itbis
 *   Credit <suplidores | bank | cash>     net = base + itbis − retISR − retITBIS
 *   Credit Retención ISR / ITBIS          (only when we withhold)
 *
 * Mirrors the expense posting but debits the inventory/asset account. A goods
 * purchase also yields a kardex IN (handled by the caller). Pure.
 */
import { round2, buildJournalEntry, type DraftLine } from './ledger.js';
import { requireAccount, type ResolvedAccountingConfig } from './config.js';
import type { JournalEntry, JournalLine, PaymentMethod, PurchaseKind } from '../../types/domain.ts';

function payRole(method: PaymentMethod): string {
  if (method === 'credit') return 'accountsPayable';
  if (method === 'cash') return 'cash';
  return 'bank';
}

/** Raw line as the Compras form holds it (qty/cost may be empty-string inputs). */
export interface PurchaseLineInput {
  id?: string;
  itemId?: string | null;
  name?: string;
  reference?: string;
  qty?: number | string | null;
  cost?: number | string | null;
}

export interface ResolvedPurchaseLine {
  id: string;
  itemId: string | null;
  name: string;
  reference: string;
  qty: number;
  cost: number;
  /** Kardex IN unit cost = cost / qty (4 dp, matching the expediente). */
  unitCost: number;
}

/**
 * Resolve a goods purchase's article lines into the per-line kardex unit cost +
 * the invoice base. Each line's NET `cost` capitalizes into inventory; the
 * invoice `base` the asiento debits is Σ(line cost). Blank lines (no item, no
 * name, no qty, no cost) are dropped so a half-filled form row is ignored.
 * Money is clamped at 0 and rounded to cents; the unit cost keeps 4 dp. Pure —
 * the single source the form preview, the asiento base and the kardex INs read.
 */
export function resolvePurchaseLines(
  lines: readonly PurchaseLineInput[] | null | undefined,
): { lines: ResolvedPurchaseLine[]; base: number; qty: number } {
  const resolved: ResolvedPurchaseLine[] = (lines || [])
    .map((l) => {
      const qty = round2(Math.max(0, Number(l?.qty) || 0));
      const cost = round2(Math.max(0, Number(l?.cost) || 0));
      return {
        id: l?.id || '',
        itemId: l?.itemId || null,
        name: (l?.name || '').trim(),
        reference: (l?.reference || '').trim(),
        qty,
        cost,
        unitCost: qty > 0 ? Math.round((cost / qty) * 10000) / 10000 : 0,
      };
    })
    .filter((l) => l.itemId || l.name || l.qty > 0 || l.cost > 0);
  const base = round2(resolved.reduce((s, l) => s + l.cost, 0));
  const qty = round2(resolved.reduce((s, l) => s + l.qty, 0));
  return { lines: resolved, base, qty };
}

export interface PurchasePostInput {
  id: string;
  supplierId?: string | null;
  kind: PurchaseKind;
  /** Required for asset/service; goods use the configured inventory account. */
  accountCode?: string | null;
  base: number;
  itbis: number;
  retentionIsr?: number;
  retentionItbis?: number;
  paymentMethod: PaymentMethod;
  ncf?: string | null;
  memo?: string;
}

export function buildPurchaseEntry({
  newId, config, purchase, postedAt,
}: {
  newId: () => string;
  config: ResolvedAccountingConfig;
  purchase: PurchasePostInput;
  postedAt?: number;
}): { entry: JournalEntry; lines: JournalLine[] } {
  const base = round2(purchase.base);
  const itbis = round2(purchase.itbis || 0);
  const retIsr = round2(purchase.retentionIsr || 0);
  const retItbis = round2(purchase.retentionItbis || 0);
  const net = round2(base + itbis - retIsr - retItbis);

  const debitAccount = purchase.kind === 'goods'
    ? requireAccount(config, 'inventory')
    : purchase.accountCode;
  if (!debitAccount) throw new Error('La compra necesita una cuenta de destino.');

  const lines: DraftLine[] = [
    { accountCode: debitAccount, debit: base, memo: purchase.memo || '' },
  ];
  if (itbis > 0) lines.push({ accountCode: requireAccount(config, 'itbisCredit'), debit: itbis });
  lines.push({
    accountCode: requireAccount(config, payRole(purchase.paymentMethod)),
    credit: net,
    thirdPartyType: purchase.supplierId ? 'supplier' : null,
    thirdPartyId: purchase.supplierId || null,
    ncf: purchase.ncf || null,
  });
  if (retIsr > 0) lines.push({ accountCode: requireAccount(config, 'isrWithheld'), credit: retIsr });
  if (retItbis > 0) lines.push({ accountCode: requireAccount(config, 'itbisWithheld'), credit: retItbis });

  return buildJournalEntry({
    newId,
    postedAt,
    source: 'purchase',
    memo: purchase.memo || 'Compra',
    refTable: 'purchases',
    refId: purchase.id,
    lines,
  });
}

/**
 * The salida's money plan — validation + COGS at the running average + the
 * post-move on-hand, extracted from the Inventario click handler so the
 * figures that hit the ledger are a pure, testable rule. The caller does the
 * writes (asiento via buildCogsEntry when cost > 0, the OUT movement, the
 * item's qty update).
 */
export function planSalida({ qty, onHand, avgCost }: {
  qty: number | string | null | undefined;
  onHand: number;
  avgCost: number | null | undefined;
}): { ok: boolean; error?: string; qty: number; unitCost: number; cost: number; newQty: number } {
  const q = Number(qty) || 0;
  const avg = Number(avgCost) || 0;
  if (q <= 0) return { ok: false, error: 'Indica una cantidad válida.', qty: q, unitCost: avg, cost: 0, newQty: onHand };
  if (q > onHand) return { ok: false, error: 'No hay suficiente existencia.', qty: q, unitCost: avg, cost: 0, newQty: onHand };
  return { ok: true, qty: q, unitCost: avg, cost: round2(q * avg), newQty: onHand - q };
}

/**
 * Cost-of-sale posting (salida de inventario): Debit Costo de venta / Credit
 * Inventario at the given total cost. Caller also records an OUT kardex movement.
 */
export function buildCogsEntry({
  newId, config, cost, postedAt, refId, memo,
}: {
  newId: () => string;
  config: ResolvedAccountingConfig;
  cost: number;
  postedAt?: number;
  refId?: string | null;
  memo?: string;
}): { entry: JournalEntry; lines: JournalLine[] } {
  const amount = round2(cost);
  if (amount <= 0) throw new Error('El costo de la salida debe ser mayor que cero.');
  return buildJournalEntry({
    newId,
    postedAt,
    source: 'adjustment',
    memo: memo || 'Costo de venta',
    refTable: 'inventory_movements',
    refId: refId || null,
    lines: [
      { accountCode: requireAccount(config, 'costOfSales'), debit: amount },
      { accountCode: requireAccount(config, 'inventory'), credit: amount },
    ],
  });
}
