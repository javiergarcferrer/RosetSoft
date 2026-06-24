/** Audit trail VM — formatting, the update field-diff, and filters. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAuditTrail } from '../src/core/accounting/auditLog.js';

const rows = [
  { id: 'a1', loggedAt: 300, action: 'insert', tableName: 'sales_postings', rowId: 's1', userId: 'u1', after: { id: 's1', total: 1000 } },
  { id: 'a2', loggedAt: 200, action: 'update', tableName: 'expenses', rowId: 'e1', userId: 'u1', before: { id: 'e1', base: 100, ncf: '', updated_at: 'x' }, after: { id: 'e1', base: 100, ncf: 'B0100000001', updated_at: 'y' } },
  { id: 'a3', loggedAt: 100, action: 'delete', tableName: 'payments', rowId: 'p1', userId: null, before: { id: 'p1', amount: 50 } },
];
const profilesById = new Map([['u1', { id: 'u1', name: 'Ana' }]]);

test('formats action/table/user and diffs changed fields (ignoring updated_at)', () => {
  const r = resolveAuditTrail({ rows, profilesById });
  assert.equal(r.count, 3);
  assert.equal(r.rows[0].id, 'a1'); // newest first
  assert.equal(r.rows[0].actionLabel, 'Creó');
  assert.equal(r.rows[0].tableLabel, 'Factura');
  assert.equal(r.rows[0].userName, 'Ana');
  const upd = r.rows.find((x) => x.id === 'a2');
  assert.deepEqual(upd.changed, ['ncf']); // base unchanged, updated_at ignored
  const del = r.rows.find((x) => x.id === 'a3');
  assert.equal(del.userName, 'Sistema'); // no userId → system
});

test('filters by table, action and free text', () => {
  assert.equal(resolveAuditTrail({ rows, tableFilter: 'expenses' }).count, 1);
  assert.equal(resolveAuditTrail({ rows, actionFilter: 'delete' }).count, 1);
  assert.equal(resolveAuditTrail({ rows, profilesById, query: 'ana' }).count, 2);
  assert.equal(resolveAuditTrail({ rows, query: 'ncf' }).count, 1); // matches the changed field
});
