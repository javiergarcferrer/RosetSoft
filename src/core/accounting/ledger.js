// Accounting ViewModels — pure projections of the general ledger.
//
// MVVM: the pages/accounting/* surfaces render THESE. The structural rules
// (class→nature, the account tree) come from the Model (lib/accounting/chart);
// the posting math (natural balance, rounding) from lib/accounting/ledger. A
// resolveX here joins accounts + entries + lines into exactly what one report
// renders — trial balance, balance sheet, income statement, the diario, or a
// single account's mayor. No React, no db.
import {
  buildChartIndex, chartRoots, leafCodesUnder,
} from '../../lib/accounting/chart.js';
import { naturalBalance, round2 } from '../../lib/accounting/ledger.js';

/** entryId → postedAt (ms), for date-windowing lines by their entry's date. */
function entryDateMap(entries) {
  const m = new Map();
  for (const e of entries || []) m.set(e.id, e.postedAt || 0);
  return m;
}

/**
 * Raw debit/credit sums per account code. When a date window is given, lines
 * are kept only if their entry's `postedAt` falls within [start, end].
 * @returns {Map<string, {debit:number, credit:number}>}
 */
export function accountRawBalances(lines, { entries, start, end } = {}) {
  const dates = start != null || end != null ? entryDateMap(entries) : null;
  const m = new Map();
  for (const l of lines || []) {
    if (dates) {
      const t = dates.get(l.entryId) || 0;
      if (start != null && t < start) continue;
      if (end != null && t > end) continue;
    }
    let r = m.get(l.accountCode);
    if (!r) { r = { debit: 0, credit: 0 }; m.set(l.accountCode, r); }
    r.debit += Number(l.debit) || 0;
    r.credit += Number(l.credit) || 0;
  }
  for (const r of m.values()) { r.debit = round2(r.debit); r.credit = round2(r.credit); }
  return m;
}

function leafNatural(raw, code, nature) {
  const r = raw.get(code);
  if (!r) return 0;
  return naturalBalance((r.debit || 0) - (r.credit || 0), nature);
}

/** Sum of every postable leaf's natural balance under a class root. */
function sumClass(index, raw, cls) {
  const root = chartRoots(index).find((r) => r.class === cls);
  if (!root) return 0;
  let s = 0;
  for (const code of leafCodesUnder(index, root.code)) {
    const node = index.byCode.get(code);
    s += leafNatural(raw, code, node.nature);
  }
  return round2(s);
}

/** Recursively build a statement subtree; a title node's amount = Σ children. */
function buildTree(index, raw, code) {
  const node = index.byCode.get(code);
  if (!node) return null;
  const children = (index.childrenByParent.get(code) || [])
    .map((c) => buildTree(index, raw, c.code))
    .filter(Boolean);
  const amount = node.isPostable
    ? round2(leafNatural(raw, code, node.nature))
    : round2(children.reduce((s, c) => s + c.amount, 0));
  return {
    code, name: node.name, level: node.level, nature: node.nature,
    class: node.class, isPostable: node.isPostable, amount, children,
  };
}

/** Drop zero-amount leaves and empty subtrees so a statement isn't 250 zeros. */
function prune(node) {
  if (!node) return null;
  node.children = node.children.map(prune).filter(Boolean);
  if (node.amount === 0 && node.children.length === 0) return null;
  return node;
}

/**
 * Balanza de comprobación — one row per postable account with movement, its
 * debit/credit totals and natural balance. `totalDebit` must equal
 * `totalCredit` (the ledger-wide proof of double entry).
 */
export function resolveTrialBalance({ accounts, lines, entries, start, end } = {}) {
  const raw = accountRawBalances(lines, { entries, start, end });
  const rows = [];
  let totalDebit = 0;
  let totalCredit = 0;
  for (const a of accounts || []) {
    if (!a.isPostable) continue;
    const r = raw.get(a.code);
    if (!r || (r.debit === 0 && r.credit === 0)) continue;
    totalDebit += r.debit;
    totalCredit += r.credit;
    rows.push({
      code: a.code, name: a.name, class: a.class, nature: a.nature,
      debit: r.debit, credit: r.credit,
      balance: round2(naturalBalance(r.debit - r.credit, a.nature)),
    });
  }
  rows.sort((x, y) => x.code.localeCompare(y.code));
  totalDebit = round2(totalDebit);
  totalCredit = round2(totalCredit);
  return { rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
}

/**
 * Estado de Situación (Balance General) as of `asOf`. Returns the Activos /
 * Pasivos / Patrimonio trees plus the period result (ingresos − costos −
 * gastos) folded into equity, so the sheet balances even before the closing
 * entry is posted.
 */
export function resolveBalanceSheet({ accounts, lines, entries, asOf } = {}) {
  const index = buildChartIndex(accounts);
  const raw = accountRawBalances(lines, { entries, end: asOf });
  const rootByClass = {};
  for (const r of chartRoots(index)) rootByClass[r.class] = r;
  const treeFor = (cls) => (rootByClass[cls] ? prune(buildTree(index, raw, rootByClass[cls].code)) : null);

  const assets = treeFor(1);
  const liabilities = treeFor(2);
  const equity = treeFor(3);

  const totalAssets = assets ? assets.amount : 0;
  const totalLiabilities = liabilities ? liabilities.amount : 0;
  const equityBooked = equity ? equity.amount : 0;

  const netIncome = round2(sumClass(index, raw, 4) - sumClass(index, raw, 5) - sumClass(index, raw, 6));
  const totalEquity = round2(equityBooked + netIncome);
  const totalLiabEquity = round2(totalLiabilities + totalEquity);

  return {
    asOf: asOf ?? null,
    assets, liabilities, equity,
    totalAssets, totalLiabilities, equityBooked, netIncome, totalEquity, totalLiabEquity,
    balanced: Math.abs(totalAssets - totalLiabEquity) < 0.01,
    difference: round2(totalAssets - totalLiabEquity),
  };
}

/**
 * Estado de Resultados for [start, end]. Ingresos − Costos = utilidad bruta;
 * menos Gastos = utilidad neta.
 */
export function resolveIncomeStatement({ accounts, lines, entries, start, end } = {}) {
  const index = buildChartIndex(accounts);
  const raw = accountRawBalances(lines, { entries, start, end });
  const rootByClass = {};
  for (const r of chartRoots(index)) rootByClass[r.class] = r;
  const treeFor = (cls) => (rootByClass[cls] ? prune(buildTree(index, raw, rootByClass[cls].code)) : null);

  const income = treeFor(4);
  const costs = treeFor(5);
  const expenses = treeFor(6);
  const totalIncome = income ? income.amount : 0;
  const totalCosts = costs ? costs.amount : 0;
  const totalExpenses = expenses ? expenses.amount : 0;
  const grossProfit = round2(totalIncome - totalCosts);
  const netIncome = round2(grossProfit - totalExpenses);

  return {
    start: start ?? null, end: end ?? null,
    income, costs, expenses,
    totalIncome, totalCosts, totalExpenses, grossProfit, netIncome,
  };
}

/**
 * Libro Diario — entries newest-first, each with its lines and debit/credit
 * totals. `limit` caps the list for the recent-activity view.
 */
export function resolveJournal({ entries, lines, limit } = {}) {
  const byEntry = new Map();
  for (const l of lines || []) {
    if (!byEntry.has(l.entryId)) byEntry.set(l.entryId, []);
    byEntry.get(l.entryId).push(l);
  }
  for (const arr of byEntry.values()) arr.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  let rows = (entries || []).map((e) => {
    const ls = byEntry.get(e.id) || [];
    return {
      entry: e,
      lines: ls,
      debit: round2(ls.reduce((s, l) => s + (Number(l.debit) || 0), 0)),
      credit: round2(ls.reduce((s, l) => s + (Number(l.credit) || 0), 0)),
    };
  });
  rows.sort((a, b) => (b.entry.postedAt || 0) - (a.entry.postedAt || 0) || (b.entry.number || 0) - (a.entry.number || 0));
  if (limit) rows = rows.slice(0, limit);
  return rows;
}

/**
 * Libro Mayor for one account — its movements in date order with a running
 * natural balance.
 */
export function resolveAccountLedger({ accounts, entries, lines, accountCode } = {}) {
  const account = (accounts || []).find((a) => a.code === accountCode) || null;
  const nature = account ? account.nature : 'debit';
  const dates = entryDateMap(entries);
  const numbers = new Map((entries || []).map((e) => [e.id, e.number]));
  const memos = new Map((entries || []).map((e) => [e.id, e.memo]));
  const ls = (lines || [])
    .filter((l) => l.accountCode === accountCode)
    .map((l) => ({
      ...l,
      postedAt: dates.get(l.entryId) || 0,
      entryNumber: numbers.get(l.entryId) ?? null,
      entryMemo: memos.get(l.entryId) || '',
    }));
  ls.sort((a, b) => (a.postedAt || 0) - (b.postedAt || 0) || (a.entryNumber || 0) - (b.entryNumber || 0));
  let running = 0;
  const rows = ls.map((l) => {
    running += naturalBalance((Number(l.debit) || 0) - (Number(l.credit) || 0), nature);
    return { line: l, balance: round2(running) };
  });
  return {
    account,
    rows,
    debit: round2(ls.reduce((s, l) => s + (Number(l.debit) || 0), 0)),
    credit: round2(ls.reduce((s, l) => s + (Number(l.credit) || 0), 0)),
    balance: round2(running),
  };
}
