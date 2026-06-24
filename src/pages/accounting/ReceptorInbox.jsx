import { useMemo, useState } from 'react';
import { Inbox, Search, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, invalidate } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import RowCards from '../../components/RowCards.jsx';
import Modal from '../../components/Modal.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { resolveReceptorInbox, buildCommercialApproval, parseEcfFechaEmision } from '../../core/accounting/index.js';
import { sendCommercialApproval } from '../../lib/ecfSend.js';
import { userMessageFor } from '../../lib/errorMessages.js';

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

  const [approving, setApproving] = useState(null); // { row, estado:1|2, motivo } | null
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Send an Aprobación / Rechazo Comercial (ACECF) on a received supplier e-CF,
  // then record OUR decision on the row so the inbox shows it and won't re-send.
  async function submitApproval() {
    const row = approving?.row;
    if (!row) return;
    setErr('');
    const estado = approving.estado;
    if (estado === 2 && !approving.motivo.trim()) { setErr('Indica el motivo del rechazo.'); return; }
    if (!row.rncComprador) { setErr('No se conoce nuestro RNC en este comprobante.'); return; }
    setBusy(true);
    try {
      // The supplier e-CF's own emission date rides into the ACECF (parsed from
      // the archived XML; the reception date is the fallback).
      const fechaEmision = parseEcfFechaEmision(row.xml) ?? row.receivedAt ?? Date.now();
      const payload = buildCommercialApproval({
        rncEmisor: row.rncEmisor, eNcf: row.eNcf, fechaEmision,
        montoTotal: row.montoTotal, rncComprador: row.rncComprador, estado,
        motivoRechazo: estado === 2 ? approving.motivo.trim() : undefined,
      });
      await sendCommercialApproval({ payload, eNcf: row.eNcf, profileId: scope });
      await db.ecfReceived.update(row.id, {
        commercialEstado: String(estado), commercialAt: Date.now(),
        commercialMotivo: estado === 2 ? approving.motivo.trim() : '',
      });
      invalidate();
      setApproving(null);
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setBusy(false);
    }
  }

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
                    right: r.commercialLabel || r.estadoLabel,
                    sub: `${r.tipoLabel || r.tipoEcf} · RNC ${r.rncEmisor || '—'}`,
                    onClick: r.canApprove ? () => { setErr(''); setApproving({ row: r, estado: 1, motivo: '' }); } : undefined,
                    kv: [
                      ['Monto', formatDop(r.montoTotal)],
                      ['Recibido', r.receivedAt ? formatDate(r.receivedAt) : '—'],
                      ...(r.notReceived ? [['No recibido (cód.)', r.codigoNoRecibido || '—']] : []),
                      ...(r.commercialLabel ? [['Aprobación comercial', r.commercialLabel]] : []),
                      ...(r.canApprove ? [['Acción', 'Tocar para aprobar / rechazar']] : []),
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
                          <th className="text-right">Aprobación comercial</th>
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
                            <td className="text-right whitespace-nowrap">
                              {r.commercialLabel ? (
                                <span className={`status-pill ${r.commercialEstado === '2' ? 'status-pill-declined' : 'status-pill-active'}`}>{r.commercialLabel}</span>
                              ) : r.canApprove ? (
                                <span className="inline-flex gap-1.5">
                                  <button type="button" onClick={() => { setErr(''); setApproving({ row: r, estado: 1, motivo: '' }); }}
                                    className="btn-ghost text-xs whitespace-nowrap" title="Aprobar comercialmente"><CheckCircle2 size={12} /> Aprobar</button>
                                  <button type="button" onClick={() => { setErr(''); setApproving({ row: r, estado: 2, motivo: '' }); }}
                                    className="btn-ghost text-xs whitespace-nowrap text-rose-600" title="Rechazar comercialmente"><XCircle size={12} /> Rechazar</button>
                                </span>
                              ) : <span className="text-ink-300">—</span>}
                            </td>
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

      {approving && (
        <Modal open onClose={() => { if (!busy) { setErr(''); setApproving(null); } }}
          title="Aprobación comercial" size="sm" footer={
            <>
              <button onClick={() => { setErr(''); setApproving(null); }} disabled={busy} className="btn-ghost">Cancelar</button>
              <button onClick={submitApproval} disabled={busy} className="btn-primary disabled:opacity-40 inline-flex items-center gap-1.5">
                {busy ? <Loader2 size={14} className="animate-spin" /> : (approving.estado === 2 ? <XCircle size={14} /> : <CheckCircle2 size={14} />)}
                {approving.estado === 2 ? 'Enviar rechazo' : 'Enviar aprobación'}
              </button>
            </>
          }>
          <p className="text-sm text-ink-600">
            Comprobante <span className="font-medium tabular-nums">{approving.row.eNcf}</span> de RNC {approving.row.rncEmisor || '—'} · <span className="tabular-nums">{formatDop(approving.row.montoTotal)}</span>.
          </p>
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={() => setApproving({ ...approving, estado: 1 })}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${approving.estado === 1 ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-ink-200 text-ink-600 hover:bg-ink-50'}`}>
              <CheckCircle2 size={14} className="inline -mt-0.5 mr-1" /> Aprobar
            </button>
            <button type="button" onClick={() => setApproving({ ...approving, estado: 2 })}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${approving.estado === 2 ? 'border-rose-300 bg-rose-50 text-rose-700' : 'border-ink-200 text-ink-600 hover:bg-ink-50'}`}>
              <XCircle size={14} className="inline -mt-0.5 mr-1" /> Rechazar
            </button>
          </div>
          {approving.estado === 2 ? (
            <div className="mt-3">
              <div className="label">Motivo del rechazo</div>
              <textarea className="input min-h-[72px]" value={approving.motivo}
                onChange={(e) => setApproving({ ...approving, motivo: e.target.value })}
                placeholder="Ej. montos o conceptos incorrectos" autoFocus />
            </div>
          ) : (
            <p className="mt-3 text-xs text-ink-400">Se enviará un acuse de Aprobación Comercial (ACECF) firmado al emisor.</p>
          )}
          {err ? <p className="mt-3 text-sm text-rose-600">{err}</p> : null}
        </Modal>
      )}
    </AccountingGate>
  );
}
