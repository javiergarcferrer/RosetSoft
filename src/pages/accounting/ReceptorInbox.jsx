import { useMemo, useState } from 'react';
import { Inbox, Search, CheckCircle2, XCircle } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import RowCards from '../../components/RowCards.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { resolveReceptorInbox } from '../../core/accounting/index.js';

/**
 * Comprobantes recibidos — the DGII RECEPTOR inbox. Two read-only streams the
 * receptor Edge Functions archive:
 *   • e-CFs other emisores delivered to us (fe-recepcion answered each with an
 *     Acuse de Recibo),
 *   • the commercial approvals/rejections our customers returned on e-CFs WE
 *     issued (fe-aprobacioncomercial).
 * Self-gates on accounting/admin. The data arrives entirely via the `/fe/*`
 * endpoints, so this page reflects live receptor traffic with no manual entry.
 */
export default function ReceptorInbox() {
  const { profileId } = useApp();
  const scope = profileId || 'team';

  const receivedQ = useLiveQueryStatus(() => db.ecfReceived.where('profileId').equals(scope).toArray(), [scope], []);
  const approvalsQ = useLiveQueryStatus(() => db.ecfCommercialApprovals.where('profileId').equals(scope).toArray(), [scope], []);
  const [query, setQuery] = useState('');

  const inbox = useMemo(
    () => resolveReceptorInbox({ received: receivedQ.data, approvals: approvalsQ.data, query }),
    [receivedQ.data, approvalsQ.data, query],
  );

  const loaded = receivedQ.loaded && approvalsQ.loaded;

  return (
    <AccountingGate title="Comprobantes recibidos">
      <PageHeader title="Comprobantes recibidos"
        subtitle="e-CF que otros emisores nos enviaron y las aprobaciones comerciales recibidas en los nuestros — vía los endpoints /fe/*" />

      <div className="relative mb-4 max-w-sm">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" aria-hidden />
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por e-NCF o RNC…" className="input pl-9 w-full" />
      </div>

      {!loaded ? <ListLoading /> : (
        <div className="space-y-8">
          {/* ── e-CFs received from other emisores ───────────────────────── */}
          <section>
            <h2 className="text-sm font-semibold text-ink-700 mb-2">
              e-CF recibidos <span className="text-ink-400 font-normal">· {inbox.counts.received}</span>
            </h2>
            {inbox.received.length === 0 ? (
              <EmptyState icon={Inbox} title="Sin comprobantes recibidos"
                description="Aquí aparecerán los e-CF que otros emisores envíen a tu receptor." />
            ) : (
              <>
                <RowCards
                  rows={inbox.received.map((r) => ({
                    key: r.id,
                    title: r.eNcf,
                    right: r.estadoLabel,
                    sub: `${r.tipoLabel || r.tipoEcf} · RNC ${r.rncEmisor || '—'}`,
                    kv: [
                      ['Monto', formatDop(r.montoTotal)],
                      ['Recibido', r.receivedAt ? formatDate(r.receivedAt) : '—'],
                      ...(r.notReceived ? [['No recibido (cód.)', r.codigoNoRecibido || '—']] : []),
                    ],
                  }))}
                />
                <div className="card overflow-hidden hidden md:block">
                  <div className="overflow-x-auto">
                    <table className="table min-w-[640px]">
                      <thead>
                        <tr>
                          <th>e-NCF</th><th>Tipo</th><th>RNC emisor</th>
                          <th className="text-right">Monto</th><th>Estado</th><th>Recibido</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inbox.received.map((r) => (
                          <tr key={r.id}>
                            <td className="tabular-nums whitespace-nowrap">{r.eNcf}</td>
                            <td className="whitespace-nowrap">{r.tipoEcf}{r.tipoLabel ? ` · ${r.tipoLabel}` : ''}</td>
                            <td className="tabular-nums text-ink-600 whitespace-nowrap">{r.rncEmisor || '—'}</td>
                            <td className="text-right tabular-nums whitespace-nowrap">{formatDop(r.montoTotal)}</td>
                            <td className="whitespace-nowrap">
                              <span className={`status-pill ${r.notReceived ? 'status-pill-declined' : 'status-pill-active'}`}>{r.estadoLabel}</span>
                              {r.notReceived && r.codigoNoRecibido ? <span className="ml-1.5 text-xs text-ink-400">cód. {r.codigoNoRecibido}</span> : null}
                            </td>
                            <td className="text-ink-600 whitespace-nowrap">{r.receivedAt ? formatDate(r.receivedAt) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </section>

          {/* ── Commercial approvals customers returned on OUR e-CFs ──────── */}
          <section>
            <h2 className="text-sm font-semibold text-ink-700 mb-2">
              Aprobaciones comerciales en nuestros e-CF
              <span className="text-ink-400 font-normal"> · {inbox.counts.approvals}{inbox.counts.rejected ? ` (${inbox.counts.rejected} rechazadas)` : ''}</span>
            </h2>
            {inbox.approvals.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="Sin aprobaciones comerciales"
                description="Aquí aparecerán las aprobaciones o rechazos comerciales que tus clientes devuelvan sobre tus e-CF." />
            ) : (
              <>
                <RowCards
                  rows={inbox.approvals.map((r) => ({
                    key: r.id,
                    title: r.eNcf,
                    right: r.estadoLabel,
                    sub: `RNC ${r.rncComprador || '—'}`,
                    kv: [
                      ['Fecha', r.receivedAt ? formatDate(r.receivedAt) : '—'],
                      ...(r.rejected && r.motivoRechazo ? [['Motivo', r.motivoRechazo]] : []),
                    ],
                  }))}
                />
                <div className="card overflow-hidden hidden md:block">
                  <div className="overflow-x-auto">
                    <table className="table min-w-[640px]">
                      <thead>
                        <tr>
                          <th>e-NCF</th><th>RNC comprador</th><th>Estado</th><th>Motivo</th><th>Fecha</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inbox.approvals.map((r) => (
                          <tr key={r.id}>
                            <td className="tabular-nums whitespace-nowrap">{r.eNcf}</td>
                            <td className="tabular-nums text-ink-600 whitespace-nowrap">{r.rncComprador || '—'}</td>
                            <td className="whitespace-nowrap">
                              <span className={`status-pill ${r.rejected ? 'status-pill-declined' : 'status-pill-active'}`}>
                                {r.rejected ? <XCircle size={12} className="inline -mt-0.5 mr-1" /> : <CheckCircle2 size={12} className="inline -mt-0.5 mr-1" />}
                                {r.estadoLabel}
                              </span>
                            </td>
                            <td className="text-ink-600 min-w-[160px]">{r.motivoRechazo || '—'}</td>
                            <td className="text-ink-600 whitespace-nowrap">{r.receivedAt ? formatDate(r.receivedAt) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </AccountingGate>
  );
}
