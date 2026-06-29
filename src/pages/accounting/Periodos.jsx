import { useMemo, useState } from 'react';
import { Lock, LockOpen, Loader2 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';

const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// Customizable columns (Shopify-style show/hide, persisted per browser). Each
// `cell` is a pure render off the per-row ctx; the Cerrar/Reabrir toggle stays a
// fixed trailing cell outside this array (it closes over `toggle`/`busy`).
const PERIODO_COLUMNS = [
  { key: 'month', label: 'Mes', canHide: false, thClass: 'text-left py-2 px-3', tdClass: 'py-1.5 px-3', cell: ({ year, month }) => <>{MONTHS_ES[month - 1]} {year}</> },
  {
    key: 'status', label: 'Estado', thClass: 'text-left py-2 px-3', tdClass: 'py-1.5 px-3',
    cell: ({ closed }) => (
      <span className={`status-pill ${closed ? 'bg-rose-100 text-rose-700' : 'status-pill-active'}`}>
        {closed ? 'Cerrado' : 'Abierto'}
      </span>
    ),
  },
];
const PERIODO_DEFAULT = { status: true };
const PERIODO_COLS_KEY = 'rs.periodos.cols.v1';

/**
 * Períodos contables — close a month so nothing can post into it (enforced by a
 * DB trigger across every path), reopen to amend. Self-gates on accounting/admin
 * via AccountingGate.
 */
export default function Periodos() {
  const { profileId } = useApp();
  const scope = profileId || 'team';

  const periodsQ = useLiveQueryStatus(() => db.fiscalPeriods.where('profileId').equals(scope).toArray(), [scope], []);
  const byKey = useMemo(() => new Map(periodsQ.data.map((p) => [`${p.year}-${p.month}`, p])), [periodsQ.data]);
  const months = useMemo(() => {
    const now = new Date();
    const out = [];
    for (let i = 0; i < 24; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      out.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
    }
    return out;
  }, []);
  const [busy, setBusy] = useState(null);
  const [toggleErr, setToggleErr] = useState('');
  const { columns, visible, setVisible, reset, cols } = useColumns(PERIODO_COLUMNS, PERIODO_DEFAULT, PERIODO_COLS_KEY);
  const { tableRef, tableStyle, thProps, ResizeHandle, reset: resetWidths } = useColumnWidths(cols, 'rs.periodos.widths.v1');

  async function toggle(year, month) {
    const key = `${year}-${month}`;
    const row = byKey.get(key);
    const closed = row?.status === 'closed';
    setToggleErr('');
    setBusy(key);
    try {
      if (row) {
        await db.fiscalPeriods.update(row.id, { status: closed ? 'open' : 'closed', closedAt: closed ? null : Date.now() });
      } else {
        await db.fiscalPeriods.put({ id: newId(), profileId: scope, year, month, status: 'closed', closedAt: Date.now() });
      }
    } catch (e) {
      // A denied close/reopen must surface — never leave the row showing the old
      // state as if the write succeeded.
      setToggleErr(userMessageFor(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <AccountingGate title="Períodos contables">
      <PageHeader title="Períodos contables"
        subtitle="Cierra un mes para que no se pueda asentar en él (se valida en la base de datos)" />

      {toggleErr && <p className="text-sm text-rose-600 mt-2">{toggleErr}</p>}

      {!periodsQ.loaded ? <ListLoading /> : (
        <div className="card overflow-hidden max-w-xl">
          <div className="hidden md:flex justify-end mb-2 px-3 pt-3">
            <ColumnsMenu columns={columns} visible={visible} onChange={setVisible} onReset={() => { reset(); resetWidths(); }} />
          </div>
          <div className="overflow-x-auto">
          <table ref={tableRef} style={tableStyle} className="w-full text-sm">
            <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
              <tr>
                {cols.map((c) => <th key={c.key} className={c.thClass} {...thProps(c.key)}>{c.label}{ResizeHandle(c.key)}</th>)}
                <th className="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody>
              {months.map(({ year, month }) => {
                const key = `${year}-${month}`;
                const closed = byKey.get(key)?.status === 'closed';
                const ctx = { year, month, closed };
                return (
                  <tr key={key} className="border-t border-ink-50">
                    {cols.map((c) => <td key={c.key} className={c.tdClass}>{c.cell(ctx)}</td>)}
                    <td className="py-1.5 px-3 text-right">
                      <button type="button" onClick={() => toggle(year, month)} disabled={busy === key}
                        className="inline-flex items-center gap-1 rounded-md px-2 min-h-8 coarse:min-h-11 text-xs font-medium text-ink-600 hover:text-ink-900 hover:bg-ink-100 active:bg-ink-200 transition-colors disabled:opacity-40">
                        {busy === key ? <Loader2 size={13} className="animate-spin" /> : closed ? <LockOpen size={13} /> : <Lock size={13} />}
                        {closed ? 'Reabrir' : 'Cerrar'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </AccountingGate>
  );
}
