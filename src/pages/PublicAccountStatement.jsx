import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, AlertCircle, CloudOff, RefreshCw } from 'lucide-react';
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
  // Bumped by the error screen's "Reintentar" — re-runs the fetch effect.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', data: null, error: null });
    fetchSharedStatement(token)
      .then((data) => { if (active) setState({ status: 'ready', data, error: null }); })
      // No HTTP status ⇒ the request never reached the server (offline /
      // flaky data), NOT a dead link — the error screen branches on it.
      .catch((e) => { if (active) setState({ status: 'error', data: null, error: userMessageFor(e), offline: e?.status == null }); });
    return () => { active = false; };
  }, [token, attempt]);

  // Title the tab like the other public links; restore on unmount so the
  // dealer app's title isn't left overwritten.
  useEffect(() => {
    if (!state.data) return undefined;
    const prev = document.title;
    document.title = `Estado de cuenta — ${state.data.customer?.name || ''}`.trim();
    return () => { document.title = prev; };
  }, [state.data]);

  if (state.status === 'loading') {
    return (
      <div role="status" aria-live="polite" className="h-full flex flex-col items-center justify-center gap-3 bg-ink-50 text-ink-500">
        <Loader2 className="animate-spin text-brand-500" size={24} aria-hidden />
        <span className="text-sm">Cargando estado de cuenta…</span>
      </div>
    );
  }
  if (state.status === 'error') {
    // A connection drop is not a dead link — tell the client the truth and
    // let them retry (these links open from WhatsApp on mobile data).
    const offline = !!state.offline;
    return (
      <div className="h-full flex flex-col items-center justify-center bg-ink-50 text-center px-6">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-ink-100 text-ink-400 mb-5 shadow-xs">
          {offline
            ? <CloudOff size={28} strokeWidth={1.5} aria-hidden />
            : <AlertCircle size={28} strokeWidth={1.5} aria-hidden />}
        </div>
        <div className="font-display text-lg font-semibold text-ink-800">
          {offline ? 'Sin conexión' : 'Enlace no disponible'}
        </div>
        <p className="text-sm text-ink-500 mt-2 max-w-sm leading-relaxed">
          {offline
            ? 'No pudimos conectar con el servidor. Revisa tu conexión a internet e inténtalo de nuevo.'
            : 'Este estado de cuenta no es válido o fue desactivado. Pídele a tu asesor un enlace actualizado.'}
        </p>
        {offline && (
          <button type="button" onClick={() => setAttempt((a) => a + 1)} className="btn-brand mt-5">
            <RefreshCw size={14} aria-hidden /> Reintentar
          </button>
        )}
      </div>
    );
  }

  const { company, customer, rows, balance } = state.data;
  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-ink-50 py-8 px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
      <div className="max-w-2xl mx-auto bg-surface rounded-2xl shadow-sm overflow-hidden">
        <div className="px-6 sm:px-8 py-6 border-b border-ink-100">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="font-semibold text-lg text-ink-900">{company?.name || 'Estado de cuenta'}</h1>
              {company?.rnc && <p className="text-xs text-ink-400 tabular-nums">RNC {company.rnc}</p>}
            </div>
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wide text-ink-400">Estado de cuenta</div>
              <div className="text-sm font-medium text-ink-700">{customer?.name}</div>
              {customer?.rnc && <div className="text-xs text-ink-400 tabular-nums">{customer.rnc}</div>}
            </div>
          </div>
        </div>

        <div className="px-6 sm:px-8 py-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-ink-400 border-b border-ink-100">
                <th className="py-2 pr-3">Fecha</th><th className="py-2 pr-3">Concepto</th>
                <th className="py-2 px-3 text-right">Cargo</th><th className="py-2 px-3 text-right">Abono</th>
                <th className="py-2 pl-3 text-right">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.ref || `${r.at ?? ''}-${i}`} className="border-b border-ink-50">
                  <td className="py-2 pr-3 text-ink-500 whitespace-nowrap">{formatDate(r.at)}</td>
                  <td className="py-2 pr-3 text-ink-700">{r.label}{r.ref ? <span className="text-ink-400 tabular-nums"> · {r.ref}</span> : null}</td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{r.charge ? formatDop(r.charge) : ''}</td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{r.payment ? formatDop(r.payment) : ''}</td>
                  <td className="py-2 pl-3 text-right tabular-nums font-medium whitespace-nowrap">{formatDop(r.balance)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-ink-400">Sin movimientos.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="px-6 sm:px-8 py-4 border-t border-ink-100 flex items-center justify-between">
          <span className="text-sm text-ink-500">Balance pendiente</span>
          <span className={`text-lg font-semibold tabular-nums ${balance > 0 ? 'text-ink-900' : 'text-emerald-600'}`}>{formatDop(balance)}</span>
        </div>
      </div>
      <p className="max-w-2xl mx-auto text-center text-xs text-ink-400 mt-4">Generado por {company?.name || 'el comercio'}{company?.phone ? ` · ${company.phone}` : ''}</p>
    </div>
  );
}
