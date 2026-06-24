// Presupuesto vs. real (budgets vs actuals) ViewModel — per income/cost/expense
// account, the annual budget against the ledger actual for the year, with the
// variance and whether it's favorable. Pure: no React, no db.
import { round2, naturalBalance } from '../../lib/accounting/ledger.js';
import { accountRawBalances } from './ledger.js';

const CLASS_LABEL = { 4: 'Ingresos', 5: 'Costos', 6: 'Gastos' };
const BUDGETABLE = [4, 5, 6];

export function resolveBudgetVariance({ accounts, lines, entries, budgets, year } = {}) {
  const y = Number(year);
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y, 11, 31, 23, 59, 59);
  const raw = accountRawBalances(lines, { entries, start, end });
  const byCode = new Map((accounts || []).map((a) => [a.code, a]));
  const budgetByCode = new Map((budgets || []).filter((b) => Number(b.year) === y).map((b) => [b.accountCode, round2(b.amount || 0)]));

  // Accounts to show: any budgetable leaf with a budget OR actual movement.
  const codes = new Set([...budgetByCode.keys()]);
  for (const a of accounts || []) {
    if (a.isPostable && BUDGETABLE.includes(a.class)) {
      const r = raw.get(a.code);
      if (r && (r.debit || r.credit)) codes.add(a.code);
    }
  }

  const rows = [...codes]
    .map((code) => {
      const a = byCode.get(code);
      if (!a) return null;
      const r = raw.get(code);
      const budget = budgetByCode.get(code) || 0;
      const actual = round2(naturalBalance(((r && r.debit) || 0) - ((r && r.credit) || 0), a.nature));
      const variance = round2(actual - budget);
      // Favorable: more income than planned, or less cost/expense than planned.
      const favorable = a.class === 4 ? variance >= 0 : variance <= 0;
      return {
        code, name: a.name, class: a.class, budget, actual, variance,
        variancePct: budget ? round2((variance / Math.abs(budget)) * 100) : null,
        favorable,
      };
    })
    .filter(Boolean)
    .sort((x, z) => x.code.localeCompare(z.code));

  const sections = BUDGETABLE
    .map((cls) => {
      const sr = rows.filter((r) => r.class === cls);
      return {
        class: cls, label: CLASS_LABEL[cls], rows: sr,
        budget: round2(sr.reduce((s, r) => s + r.budget, 0)),
        actual: round2(sr.reduce((s, r) => s + r.actual, 0)),
        variance: round2(sr.reduce((s, r) => s + r.variance, 0)),
      };
    })
    .filter((s) => s.rows.length > 0);

  const totalFor = (cls) => sections.find((s) => s.class === cls) || { budget: 0, actual: 0 };
  const inc = totalFor(4); const cost = totalFor(5); const exp = totalFor(6);
  const netBudget = round2(inc.budget - cost.budget - exp.budget);
  const netActual = round2(inc.actual - cost.actual - exp.actual);

  return { year: y, sections, netBudget, netActual, netVariance: round2(netActual - netBudget) };
}
