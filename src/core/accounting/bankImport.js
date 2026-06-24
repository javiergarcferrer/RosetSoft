// Bank-statement import ViewModel — parse a bank export (Banco Popular first),
// match it against a bank account's ledger (the reconciliation rows), and
// surface the QuickBooks-style "For Review" queue. Pure: no React, no db.
import { parseBankStatement, matchStatementToLedger, BANK_PROFILES } from '../../lib/accounting/bankStatement.js';

/**
 * @param statementText raw CSV/TSV pasted from online banking
 * @param bank          a BANK_PROFILES key ('popular'…)
 * @param rules         deterministic categorization rules (bank_rules rows)
 * @param reconciliation the resolveReconciliation result for the chosen account
 */
export function resolveBankImport({ statementText, bank = 'popular', rules, reconciliation } = {}) {
  const parsed = parseBankStatement(statementText || '', { bank });
  const { items, summary } = matchStatementToLedger({
    statementLines: parsed.lines,
    ledgerRows: (reconciliation && reconciliation.rows) || [],
    rules: rules || [],
  });
  return { parsed, items, summary, bank: parsed.bank, banks: Object.values(BANK_PROFILES) };
}
