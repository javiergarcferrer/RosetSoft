import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, AlertCircle } from 'lucide-react';
import { fetchSharedStatement } from '../lib/accountStatementShare.js';
import { userMessageFor } from '../lib/errorMessages.js';
import { formatDop, formatDate } from '../lib/format.js';

/**
 * Public, logged-OUT estado de cuenta (route #/cuenta/:token). Fetches a
 * whitelisted statement bundle from the `account-share` Edge Function and
 * renders it as the dealer's paper — forced light, no AppContext.
 */
export default function PublicAccountStatement() {
  const { token } = useParams();
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', data: null, error: null });
    fetchSharedStatement(token)
      .then((data) => { if (active) setState({ status: 'ready', data, error: null }); })
      .catch((e) => { if (active) setState({ status: 'error', data: null, error: userMessageFor(e) }); });
    return () => { active = false; };
  }, [token]);

  useEffect(() => {
    if (state.data) document.title = `Estado de cuenta — ${state.data.customer?.name || ''}`.trim();
  }, [state.data]);

  if (state.status === 'loading') {
    return (
      <div role="status" aria-live="polite" className="h-full flex flex-col items-center justify-center gap-3 bg-ink-50 text-ink-500">
        <Loader2 className="animate-spin text-brand-500" size={24} aria-hidden />
        <span className="text-sm">Cargando…</span>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="h-full overflow-y-auto overscroll-contain bg-ink-50 flex items-center justify-center p-6">
        <div className="bg-surface rounded-2xl shadow-sm p-8 max-w-md text-center">
          <AlertCircle className="mx-auto text-rose-500 mb-3" />
          <p className="text-ink-700 font-medium">No pudimos abrir el estado de cuenta.</p>
          <p className="text-ink-400 text-sm mt-1">{state.error}</p>
        </div>
      </div>
    );
  }

  const { company, customer, rows, balance } = state.data;
  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-ink-50 py-8 px-4">
      <div className="max-w-2xl mx-auto bg-surface rounded-2xl shadow-sm overflow-hidden">
        <div className="px-6 sm:px-8 py-6 border-b border-neutral-100">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="font-semibold text-lg text-neutral-900">{company?.name || 'Estado de cuenta'}</h1>
              {company?.rnc && <p className="text-xs text-neutral-400 tabular-nums">RNC {company.rnc}</p>}
            </div>
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wide text-neutral-400">Estado de cuenta</div>
              <div className="text-sm font-medium text-neutral-700">{customer?.name}</div>
              {customer?.rnc && <div className="text-xs text-neutral-400 tabular-nums">{customer.rnc}</div>}
            </div>
          </div>
        </div>

        <div className="px-6 sm:px-8 py-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-neutral-400 border-b border-neutral-100">
                <th className="py-2 pr-3">Fecha</th><th className="py-2 pr-3">Concepto</th>
                <th className="py-2 px-3 text-right">Cargo</th><th className="py-2 px-3 text-right">Abono</th>
                <th className="py-2 pl-3 text-right">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.ref || `${r.at ?? ''}-${i}`} className="border-b border-neutral-50">
                  <td className="py-2 pr-3 text-neutral-500 whitespace-nowrap">{formatDate(r.at)}</td>
                  <td className="py-2 pr-3 text-neutral-700">{r.label}{r.ref ? <span className="text-neutral-400 tabular-nums"> · {r.ref}</span> : null}</td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{r.charge ? formatDop(r.charge) : ''}</td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{r.payment ? formatDop(r.payment) : ''}</td>
                  <td className="py-2 pl-3 text-right tabular-nums font-medium whitespace-nowrap">{formatDop(r.balance)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-neutral-400">Sin movimientos.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="px-6 sm:px-8 py-4 border-t border-neutral-100 flex items-center justify-between">
          <span className="text-sm text-neutral-500">Balance pendiente</span>
          <span className={`text-lg font-semibold tabular-nums ${balance > 0 ? 'text-neutral-900' : 'text-emerald-600'}`}>{formatDop(balance)}</span>
        </div>
      </div>
      <p className="max-w-2xl mx-auto text-center text-xs text-neutral-400 mt-4">Generado por {company?.name || 'el comercio'}{company?.phone ? ` · ${company.phone}` : ''}</p>
    </div>
  );
}
