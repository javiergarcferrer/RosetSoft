// Receptor inbox ViewModel — the two streams the DGII receptor Edge Functions
// archive, projected for the Comprobantes-recibidos page:
//   • `received`  — e-CFs other emisores delivered to us (fe-recepcion answered
//     each with an Acuse de Recibo); estado '0' recibido / '1' no recibido.
//   • `approvals` — commercial approvals/rejections OUR customers sent back on
//     e-CFs WE issued (fe-aprobacioncomercial); estado '1' aprobado / '2'
//     rechazado.
// Pure: no React, no db.
import { ecfTypeLabel } from '../../lib/accounting/ecf.js';

const RECEIVED_ESTADO = { 0: 'Recibido', 1: 'No recibido' };
const ACECF_ESTADO = { 1: 'Aprobado', 2: 'Rechazado' };

const lc = (v) => String(v || '').toLowerCase();

export function resolveReceptorInbox({ received = [], approvals = [], query = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const hit = (vals) => !q || vals.some((v) => lc(v).includes(q));

  const receivedRows = (received || [])
    .filter((r) => hit([r.eNcf, r.rncEmisor, r.tipoEcf]))
    .map((r) => {
      const estado = String(r.estado ?? '');
      const commercialEstado = String(r.commercialEstado ?? '');
      return {
        id: r.id,
        eNcf: r.eNcf || '',
        tipoEcf: r.tipoEcf || '',
        tipoLabel: r.tipoEcf ? ecfTypeLabel(r.tipoEcf) : '',
        rncEmisor: r.rncEmisor || '',
        rncComprador: r.rncComprador || '',
        montoTotal: Number(r.montoTotal) || 0,
        estado,
        estadoLabel: RECEIVED_ESTADO[estado] || '—',
        notReceived: estado === '1',
        codigoNoRecibido: r.codigoNoRecibido || '',
        // OUR commercial approval (ACECF) of this doc, if we've sent one.
        commercialEstado,
        commercialLabel: ACECF_ESTADO[commercialEstado] || '',
        commercialMotivo: r.commercialMotivo || '',
        // A received (not "no recibido") e-CF we haven't yet answered commercially.
        canApprove: estado === '0' && !commercialEstado,
        xml: r.xml || '',
        receivedAt: r.receivedAt || r.createdAt || null,
      };
    })
    .sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0));

  const approvalRows = (approvals || [])
    .filter((r) => hit([r.eNcf, r.rncComprador]))
    .map((r) => {
      const estado = String(r.estado ?? '');
      return {
        id: r.id,
        eNcf: r.eNcf || '',
        rncEmisor: r.rncEmisor || '',
        rncComprador: r.rncComprador || '',
        estado,
        estadoLabel: ACECF_ESTADO[estado] || '—',
        rejected: estado === '2',
        motivoRechazo: r.motivoRechazo || '',
        receivedAt: r.receivedAt || r.createdAt || null,
      };
    })
    .sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0));

  return {
    received: receivedRows,
    approvals: approvalRows,
    counts: {
      received: receivedRows.length,
      approvals: approvalRows.length,
      rejected: approvalRows.filter((a) => a.rejected).length,
    },
  };
}
