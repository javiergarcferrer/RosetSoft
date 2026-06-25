import { useMemo, useState, useRef } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Receipt, Trash2, Loader2, BookOpen, FileText, Ship, CheckCircle2, Clock, Pencil, Copy, Paperclip, UploadCloud, RefreshCw, ExternalLink, Link as LinkIcon, Image as ImageIcon } from 'lucide-react';
import BackLink from '../../components/BackLink.jsx';
import { useSetBreadcrumb } from '../../context/Breadcrumbs.jsx';
import { useConfirm } from '../../components/ConfirmProvider.jsx';
import TabPills from '../../components/accounting/TabPills.jsx';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { uploadDocAttachment, removeDocAttachment } from '../../db/docAttachmentUpload.js';
import { useApp } from '../../context/AppContext.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import { syncShopify } from '../../lib/shopifySync.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import { formatDop, formatDate } from '../../lib/format.js';
import { reverseComprasGastoPosting } from '../../lib/comprasGastosDoc.js';
import { resolvePurchaseExpenseDetail, debitTotal, creditTotal } from '../../core/accounting/index.js';

const NATURE_BADGE = {
  gasto: 'bg-ink-100 text-ink-600',
  mercancia: 'bg-emerald-50 text-emerald-700',
  activo: 'bg-sky-50 text-sky-700',
};

/** A label → value pair of the document header grid. */
function Field({ label, children }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 items-baseline min-w-0">
      <dt className="text-xs text-ink-400">{label}</dt>
      <dd className="text-sm text-ink-700 min-w-0 break-words">{children ?? '—'}</dd>
    </div>
  );
}

/**
 * Detalle de una compra o gasto — a vendor-bill DOCUMENT (Odoo-style): a header
 * block (proveedor · comprobante · 606 · fechas · pago · expediente) with the
 * published/paid status, then tabs for the líneas, the posted asiento (apuntes
 * contables) and the DGII classification, closing with the totals. "Eliminar"
 * reverses everything the registration posted — the asiento and, for mercancía,
 * the kardex IN + the items' on-hand/avg (movement-sourced, so each touched item
 * recomputes from what's LEFT; an item minted only by this invoice is removed).
 * Self-gates on accounting/admin.
 */
const APPROVAL = {
  approved: ['Aprobada', 'bg-emerald-100 text-emerald-700'],
  rejected: ['Rechazada', 'bg-rose-100 text-rose-700'],
  pending: ['Pendiente', 'bg-amber-100 text-amber-800'],
};

/** Classify an attachment for preview: prefer the stored MIME type, fall back
 *  to the URL extension (legacy/external links carry no type). */
function attachmentKind(url, type) {
  if (/^image\//i.test(type) || (!type && /\.(png|jpe?g|webp|gif|heic|heif|avif)(\?|$)/i.test(url))) return 'image';
  if (type === 'application/pdf' || (!type && /\.pdf(\?|$)/i.test(url))) return 'pdf';
  return url ? 'link' : 'none';
}

/**
 * Receipt comprobante + review/approval flag for a supplier document. A
 * two-column block: the upload controls + approval on the left, a live preview
 * (image inline · PDF embed · external-link card) on the right. Drag, paste or
 * click to upload a photo/PDF straight into the `documents` bucket; an external
 * link is still accepted as a secondary path.
 */
function DocExtras({ doc, table }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [dragging, setDragging] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  const url = doc.attachmentUrl || '';
  const kind = attachmentKind(url, doc.attachmentType || '');
  const status = doc.approvalStatus || 'approved';
  const [statusLabel, statusCls] = APPROVAL[status] || APPROVAL.approved;

  const patch = (fields) => db[table].update(doc.id, { ...fields, updatedAt: Date.now() });

  async function upload(file) {
    if (!file || busy) return;
    setErr('');
    setBusy(true);
    try {
      const prev = doc.attachmentUrl;
      const att = await uploadDocAttachment(file);
      await patch({ attachmentUrl: att.url, attachmentName: att.name, attachmentType: att.type });
      if (prev) removeDocAttachment(prev).catch(() => {});
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setBusy(false);
    }
  }

  function onPaste(e) {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/') || i.type === 'application/pdf');
    if (!item) return;
    e.preventDefault();
    upload(item.getAsFile());
  }

  async function clearAttachment() {
    const prev = doc.attachmentUrl;
    await patch({ attachmentUrl: null, attachmentName: null, attachmentType: null });
    if (prev) removeDocAttachment(prev).catch(() => {});
  }

  async function saveLink() {
    const u = linkUrl.trim();
    if (!u) return;
    const prev = doc.attachmentUrl;
    await patch({ attachmentUrl: u, attachmentName: null, attachmentType: null });
    if (prev) removeDocAttachment(prev).catch(() => {});
    setLinking(false);
    setLinkUrl('');
  }

  const setApproval = (s) => patch({ approvalStatus: s, approvedAt: Date.now() });

  return (
    <div className="grid gap-5 sm:grid-cols-2">
      {/* Controls */}
      <div className="space-y-4 min-w-0">
        <div>
          <div className="eyebrow text-ink-400 mb-1.5">Comprobante</div>
          {url ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <div className="flex items-center gap-2 rounded-lg border border-ink-200 bg-surface px-3 py-2 min-w-0 flex-1">
                {kind === 'pdf' ? <FileText size={16} className="text-rose-500 shrink-0" />
                  : kind === 'image' ? <ImageIcon size={16} className="text-brand-500 shrink-0" />
                  : <LinkIcon size={16} className="text-ink-400 shrink-0" />}
                <span className="text-sm text-ink-700 truncate">{doc.attachmentName || (kind === 'pdf' ? 'Comprobante.pdf' : kind === 'image' ? 'Comprobante' : 'Enlace adjunto')}</span>
              </div>
              <a href={url} target="_blank" rel="noreferrer" className="btn-icon text-ink-400" title="Abrir" aria-label="Abrir"><ExternalLink size={15} /></a>
              <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} className="btn-icon text-ink-400" title="Reemplazar" aria-label="Reemplazar">{busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}</button>
              <button type="button" onClick={clearAttachment} className="btn-icon text-ink-400" title="Quitar" aria-label="Quitar"><Trash2 size={15} /></button>
            </div>
          ) : (
            <>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files?.[0]); }}
                onPaste={onPaste}
                onClick={() => inputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
                className={`cursor-pointer rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${dragging ? 'border-brand-500 bg-brand-50' : 'border-ink-200 bg-ink-50 hover:border-ink-300'}`}
              >
                {busy ? <Loader2 size={20} className="animate-spin mx-auto text-ink-400" /> : <UploadCloud size={20} className="mx-auto text-ink-400" />}
                <div className="mt-1.5 text-sm text-ink-600">{busy ? 'Subiendo…' : 'Arrastra, pega o haz clic'}</div>
                <div className="text-xs text-ink-400">Imagen o PDF · máx. 25 MB</div>
              </div>
              {linking ? (
                <div className="flex items-center gap-2 mt-2">
                  <input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveLink()} placeholder="https://… (Drive, etc.)" className="input py-1 flex-1" autoFocus />
                  <button type="button" onClick={saveLink} className="btn-ghost text-xs">Guardar</button>
                  <button type="button" onClick={() => { setLinking(false); setLinkUrl(''); }} className="btn-ghost text-xs">Cancelar</button>
                </div>
              ) : (
                <button type="button" onClick={() => setLinking(true)} className="mt-2 text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1"><LinkIcon size={11} /> o pegar un enlace</button>
              )}
            </>
          )}
          {err && <p className="text-xs text-rose-600 mt-1.5">{err}</p>}
        </div>

        <div>
          <div className="eyebrow text-ink-400 mb-1.5">Aprobación</div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`status-pill ${statusCls}`}>{statusLabel}</span>
            {status !== 'approved' && <button type="button" onClick={() => setApproval('approved')} className="btn-ghost text-xs">Aprobar</button>}
            {status !== 'pending' && <button type="button" onClick={() => setApproval('pending')} className="btn-ghost text-xs">Marcar pendiente</button>}
            {status !== 'rejected' && <button type="button" onClick={() => setApproval('rejected')} className="btn-ghost text-xs text-rose-600">Rechazar</button>}
          </div>
        </div>
      </div>

      {/* Preview */}
      <div className="rounded-lg border border-ink-200 bg-ink-50 overflow-hidden h-56 flex items-center justify-center">
        {kind === 'image' ? (
          <a href={url} target="_blank" rel="noreferrer" className="block w-full h-full" title="Abrir en grande">
            <img src={url} alt={doc.attachmentName || 'Comprobante'} className="w-full h-full object-contain" />
          </a>
        ) : kind === 'pdf' ? (
          <object data={`${url}#toolbar=0&navpanes=0&view=FitH`} type="application/pdf" className="w-full h-full">
            <div className="text-center p-4">
              <FileText size={22} className="mx-auto mb-1.5 text-rose-500" />
              <a href={url} target="_blank" rel="noreferrer" className="text-sm text-brand-600 hover:text-brand-700">Abrir PDF</a>
            </div>
          </object>
        ) : kind === 'link' ? (
          <a href={url} target="_blank" rel="noreferrer" className="text-center text-brand-600 hover:text-brand-700 p-4">
            <ExternalLink size={22} className="mx-auto mb-1.5" />
            <div className="text-sm">Abrir enlace</div>
          </a>
        ) : (
          <div className="text-center text-ink-400">
            <Paperclip size={22} className="mx-auto mb-1.5 opacity-70" />
            <div className="text-xs">Sin comprobante adjunto</div>
          </div>
        )}
      </div>

      <input ref={inputRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
  );
}

export default function ComprasGastoDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { profileId } = useApp();
  const confirm = useConfirm();
  const scope = profileId || 'team';

  const purchaseQ = useLiveQueryStatus(() => db.purchases.get(id), [id], null);
  const expenseQ = useLiveQueryStatus(() => db.expenses.get(id), [id], null);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const itemsQ = useLiveQueryStatus(() => db.inventoryItems.where('profileId').equals(scope).toArray(), [scope], []);
  const expedientesQ = useLiveQueryStatus(() => db.importExpedientes.where('profileId').equals(scope).toArray(), [scope], []);

  const detail = useMemo(() => resolvePurchaseExpenseDetail({
    purchase: purchaseQ.data, expense: expenseQ.data,
    suppliers: suppliersQ.data, accounts: accountsQ.data, items: itemsQ.data, expedientes: expedientesQ.data,
  }), [purchaseQ.data, expenseQ.data, suppliersQ.data, accountsQ.data, itemsQ.data, expedientesQ.data]);

  const jeId = detail?.journalEntryId || '';
  const jLinesQ = useLiveQueryStatus(() => (jeId ? db.journalLines.where('entryId').equals(jeId).toArray() : []), [jeId], []);
  const accountName = useMemo(() => {
    const m = new Map(accountsQ.data.map((a) => [a.code, a.name]));
    return (code) => m.get(code) || '';
  }, [accountsQ.data]);
  const asientoLines = useMemo(() => jLinesQ.data.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)), [jLinesQ.data]);

  const [tab, setTab] = useState('lines'); // 'lines' | 'asiento' | 'dgii'
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState('');

  useSetBreadcrumb(detail ? `${detail.natureLabel}${detail.number != null ? ` #${detail.number}` : ''}` : null);

  const bothLoaded = purchaseQ.loaded && expenseQ.loaded;
  if (!bothLoaded || !suppliersQ.loaded) return <AccountingGate title="Compras y gastos"><ListLoading /></AccountingGate>;
  if (!detail) {
    return (
      <AccountingGate title="Compras y gastos">
        <BackLink to="/accounting/compras-gastos">Volver a compras y gastos</BackLink>
        <EmptyState icon={Receipt} title="Documento no encontrado" description="Puede haber sido eliminado o registrado en otro perfil." />
      </AccountingGate>
    );
  }

  /** Reverse this invoice: undo the asiento and (mercancía) the kardex INs,
   *  recomputing each touched item from its remaining movements. The row goes
   *  last so a mid-way failure leaves it to retry; the steps are idempotent. */
  async function reverseDoc() {
    const doc = purchaseQ.data || expenseQ.data;
    if (!doc || deleting) return;
    const what = detail.natureLabel.toLowerCase();
    const ok = await confirm({
      title: 'Eliminar compra',
      message: `¿Eliminar ${what}${detail.number != null ? ` #${detail.number}` : ''}? Se revierte el asiento${detail.reversesInventory ? ', los movimientos de inventario y las existencias' : ''}. Esta acción no se puede deshacer.`,
      confirmLabel: 'Eliminar',
      tone: 'danger',
    });
    if (!ok) return;
    setErr('');
    setDeleting(true);
    try {
      const { touched } = await reverseComprasGastoPosting({ id: doc.id, source: detail.source, journalEntryId: doc.journalEntryId });
      if (detail.source === 'purchase') await db.purchases.delete(doc.id);
      else await db.expenses.delete(doc.id);
      if (touched.length) syncShopify(touched).catch(() => {});
      navigate('/accounting/compras-gastos');
    } catch (ex) {
      setErr(userMessageFor(ex));
      setDeleting(false);
    }
  }

  const d = detail;
  const doc = purchaseQ.data || expenseQ.data;
  const docTable = detail.source === 'purchase' ? 'purchases' : 'expenses';
  const TABS = [
    { key: 'lines', label: 'Líneas de factura' },
    { key: 'asiento', label: 'Apuntes contables' },
    { key: 'dgii', label: 'DGII' },
  ];

  return (
    <AccountingGate title="Compras y gastos">
      <BackLink to="/accounting/compras-gastos">Volver a compras y gastos</BackLink>
      {err && <p className="text-sm text-rose-600 mb-3">{err}</p>}

      <div className="card overflow-hidden">
        {/* Action + status bar */}
        <div className="flex items-center justify-between gap-2 px-4 sm:px-6 py-2.5 border-b border-ink-100 bg-ink-50/40">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => navigate(`/accounting/compras-gastos/${id}/editar`)}
              className="btn-secondary">
              <Pencil size={14} /> <span className="hidden sm:inline">Editar</span>
            </button>
            <button type="button" onClick={() => navigate(`/accounting/compras-gastos/nuevo?duplicate=${id}`)}
              className="btn-secondary" title="Duplicar — registrar una factura similar">
              <Copy size={14} /> <span className="hidden sm:inline">Duplicar</span>
            </button>
            <button type="button" onClick={reverseDoc} disabled={deleting}
              className="btn-secondary text-rose-600 hover:bg-rose-50 hover:border-rose-200 disabled:opacity-50">
              {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} <span className="hidden sm:inline">Eliminar</span>
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="status-pill status-pill-active">Publicado</span>
            {d.paymentStatus === 'paid' ? (
              <span className="status-pill bg-emerald-100 text-emerald-700 inline-flex items-center gap-1"><CheckCircle2 size={12} /> Pagada</span>
            ) : (
              <span className="status-pill bg-amber-100 text-amber-800 inline-flex items-center gap-1"><Clock size={12} /> Por pagar</span>
            )}
          </div>
        </div>

        {/* Document header */}
        <div className="px-4 sm:px-6 py-5">
          <div className="flex items-start justify-between gap-3 mb-5">
            <div className="min-w-0">
              <div className="eyebrow text-ink-400">{d.natureLabel} de proveedor</div>
              <h1 className="font-display text-2xl font-semibold text-ink-900 truncate">
                {d.natureLabel}{d.number != null ? ` #${d.number}` : ''}
              </h1>
            </div>
            <span className={`shrink-0 inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${NATURE_BADGE[d.nature]}`}>{d.natureLabel}</span>
          </div>

          <div className="grid sm:grid-cols-2 gap-x-10 gap-y-3">
            <dl className="space-y-3 min-w-0">
              <Field label="Proveedor">
                {d.supplierId
                  ? <Link to={`/accounting/proveedor-360?supplier=${d.supplierId}`} className="text-brand-600 hover:text-brand-700 hover:underline">{d.supplierName || '—'}</Link>
                  : (d.supplierName || '—')}
                {d.supplierRnc && <div className="text-xs text-ink-400 tabular-nums">RNC/Céd. {d.supplierRnc}</div>}
              </Field>
              {d.ncf && <Field label="No. de comprobante">{<span className="tabular-nums">{d.ncf}</span>}</Field>}
              <Field label="Tipo de costos y gastos">{<span><span className="font-mono text-xs text-ink-400 mr-1">{d.tipo606}</span>{d.tipo606Label}</span>}</Field>
              {d.description && <Field label="Descripción">{d.description}</Field>}
            </dl>
            <dl className="space-y-3 min-w-0">
              <Field label="Fecha">{formatDate(d.date)}</Field>
              <Field label="Destino">{d.destination}</Field>
              <Field label="Forma de pago">{d.paymentLabel}{d.paid && d.paidAt ? <span className="text-ink-400"> · pagado el {formatDate(d.paidAt)}</span> : null}</Field>
              <Field label="Expediente">
                {d.expediente
                  ? <Link to={`/accounting/importaciones/${d.expediente.id}`} className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-700"><Ship size={12} />{d.expediente.label}</Link>
                  : '—'}
              </Field>
              <Field label="Diario">Facturas de proveedores</Field>
            </dl>
          </div>
        </div>

        {/* Adjunto + aprobación */}
        {doc && (
          <div className="px-4 sm:px-6 py-4 border-t border-ink-100">
            <DocExtras doc={doc} table={docTable} />
          </div>
        )}

        {/* Tabs */}
        <div className="px-4 sm:px-6 border-t border-ink-100 pt-4">
          <TabPills tabs={TABS} active={tab} onChange={setTab} />
        </div>

        <div className="px-4 sm:px-6 pb-2 min-w-0">
          {tab === 'lines' && (
            <div className="overflow-x-auto">
              {d.isLineBill ? (
                <table className="table min-w-[640px]">
                  <thead>
                    <tr>
                      <th>Concepto</th>
                      <th>Cuenta</th>
                      <th className="text-right whitespace-nowrap">Cant.</th>
                      <th className="text-right whitespace-nowrap">P. unit.</th>
                      <th className="text-right whitespace-nowrap">Desc.</th>
                      <th>Impuestos</th>
                      <th className="text-right whitespace-nowrap">Importe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.lines.map((l) => (
                      <tr key={l.id}>
                        <td className="min-w-0">{l.description || '—'}</td>
                        <td className="text-ink-600 min-w-0"><span className="font-mono text-xs text-ink-400 mr-1">{l.accountCode}</span>{l.accountName}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{l.qty || '—'}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{l.unitPrice > 0 ? formatDop(l.unitPrice) : '—'}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{l.discount > 0 ? `−${formatDop(l.discount)}` : '—'}</td>
                        <td className="text-ink-500 text-xs">{l.taxLabels.length ? l.taxLabels.join(' · ') : '—'}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(l.base)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : d.lines.length > 0 ? (
                <table className="table min-w-[640px]">
                  <thead>
                    <tr>
                      <th>Producto</th>
                      <th className="text-right whitespace-nowrap">Cant.</th>
                      <th className="text-right whitespace-nowrap">Costo unit.</th>
                      <th className="text-right whitespace-nowrap">Desc.</th>
                      <th>ITBIS</th>
                      <th className="text-right whitespace-nowrap">Importe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.lines.map((l) => {
                      const grossUnit = l.qty > 0 ? (l.cost + (l.discount || 0)) / l.qty : 0;
                      return (
                      <tr key={l.id}>
                        <td className="min-w-0">
                          {l.name}
                          {l.reference && <span className="ml-1.5 font-mono text-xs text-ink-400">{l.reference}</span>}
                          {!l.inInventory && <span className="ml-1.5 text-[11px] text-amber-700">sin artículo</span>}
                        </td>
                        <td className="text-right tabular-nums whitespace-nowrap">{l.qty || '—'}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{grossUnit > 0 ? formatDop(grossUnit) : '—'}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{l.discount > 0 ? `−${formatDop(l.discount)}` : '—'}</td>
                        <td className="text-ink-500 text-xs">{l.taxLabels?.length ? l.taxLabels.join(' · ') : '—'}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(l.cost)}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                // Gasto / activo — a single account line (Odoo's line-per-account shape).
                <table className="table min-w-[520px]">
                  <thead>
                    <tr><th>Concepto</th><th>Cuenta</th><th className="text-right whitespace-nowrap">Cant.</th><th className="text-right whitespace-nowrap">Importe</th></tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="min-w-0">{d.description || d.natureLabel}</td>
                      <td className="text-ink-600 min-w-0"><span className="font-mono text-xs text-ink-400 mr-1">{d.accountCode}</span>{d.accountName}</td>
                      <td className="text-right tabular-nums">1</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(d.base)}</td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'asiento' && (
            asientoLines.length === 0 ? (
              <p className="text-sm text-ink-400 py-6 text-center">Sin asiento contable.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table min-w-[560px]">
                  <thead>
                    <tr><th>Cuenta</th><th>Detalle</th><th className="text-right whitespace-nowrap">Débito</th><th className="text-right whitespace-nowrap">Crédito</th></tr>
                  </thead>
                  <tbody>
                    {asientoLines.map((l) => (
                      <tr key={l.id}>
                        <td className="whitespace-nowrap">
                          <span className="font-mono text-xs text-ink-500">{l.accountCode}</span>
                          {accountName(l.accountCode) && <span className="ml-1.5">{accountName(l.accountCode)}</span>}
                        </td>
                        <td className="min-w-0 text-ink-500">{l.memo || ''}{l.ncf ? <span className="ml-1.5 font-mono text-xs">{l.ncf}</span> : null}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{l.debit ? formatDop(l.debit) : ''}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{l.credit ? formatDop(l.credit) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-ink-200 font-semibold">
                      <td colSpan={2}>Totales</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(debitTotal(asientoLines))}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(creditTotal(asientoLines))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )
          )}

          {tab === 'dgii' && (
            <dl className="grid sm:grid-cols-2 gap-x-10 gap-y-3 py-2 max-w-3xl">
              <Field label="NCF">{d.ncf ? <span className="tabular-nums">{d.ncf}</span> : '—'}</Field>
              <Field label="Tipo de comprobante">{d.ncfType || '—'}</Field>
              <Field label="Tipo 606">{<span><span className="font-mono text-xs text-ink-400 mr-1">{d.tipo606}</span>{d.tipo606Label}</span>}</Field>
              <Field label="ITBIS adelantado">{formatDop(d.itbis)}</Field>
              <Field label="Retención ISR">{formatDop(d.retIsr)}</Field>
              <Field label="Retención ITBIS">{formatDop(d.retItbis)}</Field>
            </dl>
          )}
        </div>

        {/* Totals */}
        <div className="border-t border-ink-100 px-4 sm:px-6 py-4 flex justify-end">
          <div className="w-full sm:max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between gap-4"><span className="text-ink-500">Subtotal</span><span className="tabular-nums">{formatDop(d.base)}</span></div>
            <div className="flex justify-between gap-4"><span className="text-ink-500">ITBIS</span><span className="tabular-nums">{formatDop(d.itbis)}</span></div>
            {(d.retIsr > 0 || d.retItbis > 0) && (
              <div className="flex justify-between gap-4"><span className="text-ink-500">Retenciones</span><span className="tabular-nums text-rose-600">−{formatDop(d.retIsr + d.retItbis)}</span></div>
            )}
            <div className="flex justify-between gap-4 pt-1.5 border-t border-ink-100 font-semibold text-ink-900">
              <span>Total</span><span className="tabular-nums">{formatDop(d.total)}</span>
            </div>
            <div className="flex justify-between gap-4 text-ink-500">
              <span>Neto a pagar</span><span className="tabular-nums">{formatDop(d.net)}</span>
            </div>
          </div>
        </div>
      </div>
    </AccountingGate>
  );
}
