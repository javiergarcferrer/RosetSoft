import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Loader2, Search, RefreshCw, Paperclip, ExternalLink, FileText, Inbox, Plug,
  X, Download, Image as ImageIcon, File as FileIcon,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { useApp } from '../context/AppContext.jsx';
import { db, invalidate } from '../db/database.js';
import { useLiveQueryStatus } from '../db/hooks.ts';
import {
  GMAIL_BRAND_TABS, GMAIL_BRAND_OTHER,
  resolveGmailThreads, resolveGmailThread, resolveGmailInvoices, parseInvoiceAmount,
} from '../core/crm/index.js';
import {
  syncGmail, markGmailThreadRead, setGmailThreadBrand, gmailWebUrl, expenseDeepLink,
  loadGmailAttachment, isPreviewable,
} from '../lib/gmail.js';

/**
 * Gmail — the CRM email inbox. Mail is synced server-side by the google-api
 * `gmailSync` action (one connected Google account, gmail.readonly) into
 * gmail_messages; this View reads that table and renders it bucketed by BRAND
 * (Ligne Roset / LifestyleGarden / Otros) plus a FACTURAS tab. All derivation —
 * brand classification, invoice detection — lives in core/crm
 * (resolveGmailThreads / resolveGmailInvoices); this View fetches, holds UI
 * state (tab, search, selection) and renders.
 *
 * The invoice tab links a bill to "nuevo gasto" via a navigation deep-link, not
 * a code import, so the CRM↔Accounting wall stays intact.
 */
const INVOICES_TAB = 'facturas';

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('es-DO', { day: '2-digit', month: 'short' });
}
function fmtMoney(a) {
  if (!a || !(a.amount > 0)) return '';
  return `${a.currency} ${a.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function brandLabel(id) {
  return GMAIL_BRAND_TABS.find((t) => t.id === id)?.label || 'Otros';
}

export default function Gmail() {
  const { profileId, settings } = useApp();
  const connected = !!settings?.googleConnectedAt;

  const { data: messages, loaded } = useLiveQueryStatus(
    () => db.gmailMessages.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );

  const [tab, setTab] = useState(GMAIL_BRAND_TABS[0].id);
  const [needle, setNeedle] = useState('');
  const [selectedThreadId, setSelectedThreadId] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  // The attachment open in the preview lightbox: { messageId, attachment } | null.
  const [preview, setPreview] = useState(null);
  const openPreview = useCallback((messageId, attachment) => setPreview({ messageId, attachment }), []);

  const runSync = useCallback(async () => {
    if (!connected) return;
    setSyncing(true);
    setSyncError('');
    try {
      await syncGmail();
      invalidate();
    } catch (e) {
      setSyncError(e?.message || 'No se pudo sincronizar el correo.');
    } finally {
      setSyncing(false);
    }
  }, [connected]);

  // Pull once on mount when connected so the inbox isn't empty on first open.
  useEffect(() => {
    if (connected) runSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const threads = useMemo(
    () => resolveGmailThreads(messages, { needle }),
    [messages, needle],
  );
  const invoices = useMemo(
    () => resolveGmailInvoices(messages, { needle }),
    [messages, needle],
  );

  // Per-tab counts (threads + unread) for the tab badges, and the invoice total.
  const counts = useMemo(() => {
    const c = {};
    for (const t of GMAIL_BRAND_TABS) c[t.id] = { threads: 0, unread: 0 };
    for (const t of resolveGmailThreads(messages, {})) {
      const bucket = c[t.brand] || c[GMAIL_BRAND_OTHER];
      bucket.threads += 1;
      bucket.unread += t.unread;
    }
    return c;
  }, [messages]);
  const invoiceCount = useMemo(() => resolveGmailInvoices(messages, {}).length, [messages]);

  const tabThreads = useMemo(
    () => (tab === INVOICES_TAB ? [] : threads.filter((t) => t.brand === tab)),
    [threads, tab],
  );

  const selectedThread = useMemo(
    () => (selectedThreadId ? resolveGmailThread(messages, { threadId: selectedThreadId }) : null),
    [messages, selectedThreadId],
  );

  // Mark a thread read when it's opened.
  useEffect(() => {
    if (selectedThread?.items?.length) markGmailThreadRead(selectedThread.items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThreadId]);

  const openThread = (id) => setSelectedThreadId(id);
  const reassignBrand = async (brand) => {
    if (!selectedThread?.items?.length) return;
    await setGmailThreadBrand(selectedThread.items, brand === GMAIL_BRAND_OTHER ? null : brand);
  };

  const actions = (
    <button
      type="button"
      onClick={runSync}
      disabled={!connected || syncing}
      className="inline-flex items-center gap-2 rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
    >
      {syncing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
      Sincronizar
    </button>
  );

  if (!connected) {
    return (
      <div>
        <PageHeader title="Gmail" subtitle="Bandeja de entrada por marca" />
        <EmptyState
          icon={Plug}
          title="Conecta Google primero"
          description="La bandeja lee el correo de la cuenta de Google conectada. Conéctala en Integraciones para ver y clasificar los mensajes por marca."
          action={(
            <Link to="/integraciones" className="inline-flex items-center gap-2 rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-700">
              Ir a Integraciones
            </Link>
          )}
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Gmail"
        subtitle={settings?.googleEmail ? `Bandeja de ${settings.googleEmail}` : 'Bandeja de entrada por marca'}
        actions={actions}
      />

      {syncError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{syncError}</div>
      )}

      {/* Tabs: brands + Facturas */}
      <div className="mb-4 flex flex-wrap items-center gap-1 border-b border-ink-100">
        {GMAIL_BRAND_TABS.map((t) => (
          <TabButton
            key={t.id}
            active={tab === t.id}
            onClick={() => { setTab(t.id); setSelectedThreadId(null); }}
            label={t.label}
            badge={counts[t.id]?.unread || 0}
            count={counts[t.id]?.threads || 0}
          />
        ))}
        <TabButton
          active={tab === INVOICES_TAB}
          onClick={() => { setTab(INVOICES_TAB); setSelectedThreadId(null); }}
          label="Facturas"
          icon={FileText}
          count={invoiceCount}
        />
      </div>

      {/* Search */}
      <div className="mb-4 relative max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          type="search"
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
          placeholder="Buscar correo…"
          className="w-full rounded-lg border border-ink-200 bg-surface pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-300"
        />
      </div>

      {!loaded ? (
        <div className="flex items-center gap-2 text-sm text-ink-400 py-10 justify-center">
          <Loader2 size={16} className="animate-spin" /> Cargando…
        </div>
      ) : tab === INVOICES_TAB ? (
        <InvoiceList invoices={invoices} onPreview={openPreview} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
          <ThreadList threads={tabThreads} selectedId={selectedThreadId} onOpen={openThread} brandTab={tab} />
          <ReadingPane thread={selectedThread} onReassign={reassignBrand} onPreview={openPreview} />
        </div>
      )}

      {preview && (
        <AttachmentModal
          messageId={preview.messageId}
          attachment={preview.attachment}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

function TabButton({ active, onClick, label, badge = 0, count = 0, icon: Icon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative inline-flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition ${
        active ? 'border-ink-900 text-ink-900' : 'border-transparent text-ink-500 hover:text-ink-800'
      }`}
    >
      {Icon && <Icon size={15} />}
      {label}
      {count > 0 && <span className="text-xs text-ink-400">{count}</span>}
      {badge > 0 && <span className="ml-0.5 inline-flex min-w-[1.1rem] justify-center rounded-full bg-ink-900 px-1 text-[0.65rem] font-semibold text-white">{badge}</span>}
    </button>
  );
}

function ThreadList({ threads, selectedId, onOpen, brandTab }) {
  if (!threads.length) {
    return (
      <div className="rounded-xl border border-ink-100 bg-surface">
        <EmptyState icon={Inbox} title="Sin correos" description={`No hay correos en ${brandLabel(brandTab)}.`} />
      </div>
    );
  }
  return (
    <ul className="rounded-xl border border-ink-100 bg-surface divide-y divide-ink-100 overflow-hidden max-h-[70vh] overflow-y-auto">
      {threads.map((t) => (
        <li key={t.threadId}>
          <button
            type="button"
            onClick={() => onOpen(t.threadId)}
            className={`w-full text-left px-3.5 py-3 hover:bg-ink-50 transition ${selectedId === t.threadId ? 'bg-ink-50' : ''}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className={`truncate text-sm ${t.unread ? 'font-semibold text-ink-900' : 'text-ink-700'}`}>
                {t.fromName || t.fromEmail || 'Desconocido'}
              </span>
              <span className="shrink-0 text-xs text-ink-400">{fmtDate(t.lastAt)}</span>
            </div>
            <div className={`truncate text-sm ${t.unread ? 'font-medium text-ink-800' : 'text-ink-600'}`}>{t.subject}</div>
            <div className="truncate text-xs text-ink-400">{t.snippet}</div>
            <div className="mt-1 flex items-center gap-2">
              {t.count > 1 && <span className="text-[0.65rem] text-ink-400">{t.count} mensajes</span>}
              {t.hasInvoice && (
                <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[0.65rem] font-medium text-amber-700">
                  <FileText size={11} /> Factura
                </span>
              )}
              {t.unread > 0 && <span className="inline-block h-2 w-2 rounded-full bg-ink-900" aria-label="no leído" />}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ReadingPane({ thread, onReassign, onPreview }) {
  if (!thread) {
    return (
      <div className="hidden lg:flex items-center justify-center rounded-xl border border-dashed border-ink-200 bg-ink-50/40 text-sm text-ink-400 min-h-[40vh]">
        Selecciona un correo para leerlo.
      </div>
    );
  }
  const last = thread.items[thread.items.length - 1] || null;
  return (
    <div className="rounded-xl border border-ink-100 bg-surface flex flex-col max-h-[70vh]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
        <h2 className="font-display text-base font-semibold text-ink-900 truncate">{thread.subject}</h2>
        <div className="flex items-center gap-2">
          <select
            value={(last?.brand) || ''}
            onChange={(e) => onReassign(e.target.value || GMAIL_BRAND_OTHER)}
            className="rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-xs text-ink-700"
            title="Reasignar marca"
          >
            <option value="">Marca: auto</option>
            {GMAIL_BRAND_TABS.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          {last && (
            <a
              href={gmailWebUrl(last)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
            >
              <ExternalLink size={13} /> Gmail
            </a>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {thread.items.map((m) => (
          <MessageBubble key={m.id} message={m} onPreview={onPreview} />
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message, onPreview }) {
  const out = message.direction === 'out';
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${out ? 'border-ink-100 bg-ink-50/60 ml-6' : 'border-ink-100 bg-surface mr-6'}`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-xs font-medium text-ink-700 truncate">
          {out ? 'Tú' : (message.fromName || message.fromEmail || 'Desconocido')}
        </span>
        <span className="text-[0.65rem] text-ink-400 shrink-0">{fmtDate(message.receivedAt || message.createdAt)}</span>
      </div>
      {message.bodyHtml ? (
        <HtmlBody html={message.bodyHtml} />
      ) : (
        <p className="text-sm text-ink-700 whitespace-pre-wrap break-words">
          {(message.bodyText || message.snippet || '').slice(0, 8000)}
        </p>
      )}
      {(message.attachments || []).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {message.attachments.map((a, i) => (
            <AttachmentChip
              key={`${a.attachmentId || a.filename}-${i}`}
              attachment={a}
              onClick={() => onPreview?.(message.id, a)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * An email's HTML body, isolated in a sandboxed iframe — NO allow-scripts, so the
 * email's own markup/CSS renders but nothing it carries can execute or reach the
 * app. `allow-same-origin` is granted only so we can measure the content and
 * auto-size the frame; `allow-popups` lets its links open in a new tab.
 */
function HtmlBody({ html }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(120);
  const srcDoc = useMemo(() => (
    `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">`
    + `<style>html,body{margin:0;padding:0}body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;`
    + `font-size:14px;line-height:1.5;color:#1a1a1a;word-break:break-word;overflow-wrap:anywhere}`
    + `img{max-width:100%;height:auto}table{max-width:100%}a{color:#1d4ed8}</style></head>`
    + `<body>${html}</body></html>`
  ), [html]);
  const onLoad = () => {
    try {
      const doc = ref.current?.contentDocument;
      const h = doc ? Math.max(doc.documentElement?.scrollHeight || 0, doc.body?.scrollHeight || 0) : 0;
      if (h) setHeight(Math.min(h + 8, 1400));
    } catch { /* cross-origin guard — keep the default height */ }
  };
  return (
    <iframe
      ref={ref}
      title="Correo"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      onLoad={onLoad}
      className="w-full rounded bg-white"
      style={{ height, border: 0 }}
    />
  );
}

function AttachmentChip({ attachment, onClick }) {
  const a = attachment || {};
  const isImg = String(a.mimeType || '').toLowerCase().startsWith('image/');
  const Icon = isImg ? ImageIcon : (isPreviewable(a.mimeType) ? FileText : FileIcon);
  return (
    <button
      type="button"
      onClick={onClick}
      title={isPreviewable(a.mimeType) ? 'Previsualizar' : 'Descargar'}
      className="inline-flex items-center gap-1.5 rounded border border-ink-200 bg-ink-50 px-2 py-1 text-[0.7rem] text-ink-700 hover:bg-ink-100 transition max-w-[14rem]"
    >
      <Icon size={12} className="shrink-0 text-ink-500" />
      <span className="truncate">{a.filename || 'archivo'}</span>
    </button>
  );
}

/**
 * The attachment lightbox. Fetches the bytes on demand (lib/gmail
 * loadGmailAttachment → an object URL), previews images and PDFs inline, and
 * offers a download for everything. The object URL is revoked on close so the
 * blob is freed.
 */
function AttachmentModal({ messageId, attachment, onClose }) {
  const [state, setState] = useState({ loading: true, error: '', url: '' });
  const a = attachment || {};
  const mime = String(a.mimeType || '').toLowerCase();
  const isImg = mime.startsWith('image/');
  const isPdf = mime === 'application/pdf';

  useEffect(() => {
    let url = '';
    let alive = true;
    setState({ loading: true, error: '', url: '' });
    loadGmailAttachment(messageId, a)
      .then((res) => {
        url = res.url;
        if (alive) setState({ loading: false, error: '', url });
        else URL.revokeObjectURL(url);
      })
      .catch((e) => {
        if (alive) setState({ loading: false, error: e?.message || 'No se pudo abrir el archivo.', url: '' });
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId, a.attachmentId]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex w-full max-w-4xl max-h-[90vh] flex-col overflow-hidden rounded-xl bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-3">
          <span className="flex items-center gap-2 truncate text-sm font-medium text-ink-800">
            <Paperclip size={14} className="shrink-0 text-ink-400" />
            <span className="truncate">{a.filename || 'archivo'}</span>
          </span>
          <div className="flex items-center gap-2">
            {state.url && (
              <a
                href={state.url}
                download={a.filename || 'archivo'}
                className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
              >
                <Download size={13} /> Descargar
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center rounded-lg border border-ink-200 bg-surface p-1.5 text-ink-600 hover:bg-ink-50"
              aria-label="Cerrar"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-ink-50/40 p-4">
          {state.loading ? (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-ink-400">
              <Loader2 size={16} className="animate-spin" /> Cargando adjunto…
            </div>
          ) : state.error ? (
            <div className="py-20 text-center text-sm text-red-600">{state.error}</div>
          ) : isImg ? (
            <img src={state.url} alt={a.filename || 'adjunto'} className="mx-auto max-h-[72vh] max-w-full rounded object-contain" />
          ) : isPdf ? (
            <iframe title={a.filename || 'PDF'} src={state.url} className="h-[72vh] w-full rounded bg-white" />
          ) : (
            <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-ink-500">
              <FileIcon size={40} className="text-ink-300" />
              <p>Este tipo de archivo no se puede previsualizar.</p>
              <a
                href={state.url}
                download={a.filename || 'archivo'}
                className="inline-flex items-center gap-1.5 rounded-lg bg-ink-900 px-3 py-2 text-xs font-medium text-white hover:bg-ink-700"
              >
                <Download size={14} /> Descargar archivo
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InvoiceList({ invoices, onPreview }) {
  if (!invoices.length) {
    return (
      <div className="rounded-xl border border-ink-100 bg-surface">
        <EmptyState icon={FileText} title="Sin facturas" description="No se detectaron correos con facturas. Sincroniza para traer correo reciente." />
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-ink-100 bg-surface overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
            <th className="px-4 py-2.5 font-medium">Remitente</th>
            <th className="px-4 py-2.5 font-medium">Asunto</th>
            <th className="px-4 py-2.5 font-medium">Marca</th>
            <th className="px-4 py-2.5 font-medium text-right">Monto</th>
            <th className="px-4 py-2.5 font-medium">Fecha</th>
            <th className="px-4 py-2.5 font-medium text-right">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {invoices.map((m) => {
            const amount = m.amount || parseInvoiceAmount(m);
            const dateMs = m.receivedAt || m.createdAt;
            const fecha = dateMs ? new Date(dateMs).toISOString().slice(0, 10) : '';
            const link = expenseDeepLink({
              proveedor: m.fromName || m.fromEmail || '',
              monto: amount?.amount || '',
              fecha,
              concepto: m.subject || '',
            });
            return (
              <tr key={m.id} className="hover:bg-ink-50/60">
                <td className="px-4 py-2.5 text-ink-700 truncate max-w-[12rem]">{m.fromName || m.fromEmail}</td>
                <td className="px-4 py-2.5 text-ink-700 truncate max-w-[16rem]">
                  <span className="inline-flex items-center gap-1.5">
                    {(m.attachments || []).length > 0 ? (
                      <button
                        type="button"
                        onClick={() => onPreview?.(m.id, m.attachments[0])}
                        title="Previsualizar adjunto"
                        className="text-ink-400 hover:text-ink-700"
                      >
                        <Paperclip size={12} />
                      </button>
                    ) : (m.hasAttachment && <Paperclip size={12} className="text-ink-400" />)}
                    {m.subject || '(sin asunto)'}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-ink-500">{brandLabel(m.brand)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-ink-800">{fmtMoney(amount)}</td>
                <td className="px-4 py-2.5 text-ink-500">{fmtDate(dateMs)}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-2">
                    <Link to={link} className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50">
                      Crear gasto
                    </Link>
                    <a href={gmailWebUrl(m)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-xs text-ink-600 hover:bg-ink-50" title="Abrir en Gmail">
                      <ExternalLink size={13} />
                    </a>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
