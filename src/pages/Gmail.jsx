import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Loader2, Search, RefreshCw, Paperclip, ExternalLink, FileText, Inbox, Plug,
  X, Download, Image as ImageIcon, File as FileIcon, ArrowLeft, ChevronLeft, ChevronRight,
  Reply, Send, PenLine,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { useApp } from '../context/AppContext.jsx';
import { db, invalidate } from '../db/database.js';
import { useLiveQueryStatus } from '../db/hooks.ts';
import {
  GMAIL_BRAND_TABS, GMAIL_BRAND_OTHER,
  resolveGmailThreads, resolveGmailThread, resolveGmailInvoices, parseInvoiceAmount,
  resolveReplyDraft,
} from '../core/crm/index.js';
import {
  syncGmail, markGmailThreadRead, setGmailThreadBrand, gmailWebUrl, expenseDeepLink,
  loadGmailAttachment, isPreviewable, sendGmailReply,
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
  // The attachment lightbox: { messageId, attachments, index } | null. We carry
  // the whole message's attachment list (+ the opened index) so the lightbox can
  // page prev/next without closing — quick attachment navigation on a phone.
  const [preview, setPreview] = useState(null);
  const openPreview = useCallback(
    (messageId, attachments, index = 0) => setPreview({ messageId, attachments, index }),
    [],
  );

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

  const threadOpen = !!selectedThreadId && tab !== INVOICES_TAB;

  return (
    // Viewport-locked column (mirrors the WhatsApp inbox): a flex column the
    // exact height of the area under the topbar, so the PAGE never shell-scrolls
    // — only the thread list / reading pane scroll, inside their panes. This is
    // what makes the phone experience no-scroll: tap a brand tab, scan the list,
    // open a mail and read it, all without the page itself moving. Negative
    // margins cancel the shared content-wrapper padding for an edge-to-edge pane;
    // desktop fills the content area the same way (100dvh − the md py-6 gutter).
    <div className="flex flex-col kb-inbox-pane max-md:h-[calc(var(--rs-vvh,100dvh)-55px-env(safe-area-inset-top)-env(safe-area-inset-bottom))] max-md:-mt-4 max-md:-mb-[calc(1.5rem+env(safe-area-inset-bottom))] md:h-[calc(100dvh-3rem)]">
      {/* List-level chrome — header, tabs, search. On a phone an OPEN mail takes
          the screen over (ReadingPane carries its own Back), so this steps aside;
          desktop keeps it always-on above the split pane. */}
      <div className={threadOpen ? 'hidden md:block' : undefined}>
        <PageHeader
          title="Gmail"
          subtitle={settings?.googleEmail ? `Bandeja de ${settings.googleEmail}` : 'Bandeja de entrada por marca'}
          actions={actions}
        />

        {syncError && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{syncError}</div>
        )}

        {/* Tabs: brands + Facturas. Horizontally scrollable on a narrow phone so
            the row never wraps and steals a second line of vertical space. */}
        <div className="mb-4 flex items-center gap-1 border-b border-ink-100 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
        <div className="mb-4 relative md:max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            type="search"
            value={needle}
            onChange={(e) => setNeedle(e.target.value)}
            placeholder="Buscar correo…"
            className="w-full rounded-lg border border-ink-200 bg-surface pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-300"
          />
        </div>
      </div>

      {!loaded ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-ink-400">
          <Loader2 size={16} className="animate-spin" /> Cargando…
        </div>
      ) : tab === INVOICES_TAB ? (
        // The Facturas table fills the rest and scrolls inside its own box
        // (edge-to-edge on a phone) so the page shell stays put.
        <div className="flex-1 min-h-0 overflow-auto max-md:-mx-4">
          <InvoiceList invoices={invoices} onPreview={openPreview} />
        </div>
      ) : (
        // Master-detail card: list + reading pane side by side on desktop; on a
        // phone it's one-at-a-time (list full width, then the open mail full
        // screen). flex-1/min-h-0 lets the inner panes own the scroll.
        <div className="flex-1 min-h-0 flex overflow-hidden border-ink-100 bg-surface md:rounded-xl md:border max-md:-mx-4">
          <div className={`${threadOpen ? 'hidden md:flex' : 'flex'} w-full md:w-[22rem] shrink-0 flex-col md:border-r border-ink-100`}>
            <ThreadList threads={tabThreads} selectedId={selectedThreadId} onOpen={openThread} brandTab={tab} />
          </div>
          <div className={`${threadOpen ? 'flex' : 'hidden md:flex'} flex-1 min-w-0 flex-col`}>
            <ReadingPane
              thread={selectedThread}
              onReassign={reassignBrand}
              onPreview={openPreview}
              onBack={() => setSelectedThreadId(null)}
              selfEmail={settings?.googleEmail || ''}
              signatureEs={settings?.gmailSignature || ''}
              signatureEn={settings?.gmailSignatureEn || ''}
              fromName={settings?.companyName || ''}
            />
          </div>
        </div>
      )}

      {preview && (
        <AttachmentModal
          messageId={preview.messageId}
          attachments={preview.attachments}
          index={preview.index}
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
      className={`relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-3 py-2 text-sm font-medium border-b-2 -mb-px transition ${
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
      <div className="flex-1 overflow-y-auto">
        <EmptyState icon={Inbox} title="Sin correos" description={`No hay correos en ${brandLabel(brandTab)}.`} />
      </div>
    );
  }
  return (
    <ul className="flex-1 divide-y divide-ink-100 overflow-y-auto overscroll-contain">
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

function ReadingPane({ thread, onReassign, onPreview, onBack, selfEmail, signatureEs, signatureEn, fromName }) {
  if (!thread) {
    return (
      <div className="hidden md:flex flex-1 items-center justify-center text-sm text-ink-400">
        Selecciona un correo para leerlo.
      </div>
    );
  }
  const last = thread.items[thread.items.length - 1] || null;
  return (
    <div className="flex flex-1 min-h-0 flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-ink-100 px-3 py-2.5 md:px-4 md:py-3">
        {/* Back to the list — phone only; desktop keeps the split pane. */}
        <button
          type="button"
          onClick={onBack}
          className="md:hidden -ml-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-600 hover:bg-ink-50"
          aria-label="Volver a la lista"
        >
          <ArrowLeft size={18} />
        </button>
        <h2 className="min-w-0 flex-1 font-display text-base font-semibold text-ink-900 truncate">{thread.subject}</h2>
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
      <ReplyComposer
        key={thread.threadId}
        thread={thread}
        selfEmail={selfEmail}
        signatureEs={signatureEs}
        signatureEn={signatureEn}
        fromName={fromName}
      />
    </div>
  );
}

/**
 * The Gmail-style reply bar pinned to the bottom of the reading pane. Collapsed
 * it's a single "Responder" pill; expanded it's a compact composer (To / Asunto
 * / body) with a send action bar. The body is seeded from the dealer's saved
 * signature; when both a Spanish and an English signature exist a selector lets
 * them switch the appended block per reply. The reply threads into the
 * conversation server-side (gmailReply). Keyed by threadId in the parent so it
 * resets when you switch mails.
 */
function ReplyComposer({ thread, selfEmail, signatureEs, signatureEn, fromName }) {
  const draft = useMemo(() => resolveReplyDraft(thread, { selfEmail }), [thread, selfEmail]);
  // The configured signatures, in selector order; 'none' is always available.
  const sigOptions = useMemo(() => {
    const opts = [];
    if (signatureEs?.trim()) opts.push({ lang: 'es', label: 'Español', text: signatureEs });
    if (signatureEn?.trim()) opts.push({ lang: 'en', label: 'English', text: signatureEn });
    opts.push({ lang: 'none', label: 'Sin firma', text: '' });
    return opts;
  }, [signatureEs, signatureEn]);
  const sigBlockFor = (lang) => {
    const t = sigOptions.find((o) => o.lang === lang)?.text || '';
    return t ? `\n\n--\n${t}` : '';
  };

  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sigLang, setSigLang] = useState(sigOptions[0].lang);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const bodyRef = useRef(null);
  // The signature block currently appended to the body, so switching languages
  // (or editing the body) can strip the old one before adding the new.
  const appliedBlock = useRef('');

  const startReply = () => {
    const lang = sigOptions[0].lang;
    const block = sigBlockFor(lang);
    appliedBlock.current = block;
    setTo(draft?.to || '');
    setSubject(draft?.subject || '');
    setSigLang(lang);
    setBody(block);
    setError('');
    setSent(false);
    setOpen(true);
    // Land the cursor at the very top, above the signature, ready to type.
    requestAnimationFrame(() => {
      const el = bodyRef.current;
      if (el) { el.focus(); try { el.setSelectionRange(0, 0); } catch { /* noop */ } }
    });
  };

  // Swap the appended signature for the chosen language's, preserving whatever
  // the dealer typed above it.
  const chooseSignature = (lang) => {
    setBody((b) => {
      const prev = appliedBlock.current;
      const base = prev && b.endsWith(prev) ? b.slice(0, b.length - prev.length) : b;
      const block = sigBlockFor(lang);
      appliedBlock.current = block;
      return base + block;
    });
    setSigLang(lang);
    bodyRef.current?.focus();
  };

  const send = async () => {
    if (!to.trim()) { setError('Falta el destinatario.'); return; }
    setSending(true);
    setError('');
    try {
      await sendGmailReply({
        to: to.trim(),
        subject: subject.trim(),
        text: body,
        fromName,
        messageId: draft?.inReplyToId,
        threadId: draft?.threadId,
      });
      setSent(true);
      setOpen(false);
    } catch (e) {
      setError(e?.message || 'No se pudo enviar la respuesta.');
    } finally {
      setSending(false);
    }
  };

  if (!open) {
    return (
      <div className="shrink-0 border-t border-ink-100 px-3 py-2.5 md:px-4 flex items-center gap-3">
        <button
          type="button"
          onClick={startReply}
          className="inline-flex items-center gap-2 rounded-full border border-ink-200 bg-surface px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
        >
          <Reply size={15} /> Responder
        </button>
        {sent && <span className="text-xs font-medium text-emerald-600">Respuesta enviada ✓</span>}
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-ink-100 bg-surface px-3 py-3 md:px-4 space-y-2">
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-xs font-medium text-ink-400">Para</span>
        <input
          type="email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="destinatario@correo.com"
          className="min-w-0 flex-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ink-300"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-xs font-medium text-ink-400">Asunto</span>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ink-300"
        />
      </div>
      <textarea
        ref={bodyRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={5}
        placeholder="Escribe tu respuesta…"
        className="w-full resize-none rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-ink-300"
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      {/* Gmail-style action bar: primary Send + signature insert + cancel. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={sending}
          className="inline-flex items-center gap-2 rounded-full bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-50"
        >
          {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          Enviar
        </button>
        {/* Signature picker — only when there's more than one option besides
            "Sin firma" (one signature needs no chooser, it's already seeded). */}
        {sigOptions.length > 2 && (
          <label className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface pl-2.5 pr-1.5 py-1.5 text-xs font-medium text-ink-600">
            <PenLine size={14} className="shrink-0 text-ink-400" />
            <select
              value={sigLang}
              onChange={(e) => chooseSignature(e.target.value)}
              className="bg-transparent text-xs text-ink-700 focus:outline-none"
              aria-label="Firma"
            >
              {sigOptions.map((o) => (
                <option key={o.lang} value={o.lang}>{o.label}</option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="ml-auto inline-flex items-center justify-center rounded-lg border border-ink-200 bg-surface p-2 text-ink-500 hover:bg-ink-50"
          aria-label="Descartar"
        >
          <X size={16} />
        </button>
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
              onClick={() => onPreview?.(message.id, message.attachments, i)}
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
 *
 * It receives the WHOLE message's attachment list plus the opened index, so the
 * dealer can page through every attachment (◂ ▸ / arrow keys) without closing —
 * the quick attachment navigation the phone experience is built around. On a
 * phone it goes full-screen (edge-to-edge) so a PDF/photo gets the whole window.
 */
function AttachmentModal({ messageId, attachments, index, onClose }) {
  const list = Array.isArray(attachments) ? attachments : [];
  const [i, setI] = useState(() => Math.min(Math.max(index || 0, 0), Math.max(list.length - 1, 0)));
  const [state, setState] = useState({ loading: true, error: '', url: '' });
  const a = list[i] || {};
  const mime = String(a.mimeType || '').toLowerCase();
  const isImg = mime.startsWith('image/');
  const isPdf = mime === 'application/pdf';
  const count = list.length;
  const go = useCallback((step) => setI((cur) => Math.min(Math.max(cur + step, 0), count - 1)), [count]);

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
  }, [messageId, a.attachmentId, i]);

  // Escape closes; ←/→ page between this message's attachments.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, go]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-0 md:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex h-full w-full max-w-4xl flex-col overflow-hidden bg-surface shadow-2xl md:h-auto md:max-h-[90vh] md:rounded-xl pt-[env(safe-area-inset-top)] md:pt-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-3">
          <span className="flex min-w-0 items-center gap-2 truncate text-sm font-medium text-ink-800">
            <Paperclip size={14} className="shrink-0 text-ink-400" />
            <span className="truncate">{a.filename || 'archivo'}</span>
            {count > 1 && <span className="shrink-0 text-xs font-normal text-ink-400 tabular-nums">{i + 1}/{count}</span>}
          </span>
          <div className="flex items-center gap-2">
            {count > 1 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => go(-1)}
                  disabled={i === 0}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-ink-200 bg-surface text-ink-600 hover:bg-ink-50 disabled:opacity-40"
                  aria-label="Adjunto anterior"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => go(1)}
                  disabled={i >= count - 1}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-ink-200 bg-surface text-ink-600 hover:bg-ink-50 disabled:opacity-40"
                  aria-label="Adjunto siguiente"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
            {state.url && (
              <a
                href={state.url}
                download={a.filename || 'archivo'}
                className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
              >
                <Download size={13} /> <span className="hidden sm:inline">Descargar</span>
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
        <div className="flex-1 min-h-0 overflow-auto bg-ink-50/40 p-2 md:p-4">
          {state.loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-ink-400">
              <Loader2 size={16} className="animate-spin" /> Cargando adjunto…
            </div>
          ) : state.error ? (
            <div className="py-20 text-center text-sm text-red-600">{state.error}</div>
          ) : isImg ? (
            <img src={state.url} alt={a.filename || 'adjunto'} className="mx-auto max-h-full max-w-full rounded object-contain" />
          ) : isPdf ? (
            <iframe title={a.filename || 'PDF'} src={state.url} className="h-full min-h-[60vh] w-full rounded bg-white" />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center text-sm text-ink-500">
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
                        onClick={() => onPreview?.(m.id, m.attachments, 0)}
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
