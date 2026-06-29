/**
 * Bank-statement import — Banco Popular CSV parsing (amounts, dates, débito/
 * crédito → signed), deterministic rules, and the statement↔ledger matcher
 * (Match-never-duplicate). Pure Model + the resolveBankImport VM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAmount, parseDate, parseBankStatement, ruleMatches, firstMatchingRule, matchStatementToLedger,
} from '../src/lib/accounting/bankStatement.js';
import { resolveBankImport } from '../src/core/accounting/bankImport.js';

test('parseAmount handles DOP thousands, parens and signs', () => {
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount('RD$ 1,180.00'), 1180);
  assert.equal(parseAmount('(150.00)'), -150);
  assert.equal(parseAmount('-2,000'), -2000);
  assert.equal(parseAmount('1.234,56'), 1234.56); // EU style fallback
  assert.equal(parseAmount(''), 0);
});

test('parseAmount classifies decimal vs grouping separators (no 10x / no drop)', () => {
  assert.equal(parseAmount('500,5'), 500.5);       // EU one-decimal — was 5005 (10x)
  assert.equal(parseAmount('1.234.567'), 1234567); // dot grouping only — was NaN→0 (dropped)
  assert.equal(parseAmount('1,234,567'), 1234567); // comma grouping only
  assert.equal(parseAmount('1,234'), 1234);        // single sep, 3 digits → thousands
  assert.equal(parseAmount('1,23'), 1.23);         // single sep, 2 digits → decimal
  assert.equal(parseAmount('73.670,00'), 73670);   // EU thousands + decimal
});

test('parseDate reads DD/MM/YYYY (DR) and ISO', () => {
  assert.equal(parseDate('05/01/2026'), Date.UTC(2026, 0, 5));
  assert.equal(parseDate('31-12-2025'), Date.UTC(2025, 11, 31));
  assert.equal(parseDate('2026-01-05'), Date.UTC(2026, 0, 5));
  assert.ok(Number.isNaN(parseDate('not a date')));
});

const BP_CSV = [
  'Estado de cuenta - Banco Popular',
  'Cuenta: 7901234567',
  'Fecha,Descripción,Débito,Crédito,Balance',
  '05/01/2026,PAGO A SUPLIDOR FERRETERIA,"1,180.00",,"48,820.00"',
  '07/01/2026,DEPOSITO CLIENTE,,"25,000.00","73,820.00"',
  '10/01/2026,COMISION MANEJO CUENTA,150.00,,"73,670.00"',
].join('\n');

test('parseBankStatement reads a Banco Popular débito/crédito export', () => {
  const r = parseBankStatement(BP_CSV, { bank: 'popular' });
  assert.equal(r.lines.length, 3);
  assert.equal(r.lines[0].amount, -1180); // débito → out
  assert.equal(r.lines[0].description, 'PAGO A SUPLIDOR FERRETERIA');
  assert.equal(r.lines[0].balance, 48820);
  assert.equal(r.lines[1].amount, 25000); // crédito → in
  assert.equal(r.lines[2].amount, -150);
  assert.equal(r.lines[0].date, Date.UTC(2026, 0, 5));
});

test('parseBankStatement also reads a single signed Monto column', () => {
  const csv = 'Fecha;Concepto;Monto\n05/01/2026;Pago;-1180,00\n07/01/2026;Deposito;25000,00';
  const r = parseBankStatement(csv, { bank: 'popular' });
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].amount, -1180);
  assert.equal(r.lines[1].amount, 25000);
});

test('rules match by contains/equals/startsWith, accent-insensitive', () => {
  assert.equal(ruleMatches({ pattern: 'comision', matchType: 'contains' }, 'COMISIÓN MANEJO CUENTA'), true);
  assert.equal(ruleMatches({ pattern: 'deposito', matchType: 'startsWith' }, 'Depósito cliente'), true);
  assert.equal(ruleMatches({ pattern: 'pago', matchType: 'equals' }, 'pago a suplidor'), false);
  const rules = [
    { id: 'r1', pattern: 'comision', matchType: 'contains', accountCode: '6-07-010-01-00-00', priority: 1 },
    { id: 'r2', pattern: 'manejo', matchType: 'contains', accountCode: '6-07-099-00-00-00', priority: 5 },
  ];
  assert.equal(firstMatchingRule(rules, 'COMISION MANEJO CUENTA').id, 'r2'); // higher priority wins
});

test('matcher links lines to unreconciled ledger rows within tolerance, claims once', () => {
  const ledgerRows = [
    { line: { id: 'L1' }, postedAt: Date.UTC(2026, 0, 4), amount: -1180, reconciled: false },
    { line: { id: 'L2' }, postedAt: Date.UTC(2026, 0, 7), amount: 25000, reconciled: false },
    { line: { id: 'L3' }, postedAt: Date.UTC(2026, 0, 6), amount: -1180, reconciled: true }, // already cleared → never offered
  ];
  const rules = [{ id: 'r1', pattern: 'comision', matchType: 'contains', accountCode: '6-07-010-01-00-00', label: 'Comisiones bancarias' }];
  const { items, summary } = matchStatementToLedger({ statementLines: parseBankStatement(BP_CSV).lines, ledgerRows, rules });

  assert.equal(items[0].status, 'matched');
  assert.equal(items[0].ledgerRow.line.id, 'L1'); // −1180 within 1 day
  assert.equal(items[1].status, 'matched');
  assert.equal(items[1].ledgerRow.line.id, 'L2');
  assert.equal(items[2].status, 'suggested'); // commission → rule contra account
  assert.equal(items[2].rule.accountCode, '6-07-010-01-00-00');
  assert.equal(summary.matched, 2);
  assert.equal(summary.suggested, 1);
  assert.equal(summary.endingBalance, 73670);
});

test('a reconciled ledger row is never matched twice', () => {
  const statementLines = [
    { date: Date.UTC(2026, 0, 5), description: 'A', amount: -500, balance: null, raw: '' },
    { date: Date.UTC(2026, 0, 5), description: 'B', amount: -500, balance: null, raw: '' },
  ];
  const ledgerRows = [{ line: { id: 'L1' }, postedAt: Date.UTC(2026, 0, 5), amount: -500, reconciled: false }];
  const { items } = matchStatementToLedger({ statementLines, ledgerRows });
  assert.equal(items[0].status, 'matched');
  assert.equal(items[1].status, 'unmatched'); // only one ledger row to claim
});

test('matcher is currency-aware: USD matches by line.usd, DOP default by amount', () => {
  // A USD account's statement is in dollars; the ledger row carries the DOLLARS
  // in line.usd and the DOP in debit/credit. Statement −1180 (USD out) must
  // match the row whose line.usd is 1180, NOT its DOP amount (−69,000).
  const statementLines = [
    { date: Date.UTC(2026, 0, 5), description: 'PAGO USD', amount: -1180, balance: null, raw: '' },
    { date: Date.UTC(2026, 0, 7), description: 'DEPOSITO USD', amount: 25000, balance: null, raw: '' },
  ];
  const usdRows = [
    { line: { id: 'U1', usd: 1180 }, postedAt: Date.UTC(2026, 0, 5), amount: -69000, reconciled: false },
    { line: { id: 'U2', usd: 25000 }, postedAt: Date.UTC(2026, 0, 7), amount: 1462500, reconciled: false },
  ];
  const usd = matchStatementToLedger({ statementLines, ledgerRows: usdRows, accountCurrency: 'USD' });
  assert.equal(usd.items[0].status, 'matched');
  assert.equal(usd.items[0].ledgerRow.line.id, 'U1'); // by dollars, not DOP
  assert.equal(usd.items[1].status, 'matched');
  assert.equal(usd.items[1].ledgerRow.line.id, 'U2');

  // Without USD, the same lines compare against the DOP amount → no match.
  const dop = matchStatementToLedger({ statementLines, ledgerRows: usdRows });
  assert.equal(dop.items[0].status, 'unmatched');
  assert.equal(dop.items[1].status, 'unmatched');

  // DOP default still matches by the DOP amount.
  const dopRows = [{ line: { id: 'D1' }, postedAt: Date.UTC(2026, 0, 5), amount: -1180, reconciled: false }];
  const dop2 = matchStatementToLedger({ statementLines: [statementLines[0]], ledgerRows: dopRows });
  assert.equal(dop2.items[0].status, 'matched');
  assert.equal(dop2.items[0].ledgerRow.line.id, 'D1');
});

test('USD matcher honors a precomputed signed row.usd', () => {
  const statementLines = [{ date: Date.UTC(2026, 0, 5), description: 'X', amount: -300, balance: null, raw: '' }];
  // row.usd already signed (from resolveReconciliation) — used as-is.
  const rows = [{ line: { id: 'R1', usd: 300 }, usd: -300, postedAt: Date.UTC(2026, 0, 5), amount: -17550, reconciled: false }];
  const r = matchStatementToLedger({ statementLines, ledgerRows: rows, accountCurrency: 'USD' });
  assert.equal(r.items[0].status, 'matched');
});

test('resolveBankImport wires parse + match against a reconciliation', () => {
  const reconciliation = { rows: [{ line: { id: 'L1' }, postedAt: Date.UTC(2026, 0, 5), amount: -1180, reconciled: false }] };
  const r = resolveBankImport({ statementText: BP_CSV, bank: 'popular', rules: [], reconciliation });
  assert.equal(r.parsed.lines.length, 3);
  assert.equal(r.summary.matched, 1);
  assert.equal(r.items[0].status, 'matched');
  assert.ok(r.banks.find((b) => b.key === 'popular'));
});
