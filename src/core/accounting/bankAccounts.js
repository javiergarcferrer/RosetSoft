// Cuentas bancarias — the dealer's own bank/cash accounts, configured once and
// then reused by the cobro form (where the money lands) and the bank
// reconciliation picker. A bank account is a thin label over a postable chart
// leaf under Cajas y Bancos (1-01-001): `accountCode` is the optional binding
// to that leaf, so an asiento always posts to the real ledger account while the
// dealer thinks in plain terms ("Popular cheques USD").
//
// Pure ViewModel: no React, no db. `bankAccounts`/`accounts` are plain rows
// (camelCase domain). `accounts` is the chart of accounts; we only read `.code`
// and `.name` from it to resolve each account's `chartName`.

/** Mirrors the BANK_PROFILES keys so a <select> can offer the known banks. */
export const BANK_OPTIONS = [
  { key: 'popular', label: 'Banco Popular' },
  { key: 'generic', label: 'Genérico' },
];

// Active first (by sortOrder then name), archived last (same inner order).
function byOrderThenName(a, b) {
  if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1;
  const so = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  if (so !== 0) return so;
  return (a.name || '').localeCompare(b.name || '');
}

/**
 * Project the configured bank accounts for the management list: each row
 * augmented with the name of its bound chart leaf (`chartName`) and whether
 * that leaf still exists (`chartExists`), so the page can flag a dangling
 * binding. Archived accounts are kept but sorted to the bottom.
 *
 * @returns {{ rows: Array<object>, byId: Map<string, object> }}
 */
export function resolveBankAccounts({ bankAccounts = [], accounts = [] } = {}) {
  const chartByCode = new Map((accounts || []).map((a) => [a.code, a]));

  const rows = (bankAccounts || [])
    .map((ba) => {
      const chart = ba.accountCode ? chartByCode.get(ba.accountCode) : null;
      return {
        ...ba,
        archived: !!ba.archived,
        chartName: chart ? chart.name : null,
        chartExists: !!ba.accountCode && !!chart,
      };
    })
    .sort(byOrderThenName);

  const byId = new Map(rows.map((r) => [r.id, r]));
  return { rows, byId };
}

/**
 * Options for the cobro + reconciliation pickers: active accounts only, each
 * labelled with its currency suffix so DOP vs USD is obvious in a dropdown.
 *
 * @returns {Array<{ id, label, currency, accountCode, bank }>}
 */
export function bankAccountOptions(bankAccounts = []) {
  return (bankAccounts || [])
    .filter((ba) => !ba.archived)
    .sort(byOrderThenName)
    .map((ba) => ({
      id: ba.id,
      label: `${ba.name}${ba.currency ? ` · ${ba.currency}` : ''}`,
      currency: ba.currency,
      accountCode: ba.accountCode || null,
      bank: ba.bank || null,
    }));
}
