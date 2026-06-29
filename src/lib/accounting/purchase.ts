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
import { round2, round4, buildJournalEntry, type DraftLine } from './ledger.js';
import { requireAccount, type ResolvedAccountingConfig } from './config.js';
import { applyLineTaxes } from './taxPresets.js';
import type { JournalEntry, JournalLine, PaymentMethod, PurchaseKind } from '../../types/domain.ts';

function payRole(method: PaymentMethod): string {
  if (method === 'credit') return 'accountsPayable';
  if (method === 'cash') return 'cash';
  return 'bank';
}

/**
 * Raw line as the Compras (mercancía) form holds it. A DGII-aligned factura
 * line: qty × unit cost, minus a per-line `discount` (RD$), with its own ITBIS
 * preset(s) in `taxIds`. `cost` is the LEGACY pre-unit-cost total (still read
 * when `unitCost` is absent, so old stored docs keep working). All numeric
 * fields tolerate empty-string inputs.
 */
export interface PurchaseLineInput {
  id?: string;
  itemId?: string | null;
  name?: string;
  reference?: string;
  qty?: number | string | null;
  /** Unit cost (price per unit) — the canonical input. */
  unitCost?: number | string | null;
  /** Legacy whole-line total (used only when `unitCost` is absent). */
  cost?: number | string | null;
  /** Per-line discount in money (RD$), applied to the gross. */
  discount?: number | string | null;
  /** Per-line ITBIS preset id(s) (e.g. `['itbis18']`). */
  taxIds?: readonly string[] | null;
}

export interface ResolvedPurchaseLine {
  id: string;
  itemId: string | null;
  name: string;
  reference: string;
  qty: number;
  /** Gross before discount = qty × entered unit cost. */
  gross: number;
  /** Per-line discount (RD$), clamped to [0, gross]. */
  discount: number;
  /** NET line total = gross − discount. Capitalizes into inventory. */
  cost: number;
  /** Creditable ITBIS on the NET line (from `taxIds`). */
  itbis: number;
  taxIds: string[];
  /** Kardex IN unit cost = NET cost / qty (4 dp, matching the expediente). */
  unitCost: number;
}

/**
 * Resolve a goods purchase's article lines into per-line money + the invoice
 * roll-up. Each line: gross = qty × unit cost; NET `cost` = gross − discount
 * (this is what capitalizes into inventory and feeds the kardex unit cost);
 * ITBIS = the line's taxes applied to the NET cost (creditable, NOT part of the
 * inventory cost). The invoice `base` the asiento debits is Σ(net cost) and its
 * `itbis` is Σ(line ITBIS). Blank lines (no item, no name, no qty, no amount)
 * are dropped so a half-filled form row is ignored. Money is clamped at 0 and
 * rounded to cents; the unit cost keeps 4 dp. Pure — the single source the form
 * preview, the asiento base/itbis and the kardex INs read.
 */
export function resolvePurchaseLines(
  lines: readonly PurchaseLineInput[] | null | undefined,
): { lines: ResolvedPurchaseLine[]; base: number; itbis: number; qty: number } {
  const resolved: ResolvedPurchaseLine[] = (lines || [])
    .map((l) => {
      const qty = round2(Math.max(0, Number(l?.qty) || 0));
      // `unitCost` is the canonical input (qty × unit); `cost` is the legacy
      // whole-line total, read only when no unit cost is given.
      const hasUnit = l?.unitCost != null && l?.unitCost !== '';
      const gross = hasUnit
        ? round2(qty * Math.max(0, Number(l?.unitCost) || 0))
        : round2(Math.max(0, Number(l?.cost) || 0));
      const discount = round2(Math.min(Math.max(0, Number(l?.discount) || 0), gross));
      const cost = round2(gross - discount);
      const taxIds = ((l?.taxIds || []) as string[]).filter(Boolean);
      const itbis = taxIds.length ? applyLineTaxes(cost, taxIds).itbis : 0;
      return {
        id: l?.id || '',
        itemId: l?.itemId || null,
        name: (l?.name || '').trim(),
        reference: (l?.reference || '').trim(),
        qty,
        gross,
        discount,
        cost,
        itbis,
        taxIds,
        unitCost: qty > 0 ? round4(cost / qty) : 0,
      };
    })
    .filter((l) => l.itemId || l.name || l.qty > 0 || l.cost > 0);
  const base = round2(resolved.reduce((s, l) => s + l.cost, 0));
  const itbis = round2(resolved.reduce((s, l) => s + l.itbis, 0));
  const qty = round2(resolved.reduce((s, l) => s + l.qty, 0));
  return { lines: resolved, base, itbis, qty };
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
