/**
 * Chart-of-accounts Model — pure helpers over the catálogo de cuentas.
 *
 * The accounts are seeded from the advisor's DGII IR-2-aligned plan (migration
 * 20260610120000). This module owns the structural rules — class → nature, the
 * parent/child tree, and which postable leaves roll up into a title account —
 * so every accounting ViewModel derives the same hierarchy instead of
 * re-deriving it from codes at each call site.
 *
 * Pure: no React, no Supabase. Imports only domain types.
 */
import type { Account, AccountNature } from '../../types/domain.ts';

/** Class number → human label (Spanish, as the advisor's plan names them). */
export const ACCOUNT_CLASS_NAMES: Record<number, string> = {
  1: 'Activos',
  2: 'Pasivos',
  3: 'Patrimonio',
  4: 'Ingresos',
  5: 'Costos',
  6: 'Gastos',
};

/** Classes whose normal balance is on the DEBIT side (assets, costs, expenses). */
export const DEBIT_CLASSES = new Set<number>([1, 5, 6]);

/** First segment of the code = the class (1..6). */
export function classOf(code: string): number {
  return parseInt(String(code || '').charAt(0), 10) || 0;
}

/** Normal balance side for a class. 1/5/6 debit; 2/3/4 credit. */
export function natureForClass(cls: number): AccountNature {
  return DEBIT_CLASSES.has(cls) ? 'debit' : 'credit';
}

export interface ChartIndex {
  /** code → account. */
  byCode: Map<string, Account>;
  /** parentCode (or null for class roots) → its direct children, sorted. */
  childrenByParent: Map<string | null, Account[]>;
}

/**
 * Build the lookup index over a flat account list: a code map and a
 * parent→children adjacency, children pre-sorted by `sortOrder` (then code) so
 * the tree always renders in catálogo order.
 */
export function buildChartIndex(accounts: Account[] | null | undefined): ChartIndex {
  const byCode = new Map<string, Account>();
  const childrenByParent = new Map<string | null, Account[]>();
  for (const a of accounts || []) byCode.set(a.code, a);
  for (const a of accounts || []) {
    const p = a.parentCode || null;
    if (!childrenByParent.has(p)) childrenByParent.set(p, []);
    childrenByParent.get(p)!.push(a);
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((x, y) => (x.sortOrder || 0) - (y.sortOrder || 0) || x.code.localeCompare(y.code));
  }
  return { byCode, childrenByParent };
}

/** The class-root accounts (Activos, Pasivos, …) in class order. */
export function chartRoots(index: ChartIndex): Account[] {
  return (index.childrenByParent.get(null) || [])
    .slice()
    .sort((a, b) => a.class - b.class || (a.sortOrder || 0) - (b.sortOrder || 0));
}

/**
 * Every POSTABLE (leaf) account code at or under `code`, in tree order. A title
 * account returns all the leaves it aggregates; a leaf returns just itself.
 * This is how a roll-up balance (e.g. "ACTIVOS CORRIENTES") sums its members.
 */
export function leafCodesUnder(index: ChartIndex, code: string): string[] {
  const out: string[] = [];
  const walk = (c: string): void => {
    const node = index.byCode.get(c);
    if (node && node.isPostable) out.push(c);
    for (const k of index.childrenByParent.get(c) || []) walk(k.code);
  };
  walk(code);
  return out;
}

/** Only the postable (leaf) accounts — the ones that can carry journal lines. */
export function postableAccounts(accounts: Account[] | null | undefined): Account[] {
  return (accounts || []).filter((a) => a.isPostable);
}
